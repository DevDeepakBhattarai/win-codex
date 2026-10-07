import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = "https://chatgpt.com/";
const first = root + "c/11111111-1111-4111-8111-111111111111";
const second = root + "c/22222222-2222-4222-8222-222222222222";
const script = await readFile("support-extension/service-worker.js", "utf8");
async function run({ tabs = [], storage = {}, kind = "voice_start", responses = [] }) {
	const calls = [];
	const created = [];
	const reloaded = [];
	const results = [];
	const context = vm.createContext({
		URL, AbortController, AbortSignal, Response, Error, console, crypto: globalThis.crypto,
		setTimeout, clearTimeout, importScripts() {},
		LOCAL_CODEX_THREAD_SYNC: {
			bindUrl: "http://127.0.0.1/thread-sync/bind", commandClaimUrl: "http://127.0.0.1/chatgpt-support/commands/claim", commandResultUrl: "http://127.0.0.1/chatgpt-support/commands/result",
			threadObserveUrl: "http://127.0.0.1/chatgpt-support/threads/observe", ralphRegisterUrl: "http://127.0.0.1/chatgpt-support/ralph/register", extensionToken: "x".repeat(32),
		},
		browser: {
			runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
			storage: { local: { async get() { return { threadSync: false, ...storage }; }, async set(value) { Object.assign(storage, value); } } },
			tabs: {
				onUpdated: { addListener() {} },
				async query(query) { return query.windowType ? [{ windowId: 1 }] : tabs; },
				async get(id) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error("Tab closed"); return tab; },
				async create(options) { const tab = { id: 99, status: "complete", ...options }; tabs.push(tab); created.push(tab); return tab; },
				async update() {}, async reload(id) { reloaded.push(id); },
				async sendMessage(id, { command }) {
					calls.push({ id, kind: command.kind, targetUrl: command.targetUrl });
					if (command.kind === "voice_status") return { ok: true, result: { status: tabs.find(tab => tab.id === id).voice ?? "closed", conversationUrl: command.targetUrl } };
					return responses.shift() ?? { ok: true, result: { status: "active", conversationUrl: command.targetUrl, microphone: "unmuted" } };
				},
			},
			scripting: { async executeScript() {} },
			webNavigation: { onHistoryStateUpdated: { addListener() {} }, onCommitted: { addListener() {} } },
		},
		async fetch(endpoint, options) {
			if (endpoint.endsWith("/result")) results.push(JSON.parse(options.body));
			return new Response(null, { status: 204 });
		},
	});
	vm.runInContext(script, context);
	await new Promise(resolve => setImmediate(resolve));
	vm.runInContext("pollGeneration++; pollController?.abort(); voicePollController?.abort();", context);
	await context.executeVoiceCommand({ id: "voice", feature: "voice", kind, targetUrl: root, discover: true }, "chrome");
	return { calls, created, reloaded, results, storage };
}
const tab = (id, url, voice = "closed") => ({ id, url, voice, status: "complete" });
{
	const result = await run({ tabs: [tab(1, first), tab(2, second, "active")], storage: { voiceConversationUrl: first } });
	assert.equal(result.calls.at(-1).id, 2, "an active call wins over an old configured conversation");
	assert.equal(result.created.length, 0);
	assert.equal(result.storage.voiceTabId, 2);
}
{
	const result = await run({ tabs: [tab(2, second)], storage: { voiceConversationUrl: first } });
	assert.equal(result.created.length, 1, "closing the Voice tab causes a fresh chat on the next wake");
	assert.equal(result.created[0].url, root, "an old configured URL is never reopened");
}
{
	const result = await run({ tabs: [tab(1, first)], storage: { voiceTabId: 1, voiceTabUrl: first } });
	assert.equal(result.created.length, 0, "a disconnected but still-open Voice tab is reused");
	assert.equal(result.calls.at(-1).id, 1);
}
{
	const result = await run({ tabs: [tab(1, first, "loading")], storage: { voiceTabId: 1, voiceTabUrl: first }, responses: [
		{ ok: false, error: "VOICE_LOADING_STUCK: stuck" },
		{ ok: true, result: { status: "active", conversationUrl: first, microphone: "unmuted" } },
	] });
	assert.deepEqual(result.reloaded, [1], "a stuck Voice button gets one reload before retrying");
	assert.equal(result.results[0].ok, true);
}
{
	const result = await run({ tabs: [tab(1, first)], storage: { voiceTabId: 1, voiceTabUrl: first }, responses: [
		{ ok: false, error: "Microphone permission denied" },
	] });
	assert.equal(result.reloaded.length, 0, "permission errors do not reload a conversation");
	assert.equal(result.results[0].ok, false);
}
{
	const result = await run({ tabs: [tab(1, first, "active"), tab(2, second, "active")] });
	assert.equal(result.created.length, 0);
	assert.equal(result.results[0].ok, false, "ambiguous active calls cannot be selected by accident");
}
{
	const result = await run({ kind: "voice_stop", storage: { voiceConversationUrl: first } });
	assert.equal(result.created.length, 0, "ending a closed tab never recreates it");
	assert.equal(result.results[0].result.status, "closed");
}
console.log("Voice worker passed: active and tracked tab reuse, fresh chat, loading recovery, permission rejection, ambiguous calls, and closed-tab stop.");
