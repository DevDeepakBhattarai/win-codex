import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { RalphRegistry, SupportCommandBus, ralphRegistrationHandler } from "../dist/chatgpt-support.js";
import { requireRunningChrome } from "../dist/browser-launch.js";
import { createBrowserService } from "../dist/browser.js";

const url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const threadId = url.split("/c/")[1];
const directory = await mkdtemp(path.join(os.tmpdir(), "ralph-lifecycle-"));
const commands = new SupportCommandBus(undefined, undefined, undefined, requireRunningChrome);
try {
  const browser = await createBrowserService({ dataDirectory: directory, port: 0 });
  try {
    await assert.rejects(browser.listTabs(), /Chrome must already be running/);
    assert.equal(browser.status().connected, false);
  } finally {
    await browser.close();
  }
  await assert.rejects(commands.ensureBackgroundBrowserOnce("ralph"), /Chrome must already be running/);
  await commands.claim("existing", ["ralph"], 0, undefined, [url]);
  await commands.ensureBackgroundBrowserOnce("ralph");
  const registry = await RalphRegistry.open(directory);
  await registry.register(url, { manual: true });
  const handler = ralphRegistrationHandler(registry, "x".repeat(32), commands);
  const pending = commands.execute({ feature: "ralph", kind: "inspect_thread", conversationUrl: url });
  const cancelled = assert.rejects(pending, /tab was closed/);
  await new Promise(resolve => setImmediate(resolve));
  const response = {
    statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; },
  };
  await handler({ body: { conversationUrl: url, removed: true },
    get: key => ({ authorization: `Bearer ${"x".repeat(32)}`, origin: `chrome-extension://${"a".repeat(32)}` })[key],
  }, response, error => { throw error; });
  await cancelled;
  assert.equal(response.body.status, "removed");
  assert.deepEqual(await registry.threads(), []);
  assert.deepEqual(await (await RalphRegistry.open(directory)).threads(), [], "removal survives a server restart");
  assert.equal(await commands.claim("existing", ["ralph"], 0, undefined, [url]), undefined);
} finally {
  commands.close();
  await rm(directory, { recursive: true, force: true });
}

const source = await readFile("support-extension/service-worker.js", "utf8");
const config = { extensionToken: "x".repeat(32) };
for (const [key, route] of Object.entries({ bindUrl: "/thread-sync/bind", commandClaimUrl: "/chatgpt-support/commands/claim",
  commandResultUrl: "/chatgpt-support/commands/result", threadObserveUrl: "/chatgpt-support/threads/observe",
  ralphRegisterUrl: "/chatgpt-support/ralph/register" })) config[key] = `http://127.0.0.1:6002${route}`;
const storage = {};
const tabs = new Map([[7, { id: 7, windowId: 3, url, status: "complete" }]]);
const results = [];
const removals = [];
const creations = [];
let offline = false;
let pageFailure = false;
let dispatches = 0;
let releaseInspection;
const context = {
  URL, AbortSignal, AbortController, crypto: globalThis.crypto, Response, console, setTimeout, clearTimeout,
  importScripts() {}, LOCAL_CODEX_THREAD_SYNC: config,
  browser: {
    runtime: { id: "a".repeat(32), onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: {
      async get(query) { return typeof query === "string" ? { [query]: storage[query] } : { ...query, threadSync: false, ...storage }; },
      async set(values) { Object.assign(storage, values); },
      async remove(keys) { for (const key of [keys].flat()) delete storage[key]; },
    } },
    scripting: { async executeScript() {} },
    tabs: {
      async query() { return [...tabs.values()]; },
      async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return tabs.get(id); },
      async create(properties) { creations.push(properties); return { id: 8, ...properties }; },
      async reload() { assert.fail("inspection must not reload"); },
      async remove() { assert.fail("inspection must not close tabs"); },
      async sendMessage(id, { command }) {
        assert.equal(id, 7);
        if (command.kind === "page_health") return { ok: true, result: { status: "ok" } };
        dispatches++;
        if (pageFailure) throw new Error("Timed out waiting for ChatGPT page automation.");
        if (releaseInspection) await new Promise(resolve => { releaseInspection = resolve; });
        return { ok: true, result: { status: "running" } };
      },
    },
  },
  async fetch(endpoint, options) {
    if (endpoint === config.commandResultUrl) results.push(JSON.parse(options.body));
    if (endpoint === config.ralphRegisterUrl) {
      if (offline) throw new Error("offline");
      removals.push(JSON.parse(options.body));
    }
    return new Response(null, { status: 204 });
  },
};
vm.runInNewContext(source, context);
await new Promise(resolve => setImmediate(resolve));
context.getSettings = async () => ({ threadSync: false, automationExecutor: true });
const inspect = id => context.executeCommand({ id, feature: "ralph", kind: "inspect_thread", conversationUrl: url }, "existing");
pageFailure = true;
await inspect("timeout");
assert.equal(results.at(-1).result.status, "loading");
pageFailure = false;
await inspect("recovered");
assert.equal(results.at(-1).result.status, "running");
assert.equal(creations.length, 0);
releaseInspection = true;
const first = inspect("same-command");
const duplicate = inspect("same-command");
await new Promise(resolve => setImmediate(resolve));
releaseInspection();
await Promise.all([first, duplicate]);
assert.equal(dispatches, 3, "a resumed command shares the existing inspection");
tabs.delete(7);
offline = true;
await assert.rejects(context.threadTabRemoved(7), /offline/);
assert.equal(storage["closedRalphTab:7"], url, "closure is retained while the server is offline");
offline = false;
await context.reportClosedThreadTabs();
assert.deepEqual(removals, [{ conversationUrl: url, removed: true }]);
assert.equal(storage["closedRalphTab:7"], undefined);
await inspect("after-close");
assert.equal(creations.length, 0, "a stale RALPH check cannot reopen the closed tab");
await context.executeCommand({ id: "stale-prepare", feature: "threadPreparation", kind: "prepare_thread", conversationUrl: url }, "existing");
assert.equal(results.at(-1).ok, false);
assert.equal(creations.length, 0, "a queued preparation cannot reopen the closed tab");
await assert.rejects(context.acquireAutomationTab(url, false), /Open a Chrome window/);
tabs.set(9, { id: 9, windowId: 3, url: "https://example.com" });
await context.acquireAutomationTab(url, false);
assert.equal(creations[0].windowId, 3, "new tabs target an existing window explicitly");
console.log("RALPH lifecycle tests passed.");
