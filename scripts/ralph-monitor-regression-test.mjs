import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { RalphController, RalphRegistry, SupportCommandBus } from "../dist/chatgpt-support.js";

const caseName = process.argv[2];

async function testInlineStreamFailureDetection() {
  let automationListener;
  const stopButton = {};
  let running = true;
  const editor = {};
  const assistantMessage = { textContent: "Stream disconnected." };
  const assistantTurn = {
    dataset: { turn: "assistant" },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
      return [];
    },
  };
  const userTurn = { dataset: { turn: "user" }, querySelector: () => null };
  const newerUserTurn = { dataset: { turn: "user" }, querySelector: () => null };
  let turns = [userTurn, assistantTurn];
  const composer = {
    querySelector(selector) {
      if (selector === '#prompt-textarea[contenteditable="true"]') return editor;
      if (selector === 'button[data-testid="stop-button"]') return running ? stopButton : null;
      return null;
    },
  };
  const document = {
    title: "Interrupted task - ChatGPT",
    readyState: "complete",
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"]') return turns.filter(turn => turn.dataset.turn === "user").at(-1);
      if (selector.includes('button[data-testid="stop-button"]')) return running ? stopButton : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'section[data-turn="user"]') return turns.filter(turn => turn.dataset.turn === "user");
      if (selector === 'section[data-turn="assistant"]') return turns.filter(turn => turn.dataset.turn === "assistant");
      if (selector === 'section[data-turn]') return turns;
      return [];
    },
  };
  const browser = {
    runtime: {
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener(fn) { automationListener = fn; } },
    },
  };
  vm.runInNewContext(await readFile("support-extension/content-script.js", "utf8"), {
    window: { addEventListener() {} },
    location: new URL("https://chatgpt.com/c/11111111-1111-4111-8111-111111111111"),
    document,
    browser,
    setTimeout,
    clearTimeout,
  });
  const result = await new Promise(resolve => automationListener({
    type: "local-codex-support/automation-v1",
    command: { kind: "page_health" },
  }, {}, resolve));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.status, "recoverable_error",
    "an inline stream failure with Stop still visible must trigger recovery instead of looking like a healthy running turn");
  running = false;
  const stoppedResult = await new Promise(resolve => automationListener({
    type: "local-codex-support/automation-v1",
    command: { kind: "page_health" },
  }, {}, resolve));
  assert.equal(stoppedResult.result.status, "recoverable_error",
    "the same terminal stream failure must still trigger recovery when ChatGPT drops Stop by itself");
  turns = [userTurn, assistantTurn, newerUserTurn];
  running = true;
  const newTurnResult = await new Promise(resolve => automationListener({
    type: "local-codex-support/automation-v1",
    command: { kind: "page_health" },
  }, {}, resolve));
  assert.equal(newTurnResult.result.status, "ok",
    "a terminal error from an older assistant turn must not stop a newer run before its assistant output appears");
}

async function testIdleCompletionClassification() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ralph-monitor-regression-"));
  const registry = await RalphRegistry.open(directory, 1);
  const commands = new SupportCommandBus();
  const previousFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async () => {
    apiCalls += 1;
    return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "CONTINUE" }] }] }),
      { headers: { "content-type": "application/json" } });
  };
  const controller = new RalphController({ registry, commands, apiKey: "fixture-key", model: "fixture-model",
    auditLogPath: path.join(directory, "audit.log"), checkEveryMs: 60_000 });
  try {
    const url = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
    const threadId = url.split("/c/")[1];
    await registry.register(url, { manual: true });
    await registry.scheduleNow(threadId);
    await controller.tick();
    const inspect = await commands.claim("chrome", ["ralph"], 1000, undefined, [url]);
    assert.equal(inspect.kind, "inspect_thread");
    commands.complete({ commandId: inspect.id, browserId: "chrome", kind: inspect.kind, ok: true, result: {
      status: "idle", workedSeconds: null,
      users: [{ id: "u1", text: "Finish the task." }],
      assistant: { id: "a1", synthetic: false, text: "I stopped before finishing the task." },
    } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(apiCalls, 1, "every real final response must reach the classifier even without a worked-time label");
    const send = await commands.claim("chrome", ["ralph"], 1000, undefined, [url]);
    assert.equal(send.kind, "send_message", "an unfinished idle turn receives a continuation");
    assert.equal(send.message, "Continue");
    commands.complete({ commandId: send.id, browserId: "chrome", kind: send.kind, ok: true,
      result: { status: "sent", conversationUrl: url } });
    assert.equal(await registry.isActive(threadId), true, "unfinished work stays monitored");
  } finally {
    controller.close();
    commands.close();
    globalThis.fetch = previousFetch;
    await rm(directory, { recursive: true, force: true });
  }
}

async function testMissingFinalResponseContinues() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ralph-monitor-regression-"));
  const registry = await RalphRegistry.open(directory, 1);
  const commands = new SupportCommandBus();
  const previousFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async () => { apiCalls += 1; throw new Error("Synthetic stopped turns must continue without classification."); };
  const controller = new RalphController({ registry, commands, apiKey: "fixture-key", model: "fixture-model",
    auditLogPath: path.join(directory, "audit.log"), checkEveryMs: 60_000 });
  try {
    const url = "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333";
    const threadId = url.split("/c/")[1];
    await registry.register(url, { manual: true });
    await registry.scheduleNow(threadId);
    await controller.tick();
    const inspect = await commands.claim("chrome", ["ralph"], 1000, undefined, [url]);
    commands.complete({ commandId: inspect.id, browserId: "chrome", kind: inspect.kind, ok: true, result: {
      status: "idle", workedSeconds: null,
      users: [{ id: "u1", text: "Finish the task." }],
      assistant: { synthetic: true, text: "[Thread stopped before a final assistant response was produced.]" },
    } });
    const send = await commands.claim("chrome", ["ralph"], 1000, undefined, [url]);
    assert.equal(send.kind, "send_message");
    assert.equal(send.message, "Continue");
    assert.equal(apiCalls, 0, "a stopped turn without a final response continues without calling the classifier");
    commands.complete({ commandId: send.id, browserId: "chrome", kind: send.kind, ok: true,
      result: { status: "sent", conversationUrl: url } });
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    controller.close();
    commands.close();
    globalThis.fetch = previousFetch;
    await rm(directory, { recursive: true, force: true });
  }
}

if (!caseName || caseName === "inline") await testInlineStreamFailureDetection();
if (!caseName || caseName === "idle") await testIdleCompletionClassification();
if (!caseName || caseName === "synthetic") await testMissingFinalResponseContinues();

async function testPageErrorRecoveryDispatch() {
  const source = await readFile("support-extension/service-worker.js", "utf8");
  const url = "https://chatgpt.com/c/44444444-4444-4444-8444-444444444444";
  const config = { extensionToken: "x".repeat(40) };
  for (const [key, route] of Object.entries({ bindUrl: "/thread-sync/bind", commandClaimUrl: "/chatgpt-support/commands/claim",
    commandResultUrl: "/chatgpt-support/commands/result", threadObserveUrl: "/chatgpt-support/threads/observe",
    ralphRegisterUrl: "/chatgpt-support/ralph/register" })) config[key] = `http://127.0.0.1:6002${route}`;
  const storage = {
    threadSync: false,
    automationExecutor: false,
    ralph: false,
    threadMessaging: false,
    automationThreadTabsV1: { [url]: 7 },
  };
  const calls = [];
  const tabs = new Map([[7, { id: 7, windowId: 1, url, status: "complete", active: false }]]);
  const context = {
    URL, AbortSignal, AbortController, crypto: globalThis.crypto, Response, console, setTimeout, clearTimeout,
    importScripts() {}, LOCAL_CODEX_THREAD_SYNC: config,
    browser: {
      sidePanel: { async setPanelBehavior() {} },
      runtime: { id: "support", onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      storage: { local: {
        async get(query) { return typeof query === "string" ? { [query]: storage[query] } : { ...query, ...storage }; },
        async set(values) { Object.assign(storage, values); },
        async remove(keys) { for (const key of [keys].flat()) delete storage[key]; },
      } },
      scripting: { async executeScript() {} },
      tabs: {
        async query() { return [...tabs.values()]; },
        async get(id) { return tabs.get(id); },
        async sendMessage(id, { command }) {
          assert.equal(id, 7);
          calls.push(command.kind);
          if (command.kind === "page_health") return { ok: true, result: { status: "recoverable_error" } };
          if (command.kind === "stop_thread") return { ok: true, result: { status: "stopped" } };
          if (command.kind === "send_message") return { ok: true, result: { status: "sent" } };
          throw new Error(`Unexpected page command ${command.kind}`);
        },
      },
    },
    async fetch(endpoint, options) {
      const request = JSON.parse(options.body);
      if (request.recoveryReservation?.action === "acquire") {
        return new Response(JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expiresAt: Date.now() + 540_000 }));
      }
      if (endpoint === config.ralphRegisterUrl) {
        return new Response(JSON.stringify({ status: "registered" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    },
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  storage.automationExecutor = true;
  storage.ralph = true;
  await context.reactivateRalphConversation({
    conversationUrl: url,
    activity: "blocked",
    completed: true,
    interrupted: false,
    pageHealth: "recoverable_error",
  }, { id: "support", frameId: 0, tab: { id: 7 } });
  for (let index = 0; index < 10 && calls.length < 3; index += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(-3), ["page_health", "stop_thread", "send_message"],
    "a reported response failure must stop the managed turn before sending one continuation");
}

if (!caseName || caseName === "recovery") await testPageErrorRecoveryDispatch();
console.log("RALPH monitor regression tests passed.");
