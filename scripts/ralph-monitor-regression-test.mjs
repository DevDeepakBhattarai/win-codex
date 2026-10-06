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

async function testIdleCompletionGate() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ralph-monitor-regression-"));
  const registry = await RalphRegistry.open(directory, 1);
  const commands = new SupportCommandBus();
  const previousFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async () => {
    apiCalls += 1;
    throw new Error("The classifier must not run for a settled turn below the worked-time gate.");
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
      assistant: { id: "a1", synthetic: false, text: "Done." },
    } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(apiCalls, 0, "a final response at or below 20 minutes must not spend a completion-classifier call");
    assert.equal(await registry.isActive(threadId), false, "the short settled turn is complete");
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
    assert.equal(send.message, "Continue the existing task from its current state. Do not repeat completed work.");
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
if (!caseName || caseName === "idle") await testIdleCompletionGate();
if (!caseName || caseName === "synthetic") await testMissingFinalResponseContinues();
console.log("RALPH monitor regression tests passed.");