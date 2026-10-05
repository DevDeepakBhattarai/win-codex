import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { SubagentJobRegistry } from "../dist/subagent-jobs.js";
import { RalphController, RalphRegistry, SupportCommandBus, registerChatGptAgents } from "../dist/chatgpt-support.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "subagent-limits-"));
let jobs, beforeRestart, afterRestart, batchJobs;
try {
  jobs = await SubagentJobRegistry.open(directory);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => {
    const parentIndex = index < 4 ? "a" : "b";
    return jobs.create({
      threadId: `parent-${parentIndex}`,
      conversationUrl: `https://chatgpt.com/c/parent-${parentIndex}`,
    });
  }));
  const admitted = attempts.filter(result => result.status === "fulfilled").map(result => result.value);
  assert.equal(admitted.length, 4, "two different parents may each reserve two child slots");
  assert.equal(admitted.filter(job => job.parentThreadId === "parent-a").length, 2);
  assert.equal(admitted.filter(job => job.parentThreadId === "parent-b").length, 2);
  const restartRoot = path.join(directory, "restart");
  beforeRestart = await SubagentJobRegistry.open(restartRoot);
  const interrupted = await beforeRestart.create({ threadId: "restart-parent", conversationUrl: "https://chatgpt.com/c/restart-parent" });
  await beforeRestart.close();
  afterRestart = await SubagentJobRegistry.open(restartRoot);
  assert.match((await afterRestart.job(interrupted.jobId)).preparationError, /interrupted by a service restart/,
    "restart marks an unfinished startup as interrupted instead of leaving it permanently in flight");
  await afterRestart.cancel(interrupted.jobId);
  assert.equal((await afterRestart.job(interrupted.jobId)).state, "cancelled");
  await afterRestart.create({ threadId: "replacement-parent", conversationUrl: "https://chatgpt.com/c/replacement-parent" });
  await jobs.assignChild(admitted[0].jobId, { threadId: "child", conversationUrl: "https://chatgpt.com/c/child" });
  await assert.rejects(jobs.create({ threadId: "child", conversationUrl: "https://chatgpt.com/c/child" }), /Only root/);
  await jobs.complete(admitted[0].jobId, "Task complete");
  const replacement = await jobs.create({ threadId: "parent", conversationUrl: "https://chatgpt.com/c/parent" });
  await jobs.cancel(replacement.jobId);
  await assert.rejects(jobs.complete(replacement.jobId, "Late report"), /cancelled/);
  await jobs.cancel(replacement.jobId);
  await jobs.cancel(admitted[1].jobId);

  batchJobs = await SubagentJobRegistry.open(path.join(directory, "batch"));
  const parent = { threadId: "11111111-1111-4111-8111-111111111111", conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111" };
  const cooldownBus = new SupportCommandBus(undefined, 30, 15);
  try {
    const firstSend = cooldownBus.execute(
      { feature: "threadMessaging", kind: "send_message", targetUrl: parent.conversationUrl, message: "first" },
      20,
    );
    const claimed = await cooldownBus.claim("browser", ["threadMessaging"], 0);
    const secondSend = cooldownBus.execute({ feature: "ralph", kind: "send_message", targetUrl: parent.conversationUrl, message: "second" });
    cooldownBus.complete({ commandId: claimed.id, browserId: "browser", kind: "send_message", ok: false,
      error: "CHATGPT_RATE_LIMITED_RETRYABLE: Too many messages" });
    const thirdSend = cooldownBus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: parent.conversationUrl, message: "third" });
    assert.ok(cooldownBus.messageCooldownUntil() > Date.now());
    assert.equal(await cooldownBus.claim("browser", ["ralph", "threadMessaging"], 0), undefined,
      "rate-limited sends stay queued during cooldown");

    const stop = cooldownBus.execute({ feature: "threadMessaging", kind: "stop_thread", targetUrl: parent.conversationUrl });
    const stopCommand = await cooldownBus.claim("browser", ["threadMessaging"], 0);
    assert.equal(stopCommand.kind, "stop_thread", "cancellation is not blocked by message cooldown");
    cooldownBus.complete({ commandId: stopCommand.id, browserId: "browser", kind: "stop_thread", ok: true,
      result: { status: "idle", conversationUrl: parent.conversationUrl } });
    await stop;

    await new Promise(resolve => setTimeout(resolve, 35));
    const retryFirst = await cooldownBus.claim("browser", ["ralph", "threadMessaging"], 0);
    assert.equal(retryFirst.id, claimed.id, "the rate-limited command is retried before later queued sends");
    cooldownBus.complete({ commandId: retryFirst.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await firstSend;

    assert.equal(await cooldownBus.claim("browser", ["ralph", "threadMessaging"], 0), undefined,
      "message pacing prevents an immediate second send");
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await cooldownBus.claim("browser", ["ralph", "threadMessaging"], 0);
    assert.equal(second.message, "second");
    cooldownBus.complete({ commandId: second.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await secondSend;

    await new Promise(resolve => setTimeout(resolve, 20));
    const third = await cooldownBus.claim("browser", ["ralph", "threadMessaging"], 0);
    assert.equal(third.message, "third");
    cooldownBus.complete({ commandId: third.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await thirdSend;

    const uncertainSend = cooldownBus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: parent.conversationUrl, message: "uncertain" });
    const uncertain = await cooldownBus.claim("browser", ["threadMessaging"], 0);
    cooldownBus.complete({ commandId: uncertain.id, browserId: "browser", kind: "send_message", ok: false,
      error: "CHATGPT_RATE_LIMITED: Provider notice appeared after click" });
    assert.equal((await uncertainSend).ok, false, "post-click rate limits surface as uncertain instead of replaying the send");
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal((await cooldownBus.claim("browser", ["threadMessaging"], 0))?.id, undefined,
      "an uncertain send is never requeued after cooldown");

    const normalSend = cooldownBus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: parent.conversationUrl, message: "normal" });
    const normal = await cooldownBus.claim("browser", ["threadMessaging"], 0);
    assert.equal(normal.message, "normal", "pacing turns off after the deferred backlog is drained");
    cooldownBus.complete({ commandId: normal.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await normalSend;
  } finally { cooldownBus.close(); }

  const inspectCooldownBus = new SupportCommandBus(undefined, 30, 15);
  try {
    const inspection = inspectCooldownBus.execute({
      feature: "ralph", kind: "inspect_thread", conversationUrl: parent.conversationUrl,
    });
    const claimed = await inspectCooldownBus.claim("browser", ["ralph"], 0);
    inspectCooldownBus.complete({ commandId: claimed.id, browserId: "browser", kind: "inspect_thread", ok: false,
      error: "CHATGPT_RATE_LIMITED: Usage limit reached" });
    assert.equal((await inspection).ok, false);
    assert.ok(inspectCooldownBus.messageCooldownUntil() > Date.now(),
      "a rate limit found during inspection also pauses continuation");
  } finally { inspectCooldownBus.close(); }

  const registry = await RalphRegistry.open(path.join(directory, "ralph"), 1);
  await registry.register(parent.conversationUrl, { agentCreated: true });
  await registry.scheduleNow(parent.threadId);
  const waiting = await batchJobs.create(parent);
  const ralphBus = new SupportCommandBus();
  const ralph = new RalphController({ registry, commands: ralphBus, jobs: batchJobs, model: "unused", auditLogPath: path.join(directory, "audit.log"), checkEveryMs: 60_000 });
  try {
    await ralph.tick();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await ralphBus.claim("browser", ["ralph"], 0), undefined,
      "a parent waiting for children must not inspect, classify, or send");
  } finally { ralph.close(); ralphBus.close(); }

  const handlers = new Map();
  const toolBus = new SupportCommandBus(undefined, 30, 15);
  registerChatGptAgents({ registerResource() {}, registerTool(name, definition, handler) { handlers.set(name, handler); } },
    toolBus, { async binding({ sessionId }) { return sessionId === "owner" ? parent : { threadId: "other" }; } },
    batchJobs, { async ensurePrepared() {}, markPrepared() {} }, async () => {}, "grant");
  try {
    assert.deepEqual([...handlers.keys()].sort(),
      ["send_thread_message", "start_thread"],
      "the ChatGPT connector retains explicit thread operations without task lifecycle tools");
    for (const removed of ["start_subagent", "cancel_subagent", "list_subagents", "submit_subagent_result"]) {
      assert.equal(handlers.has(removed), false, `${removed} stays off the ChatGPT-facing tool surface`);
    }
    await batchJobs.recordPreparationFailure(waiting.jobId, "test cleanup");
    await batchJobs.cancel(waiting.jobId);
  } finally { toolBus.close(); }

  const contentScript = await readFile("support-extension/content-script.js", "utf8");
  for (const visible of [true, false]) {
    let listener;
    const notice = { textContent: "Too many messages. Please try again later.", getClientRects: () => visible ? [{}] : [] };
    const document = {
      title: "ChatGPT",
      querySelector: () => null,
      querySelectorAll: selector => selector.includes('[role="alert"]') ? [notice] : [],
    };
    vm.runInNewContext(contentScript, {
      document, location: new URL(parent.conversationUrl), window: { addEventListener() {} },
      browser: { runtime: { async sendMessage() {}, onMessage: { addListener(value) { listener = value; } } } },
    });
    const response = await new Promise(resolve => listener({ type: "local-codex-support/automation-v1",
      command: { kind: "send_message", message: "" } }, {}, resolve));
    assert.equal(response.ok, false);
    if (visible) assert.match(response.error, /^CHATGPT_RATE_LIMITED_RETRYABLE:/);
    else assert.match(response.error, /non-empty ChatGPT message/,
      "hidden notices must not trigger account cooldowns");
  }

  let stopListener;
  let running = false;
  let stopClicks = 0;
  const stopButton = { click() { stopClicks += 1; running = false; } };
  setTimeout(() => { running = true; }, 200);
  const editor = {};
  const composer = {
    querySelector(selector) {
      if (selector.includes("prompt-textarea")) return editor;
      if (selector.includes("stop-button")) return running ? stopButton : null;
      return null;
    },
  };
  const stopDocument = {
    title: "Running child - ChatGPT",
    readyState: "complete",
    documentElement: null,
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"]') return {};
      return null;
    },
    querySelectorAll: () => [],
  };
  vm.runInNewContext(contentScript, {
    document: stopDocument, location: new URL(parent.conversationUrl), window: { addEventListener() {} }, setTimeout,
    browser: { runtime: { async sendMessage() {}, onMessage: { addListener(value) { stopListener = value; } } } },
  });
  const stopped = await new Promise(resolve => stopListener({ type: "local-codex-support/automation-v1",
    command: { kind: "stop_thread" } }, {}, resolve));
  assert.equal(stopped.ok, true);
  assert.equal(stopped.result.status, "stopped");
  assert.equal(stopClicks, 1,
    "cancellation waits through hydration and clicks a stop button that appears after the composer");

  console.log("Sub-agent limits tests passed.");
} finally {
  await Promise.all([jobs?.close(), beforeRestart?.close(), afterRestart?.close(), batchJobs?.close()]);
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("subagent-limits-"));
  await rm(directory, { recursive: true, force: true });
}
