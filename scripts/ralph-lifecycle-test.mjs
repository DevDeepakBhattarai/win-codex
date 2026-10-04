import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { RalphController, RalphRegistry, SupportCommandBus, ralphRegistrationHandler } from "../dist/chatgpt-support.js";

const url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const threadId = url.split("/c/")[1];
const directory = await mkdtemp(path.join(os.tmpdir(), "ralph-lifecycle-"));
let launches = 0;
const commands = new SupportCommandBus(undefined, undefined, undefined, async () => {
  launches++;
  await commands.claim("chrome-launch", ["ralph"], 0);
});
try {
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

  await registry.register(url, { manual: true, activity: "running", reactivate: true });
  assert.equal(await registry.settle(threadId), false, "closing a running tab cannot settle its work");
  await registry.register(url, { manual: true, activity: "blocked" });
  assert.equal(await registry.settle(threadId), false, "a blocked thread still needs attention");
  await registry.register(url, { manual: true, activity: "idle" });
  assert.equal(await registry.settle(threadId), true);
  const settled = (await (await RalphRegistry.open(directory)).threads())[0];
  assert.ok(settled.settledAt, "settlement survives restart without deleting the conversation");
  assert.deepEqual(await registry.due(Date.now() + 24 * 60 * 60_000), []);
  await registry.register(url, { manual: true, activity: "running", reactivate: true });
  assert.equal((await registry.threads())[0].settledAt, undefined, "new work returns a settled thread to the active list");
  assert.deepEqual(await registry.due(Date.now() + 24 * 60 * 60_000), [], "observed manual threads never receive unsolicited continuation");

  const capacityDirectory = path.join(directory, "capacity");
  await mkdir(capacityDirectory);
  const completedAt = new Date().toISOString();
  const retained = Array.from({ length: 2000 }, (_, index) => {
    const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    return { threadId: id, conversationUrl: `https://chatgpt.com/c/${id}?temporary-chat=true`,
      parentThreadId: "api:old", agentCreated: true, state: "complete", activity: "idle",
      registeredAt: completedAt, nextCheckAt: 0, mode: "normal", settledAt: completedAt };
  });
  delete retained[0].settledAt;
  delete retained[0].parentThreadId;
  retained[1].state = "active";
  retained[1].activity = "running";
  delete retained[1].settledAt;
  await writeFile(path.join(capacityDirectory, "ralph.json"), JSON.stringify({
    version: 2, projects: [], loopIntervalMs: 1800_000, threads: retained,
  }));
  const capacityRegistry = await RalphRegistry.open(capacityDirectory);
  assert.equal(await capacityRegistry.register(url, { agentCreated: true, parentThreadId: "api:new" }), "registered",
    "settled history cannot exhaust registration capacity");
  const remaining = await capacityRegistry.threads();
  assert.equal(remaining.length, 3);
  assert.ok(remaining.some(thread => thread.threadId === retained[0].threadId), "unviewed manual completions retain their place");
  assert.ok(remaining.some(thread => thread.threadId === retained[1].threadId), "running workers retain their registration");

  const startupCommands = new SupportCommandBus(undefined, undefined, undefined, async () => {
    launches++;
    await startupCommands.claim("startup-chrome-launch", ["ralph"], 0);
  });
  const startupRegistry = await RalphRegistry.open(path.join(directory, "startup"), 1);
  await startupRegistry.register(url, { manual: true });
  const controller = new RalphController({ registry: startupRegistry, commands: startupCommands,
    model: "unused", auditLogPath: path.join(directory, "audit.log"), checkEveryMs: 60_000 });
  try {
    const beforeStartup = launches;
    await new Promise(resolve => setTimeout(resolve, 5));
    await controller.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(launches, beforeStartup + 1, "scheduled RALPH checks start Chrome when no browser is connected");
    const check = await startupCommands.claim("restarted-chrome", ["ralph"], 0, undefined, []);
    assert.equal(check?.kind, "inspect_thread");
    startupCommands.complete({ commandId: check.id, browserId: "restarted-chrome", kind: check.kind,
      ok: true, result: { status: "running" } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok((await startupRegistry.threads())[0].lastCheckedAt, "the restarted executor completes the scheduled check");
  } finally {
    controller.close();
    startupCommands.close();
  }
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
let reloads = 0;
let releaseInspection;
let holdTracking = false;
let releaseTracking;
const context = {
  URL, AbortSignal, AbortController, crypto: globalThis.crypto, Response, console, setTimeout, clearTimeout,
  importScripts() {}, LOCAL_CODEX_THREAD_SYNC: config,
  browser: {
    runtime: { id: "a".repeat(32), onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: {
      async get(query) { return typeof query === "string" ? { [query]: storage[query] } : { ...query, threadSync: false, ...storage }; },
      async set(values) {
        if (holdTracking && Object.entries(values).some(([key, value]) => key.startsWith("closedThread:") && value === false)) {
          await new Promise(resolve => { releaseTracking = resolve; });
        }
        Object.assign(storage, values);
      },
      async remove(keys) { for (const key of [keys].flat()) delete storage[key]; },
    } },
    scripting: { async executeScript() {} },
    tabs: {
      async query() { return [...tabs.values()]; },
      async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return tabs.get(id); },
      async create(properties) { creations.push(properties); const tab = { id: 8, status: "complete", ...properties }; tabs.set(tab.id, tab); return tab; },
      async reload() { reloads++; },
      async remove() { assert.fail("inspection must not close tabs"); },
      async sendMessage(id, { command }) {
        assert.ok(tabs.has(id));
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
assert.equal(reloads, 1, "timeouts refresh once before deferring inspection");
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
releaseInspection = undefined;
assert.equal(dispatches, 4, "a resumed command shares the existing inspection");
tabs.delete(7);
offline = true;
await assert.rejects(context.threadTabRemoved(7), /offline/);
assert.equal(storage["closedRalphTab:7"], url, "closure is retained while the server is offline");
offline = false;
await context.reportClosedThreadTabs();
assert.deepEqual(removals, [{ conversationUrl: url, settled: true }]);
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
await context.threadTabRemoved(8, { isWindowClosing: true });
assert.equal(storage["closedThread:" + url], true, "closing a window also settles its old idle threads");
tabs.delete(8);
await inspect("after-browser-close");
assert.equal(creations.length, 1, "a closed window does not reopen idle threads");
await inspect("reuse-reopened-thread");
assert.equal(creations.length, 1, "later inspections still respect closed tabs");
const raceUrl = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
tabs.set(10, { id: 10, windowId: 3, url: raceUrl, status: "complete" });
holdTracking = true;
const tracking = context.trackThreadTab(10, raceUrl);
await new Promise(resolve => setImmediate(resolve));
tabs.delete(10);
const removal = context.threadTabRemoved(10, { isWindowClosing: false });
await new Promise(resolve => setImmediate(resolve));
holdTracking = false;
releaseTracking();
await Promise.all([tracking, removal]);
assert.equal(removals.at(-1).conversationUrl, raceUrl, "closure during tracking still removes the registered thread");
assert.equal(storage["closedThread:" + raceUrl], true, "a late tracking write must not erase deliberate closure");
assert.equal(storage["ralphTab:10"], undefined, "late tracking must not restore a removed tab");
await context.executeCommand({ id: "closed-during-tracking", feature: "ralph", kind: "inspect_thread", conversationUrl: raceUrl }, "existing");
assert.equal(creations.length, 1, "a stale inspection cannot recreate the tab closed during tracking");
const temporaryUrl = url + "?temporary-chat=true";
await assert.rejects(context.acquireAutomationTab(temporaryUrl, false), /cannot be reopened/);
assert.equal(creations.length, 1, "a missing temporary worker cannot become a saved conversation");
tabs.set(11, { id: 11, windowId: 3, active: true, url, status: "complete" });
storage[`threadActivity:${url}`] = "idle";
await context.trackViewedThread(tabs.get(11));
const beforeLeaving = removals.length;
await context.reportClosedThreadTabs();
assert.equal(removals.length, beforeLeaving, "a viewed completion stays ready while its tab is active");
offline = true;
tabs.get(11).active = false;
tabs.set(12, { id: 12, windowId: 3, active: true, url: "https://example.com", status: "complete" });
await assert.rejects(context.trackViewedThread(tabs.get(12)), /offline/);
assert.equal(storage[`viewedCompletion:${url}`], true);
offline = false;
await context.reportClosedThreadTabs();
assert.deepEqual(removals.at(-1), { conversationUrl: url, settled: true }, "monitoring retries settlement after the server returns");
assert.equal(storage[`viewedCompletion:${url}`], undefined);
console.log("RALPH lifecycle tests passed.");
