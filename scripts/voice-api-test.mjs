import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { RalphRegistry, SupportCommandBus, supportCommandClaimHandler } from "../dist/chatgpt-support.js";
import { createVoiceApi, registerVoiceTool } from "../dist/voice-api.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "voice-api-"));
const registry = await RalphRegistry.open(directory);
const commands = new SupportCommandBus(undefined, undefined, undefined, undefined, registry);
const app = express();
app.use(express.json());
const observations = [];
let observationError;
const voice = createVoiceApi({ token: "test-token", registry, commands, observeAudio: async (tabId, conversationUrl) => {
	if (observationError) throw new Error(observationError);
	observations.push({ tabId, conversationUrl });
} });
app.use("/chatgpt-support/voice", voice.router);
const mcp = new McpServer({ name: "voice-test", version: "1" });
registerVoiceTool(mcp, voice);
const client = new Client({ name: "voice-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await mcp.connect(serverTransport);
await client.connect(clientTransport);
const callTool = action => client.callTool({ name: "chatgpt_voice", arguments: { action } });
app.post("/chatgpt-support/commands/claim", supportCommandClaimHandler(commands, "test-token"));
const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}/chatgpt-support/voice`;
const url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const other = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
const request = (method, suffix = "", body, extra = {}) => fetch(base + suffix, {
	method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
});
const claim = () => commands.claim("voice-browser", ["voice"], 1000);
const complete = (command, status, conversationUrl = command.discover ? registry.voiceConversationUrl() ?? command.targetUrl : command.targetUrl) => commands.complete({
	commandId: command.id, browserId: "voice-browser", kind: command.kind, ok: true,
	result: { status, conversationUrl, ...(command.kind === "voice_start" ? { microphone: "unmuted", tabId: 1 } : {}) },
});
try {
	const freshStart = request("POST", "/start", {});
	const freshCommand = await claim();
	assert.ok(freshCommand, "A wake without a saved URL must ask Chrome to select or create a Voice chat");
	assert.equal(freshCommand.targetUrl, "https://chatgpt.com/");
	complete(freshCommand, "active");
	assert.equal((await freshStart).status, 200);
	assert.deepEqual(observations, [{ tabId: 1, conversationUrl: "https://chatgpt.com/" }], "A wake monitors the tab Chrome actually selected");
	observationError = "Browser Bridge is disconnected";
	const unobservedStart = request("POST", "/start", {});
	complete(await claim(), "active");
	const unobservedResponse = await unobservedStart;
	assert.equal(unobservedResponse.status, 503, "A wake cannot claim audio monitoring succeeded without peer discovery");
	assert.match((await unobservedResponse.json()).error, /Browser Bridge is disconnected/);
	observationError = undefined;
	for (const action of ["toggle_mute"]) {
		assert.equal((await request("POST", "/" + action, {})).status, 400, "Removed microphone actions are rejected");
		const rejected = await callTool(action);
		assert.equal(rejected.isError, true, "The agent tool rejects microphone actions");
	}
	assert.equal((await request("GET", "", undefined, { authorization: "Bearer wrong" })).status, 401);
	assert.equal((await request("POST", "/start", {}, { origin: "https://chatgpt.com" })).status, 401);
	assert.equal((await request("POST", "/pause", {})).status, 400);
	assert.equal((await request("POST", "/start", { targetUrl: other })).status, 400);
	assert.equal((await request("PUT", "", { conversationUrl: url + "?temporary-chat=true" })).status, 400);
	assert.equal((await request("PUT", "", { conversationUrl: url.replace("/c/", "/g/g-p-" + "a".repeat(32) + "/c/") })).status, 400);
	await registry.register(other, { agentCreated: true, parentThreadId: "api:test" });
	assert.equal((await request("PUT", "", { conversationUrl: other })).status, 400);
	await registry.register(url, { manual: true });
	const initial = request("PUT", "", { conversationUrl: url });
	const initialCommand = await claim();
	assert.ok(initialCommand, "configuration requires an extension acknowledgment before succeeding");
	assert.equal(initialCommand.kind, "voice_status");
	assert.equal(initialCommand.targetUrl, url);
	assert.equal(registry.voiceConversationUrl(), undefined, "the server does not commit a new target before its browser probe completes");
	complete(initialCommand, "closed");
	assert.equal((await initial).status, 200);
	const observerStatus = await fetch(base.replace("/voice", "/commands/claim"), {
		method: "POST", headers, body: JSON.stringify({ browserId: "helium", features: [], statusOnly: true }),
	});
	assert.equal(observerStatus.status, 204);
	assert.equal(observerStatus.headers.get("X-Voice-Conversation-Url"), url, "Observer browsers receive the committed Voice binding through their ordinary support transport");
	const newChatMessage = commands.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: "https://chatgpt.com/", temporary: true, message: "Start a task" });
	void newChatMessage.catch(() => {});
	const unrelatedStatus = await fetch(base.replace("/voice", "/commands/claim"), {
		method: "POST", headers, body: JSON.stringify({ browserId: "helium", features: [], statusOnly: true, recoveryConversationUrl: other }),
	});
	assert.equal(unrelatedStatus.status, 204, "An unrelated new-chat command cannot break recovery status for an existing chat");
	assert.equal(unrelatedStatus.headers.get("X-Recovery-Message-Pending"), "false");
	const newChatCommand = await commands.claim("chrome-messages", ["threadMessaging"], 1000);
	commands.complete({ commandId: newChatCommand.id, browserId: "chrome-messages", kind: newChatCommand.kind, ok: true,
		result: { status: "sent", conversationUrl: other } });
	await newChatMessage;
	const queuedMessage = commands.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: other, message: "Continue" });
	const pendingStatus = await fetch(base.replace("/voice", "/commands/claim"), {
		method: "POST", headers, body: JSON.stringify({ browserId: "helium", features: [], statusOnly: true, recoveryConversationUrl: other }),
	});
	assert.equal(pendingStatus.status, 204);
	assert.equal(pendingStatus.headers.get("X-Recovery-Message-Pending"), "true", "Observer recovery sees a queued message without claiming it");
	assert.equal(await commands.claim("helium", [], 0, undefined, [other]), undefined);
	const chromeMessage = await commands.claim("chrome-messages", ["threadMessaging"], 1000);
	assert.equal(chromeMessage.kind, "send_message");
	commands.complete({ commandId: chromeMessage.id, browserId: "chrome-messages", kind: chromeMessage.kind, ok: true,
		result: { status: "sent", conversationUrl: other } });
	await queuedMessage;
	assert.equal((await request("GET")).headers.get("cache-control"), "no-store");
	assert.equal((await registry.threads()).some(thread => thread.conversationUrl === url), false);
	assert.equal(await registry.register(url, { manual: true, reactivate: true, activity: "running" }), "ignored");
	const reopened = await RalphRegistry.open(directory);
	assert.equal(reopened.voiceConversationUrl(), url, "the dedicated chat remains protected after restart");
	assert.equal(await reopened.register(url, { agentCreated: true }), "ignored");
	for (const [action, microphone] of [["mute", "muted"], ["unmute", "unmuted"]]) {
		const pending = request("POST", "/" + action, {});
		const command = await claim();
		assert.equal(command.kind, "voice_" + action);
		commands.complete({ commandId: command.id, browserId: "voice-browser", kind: command.kind,
			ok: true, result: { status: "active", conversationUrl: url, microphone, tabId: 1 } });
		assert.equal((await pending).status, 200, "Microphone actions leave the call connected");
	}
	const unconfirmedMute = callTool("mute");
	complete(await claim(), "active");
	assert.equal((await unconfirmedMute).isError, true, "An active call alone cannot confirm a muted microphone");
	await assert.rejects(commands.execute({ feature: "threadLifecycle", kind: "close_thread", conversationUrl: url }), /protected/);
	await registry.pauseAutomation();
	const start = request("POST", "/start", {});
	const startCommand = await claim();
	assert.equal(startCommand.kind, "voice_start", "Voice can start while worker automation is paused");
	assert.equal((await callTool("stop")).isError, true, "The MCP tool shares the local API operation lock");
	assert.equal((await request("POST", "/start", {})).status, 409, "duplicate wake requests do not start a second concurrent operation");
	commands.complete({ commandId: startCommand.id, browserId: "voice-browser", kind: startCommand.kind,
		ok: false, error: "Microphone permission denied" });
	const failed = await start;
	assert.equal(failed.status, 503);
	assert.match((await failed.json()).error, /Microphone permission denied/);
	const stop = request("POST", "/stop", {});
	const stopCommand = await claim();
	assert.equal(stopCommand.kind, "voice_stop", "end-call requests bypass the worker pause");
	complete(stopCommand, "closed");
	assert.deepEqual(await (await stop).json(), { status: "closed", conversationUrl: url });
	const agentStart = callTool("start");
	const agentStartCommand = await claim();
	assert.equal(agentStartCommand.kind, "voice_start");
	assert.equal(agentStartCommand.targetUrl, "https://chatgpt.com/");
	assert.equal((await request("PUT", "", { conversationUrl: other })).status, 409, "Agent operations protect the configured target from rebinding");
	complete(agentStartCommand, "active");
	assert.deepEqual((await agentStart).structuredContent, { status: "active", conversationUrl: url, microphone: "unmuted", tabId: 1 });
	const agentStop = callTool("stop");
	complete(await claim(), "active");
	assert.equal((await agentStop).isError, true, "An agent cannot claim it disconnected without browser confirmation");
	const agentWrongChat = callTool("status");
	complete(await claim(), "closed", "https://example.com/");
	assert.equal((await agentWrongChat).isError, true, "An agent cannot inspect an unrelated site");
	const agentDisconnect = callTool("stop");
	assert.equal((await request("POST", "/start", {})).status, 409, "The local API shares the MCP operation lock");
	complete(await claim(), "closed");
	assert.deepEqual((await agentDisconnect).structuredContent, { status: "closed", conversationUrl: url });
	const unavailable = request("POST", "/stop", {});
	complete(await claim(), "unavailable");
	assert.equal((await unavailable).status, 503, "unavailable controls cannot confirm a successful stop");
	const status = request("POST", "/status", {});
	complete(await claim(), "active", "https://example.com/");
	assert.equal((await status).status, 503, "a page response from an unrelated site cannot confirm the call state");
	const change = request("PUT", "", { conversationUrl: "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333" });
	complete(await claim(), "active");
	assert.equal((await change).status, 409, "changing chats cannot abandon an active call");
	assert.equal(registry.voiceConversationUrl(), url);
	const replacement = "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333";
	const duplicate = request("PUT", "", { conversationUrl: replacement });
	complete(await claim(), "closed");
	const duplicateProbe = await claim();
	assert.equal(duplicateProbe.targetUrl, replacement, "configuration probes its new target before committing it");
	commands.complete({ commandId: duplicateProbe.id, browserId: "voice-browser", kind: duplicateProbe.kind,
		ok: false, error: "The Voice conversation is open in multiple tabs." });
	assert.equal((await duplicate).status, 400);
	assert.equal(registry.voiceConversationUrl(), url, "duplicate tabs cannot replace the existing configuration");
	const rebound = request("PUT", "", { conversationUrl: replacement });
	complete(await claim(), "closed");
	const replacementProbe = await claim();
	assert.equal(registry.voiceConversationUrl(), url);
	complete(replacementProbe, "closed");
	assert.equal((await rebound).status, 200);
	assert.equal(registry.voiceConversationUrl(), replacement);
	await writeFile(path.join(directory, "support-extension-token"), "test-token");
	const cli = promisify(execFile)(process.execPath, ["dist/cli.js", "voice", "status"], {
		env: { ...process.env, DATA_DIR: directory, THREAD_SYNC_PORT: String(server.address().port) }, timeout: 5000,
	});
	complete(await commands.claim("voice-browser", ["voice"], 4000), "closed");
	assert.deepEqual(JSON.parse((await cli).stdout), { status: "closed", conversationUrl: replacement }, "the CLI uses the authenticated local Voice API");
	const unansweredStatus = fetch(base + "/status", {
		method: "POST", headers, body: "{}", signal: AbortSignal.timeout(8000),
	});
	assert.equal((await claim()).kind, "voice_status");
	assert.equal((await unansweredStatus).status, 503, "an unacknowledged status check must expire so it cannot hold the Voice operation lock");
	const stopAfterTimeout = request("POST", "/stop", {});
	const recoveredStop = await claim();
	assert.equal(recoveredStop.kind, "voice_stop", "End Voice remains available after a status timeout");
	complete(recoveredStop, "closed");
	assert.equal((await stopAfterTimeout).status, 200);
	console.log("Voice API and MCP tool passed: authentication, unconfigured startup, microphone actions, shared operation lock, browser confirmation, and timeout recovery.");
} finally {
	await client.close();
	await mcp.close();
	commands.close();
	await new Promise(resolve => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
