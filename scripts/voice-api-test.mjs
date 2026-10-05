import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { RalphRegistry, SupportCommandBus, supportCommandClaimHandler } from "../dist/chatgpt-support.js";
import { createVoiceApi } from "../dist/voice-api.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "voice-api-"));
const registry = await RalphRegistry.open(directory);
const commands = new SupportCommandBus(undefined, undefined, undefined, undefined, registry);
const app = express();
app.use(express.json());
app.use("/chatgpt-support/voice", createVoiceApi({ token: "test-token", registry, commands }));
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
const complete = (command, status, conversationUrl = command.targetUrl) => commands.complete({
	commandId: command.id, browserId: "voice-browser", kind: command.kind, ok: true, result: { status, conversationUrl },
});
try {
	assert.equal((await request("GET", "", undefined, { authorization: "Bearer wrong" })).status, 401);
	assert.equal((await request("POST", "/start", {}, { origin: "https://chatgpt.com" })).status, 401);
	assert.equal((await request("POST", "/mute", {})).status, 400);
	assert.equal((await request("POST", "/start", { targetUrl: other })).status, 400);
	assert.equal((await request("POST", "/start", {})).status, 409);
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
	await assert.rejects(commands.execute({ feature: "threadLifecycle", kind: "close_thread", conversationUrl: url }), /protected/);
	await registry.pauseAutomation();
	const start = request("POST", "/start", {});
	const startCommand = await claim();
	assert.equal(startCommand.kind, "voice_start", "Voice can start while worker automation is paused");
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
	const unavailable = request("POST", "/stop", {});
	complete(await claim(), "unavailable");
	assert.equal((await unavailable).status, 503, "unavailable controls cannot confirm a successful stop");
	const status = request("POST", "/status", {});
	complete(await claim(), "active", other);
	assert.equal((await status).status, 503, "a page response from the wrong chat cannot confirm the call state");
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
	console.log("Voice API passed: authentication, persisted protection, duplicate wakes, pause bypass, failed start, stop, and active-call rebinding rejection.");
} finally {
	commands.close();
	await new Promise(resolve => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
