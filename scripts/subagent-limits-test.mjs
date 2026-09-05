import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { SubagentJobRegistry } from "../dist/subagent-jobs.js";
import { RalphController, RalphRegistry, SubagentResultController, SupportCommandBus, registerChatGptAgents } from "../dist/chatgpt-support.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "subagent-limits-"));
try {
  const jobs = await SubagentJobRegistry.open(directory);
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
  const beforeRestart = await SubagentJobRegistry.open(restartRoot);
  const interrupted = await beforeRestart.create({ threadId: "restart-parent", conversationUrl: "https://chatgpt.com/c/restart-parent" });
  const afterRestart = await SubagentJobRegistry.open(restartRoot);
  assert.match((await afterRestart.job(interrupted.jobId)).preparationError, /interrupted by a service restart/,
    "restart marks an unfinished startup as interrupted instead of leaving it permanently in flight");
  await afterRestart.cancel(interrupted.jobId);
  assert.equal((await afterRestart.job(interrupted.jobId)).state, "cancelled");
  await afterRestart.create({ threadId: "replacement-parent", conversationUrl: "https://chatgpt.com/c/replacement-parent" });
  await jobs.assignChild(admitted[0].jobId, { threadId: "child", conversationUrl: "https://chatgpt.com/c/child" });
  await assert.rejects(jobs.create({ threadId: "child", conversationUrl: "https://chatgpt.com/c/child" }), /Only root/);
  await jobs.complete(admitted[0].jobId, "Review complete");
  const replacement = await jobs.create({ threadId: "parent", conversationUrl: "https://chatgpt.com/c/parent" });
  await jobs.cancel(replacement.jobId);
  await assert.rejects(jobs.complete(replacement.jobId, "Late report"), /cancelled/);
  await jobs.cancel(replacement.jobId);
  assert.equal((await jobs.jobsNeedingNotification()).some(job => job.jobId === replacement.jobId), false);
  await jobs.cancel(admitted[1].jobId);

  const batchJobs = await SubagentJobRegistry.open(path.join(directory, "batch"));
  const parent = { threadId: "11111111-1111-4111-8111-111111111111", conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111" };
  const first = await batchJobs.create(parent);
  const second = await batchJobs.create(parent);
  const bus = new SupportCommandBus();
  const controller = new SubagentResultController(batchJobs, bus, async () => {}, 60_000, 0);
  try {
    await batchJobs.complete(first.jobId, "First private report");
    await batchJobs.complete(second.jobId, "Second private report");
    await Promise.all([controller.tick(), controller.tick()]);
    const notice = await bus.claim("browser", ["threadMessaging"], 1000);
    assert.ok(notice.message.includes(first.resultPath.replaceAll("\\", "\\\\")));
    assert.ok(notice.message.includes(JSON.stringify(second.resultPath)));
    assert.doesNotMatch(notice.message, /private report/);
    assert.equal(await bus.claim("other-browser", ["threadMessaging"], 0), undefined,
      "overlapping scheduler ticks emit one batched notice");
    assert.equal(await batchJobs.blocksContinuation(parent.threadId), true);
    bus.complete({ commandId: notice.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await batchJobs.blocksContinuation(parent.threadId), false);
    assert.ok((await batchJobs.job(first.jobId)).notifiedAt);
    assert.ok((await batchJobs.job(second.jobId)).notifiedAt);
  } finally { controller.close(); bus.close(); }

  const damagedJobs = await SubagentJobRegistry.open(path.join(directory, "damaged"));
  const damaged = await damagedJobs.create(parent);
  const healthy = await damagedJobs.create(parent);
  await mkdir(damaged.resultPath);
  await damagedJobs.complete(healthy.jobId, "Valid sibling report");
  const damagedBus = new SupportCommandBus();
  const damagedController = new SubagentResultController(damagedJobs, damagedBus, async () => {}, 60_000, 0);
  try {
    await damagedController.tick();
    const notice = await damagedBus.claim("browser", ["threadMessaging"], 1000);
    assert.ok(notice.message.includes(healthy.jobId), "an unreadable result must not block a healthy sibling");
    assert.ok(!notice.message.includes(damaged.jobId));
    damagedBus.complete({ commandId: notice.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match((await damagedJobs.job(damaged.jobId)).notificationError, /EISDIR/);
    assert.ok((await damagedJobs.job(healthy.jobId)).notifiedAt);
  } finally { damagedController.close(); damagedBus.close(); }

  const cooldownBus = new SupportCommandBus(undefined, 30, 15);
  try {
    const firstSend = cooldownBus.execute(
      { feature: "threadMessaging", kind: "send_message", targetUrl: parent.conversationUrl, message: "first" },
      20,
    );
    const claimed = await cooldownBus.claim("browser", ["threadMessaging"], 0);
    const secondSend = cooldownBus.execute({ feature: "ralph", kind: "send_message", targetUrl: parent.conversationUrl, message: "second" });
    cooldownBus.complete({ commandId: claimed.id, browserId: "browser", kind: "send_message", ok: false,
      error: "CHATGPT_RATE_LIMITED: Too many messages" });
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

    const normalSend = cooldownBus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: parent.conversationUrl, message: "normal" });
    const normal = await cooldownBus.claim("browser", ["threadMessaging"], 0);
    assert.equal(normal.message, "normal", "pacing turns off after the deferred backlog is drained");
    cooldownBus.complete({ commandId: normal.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await normalSend;
  } finally { cooldownBus.close(); }

  const registry = await RalphRegistry.open(path.join(directory, "ralph"), 1);
  await registry.register(parent.conversationUrl, { agentCreated: true });
  await registry.setMode(parent.threadId, "continuous");
  await registry.scheduleNow(parent.threadId);
  const waiting = await batchJobs.create(parent);
  const ralphBus = new SupportCommandBus();
  const ralph = new RalphController({ registry, commands: ralphBus, jobs: batchJobs, model: "unused", auditLogPath: path.join(directory, "audit.log"), checkEveryMs: 60_000 });
  try {
    await ralph.tick();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await ralphBus.claim("browser", ["ralph"], 0), undefined,
      "a continuous parent waiting for children must not inspect, classify, or send");
  } finally { ralph.close(); ralphBus.close(); }

  const handlers = new Map();
  const toolBus = new SupportCommandBus(undefined, 30, 15);
  registerChatGptAgents({ registerResource() {}, registerTool(name, definition, handler) { handlers.set(name, handler); } },
    toolBus, { async binding({ sessionId }) { return sessionId === "owner" ? parent : { threadId: "other" }; } },
    registry, batchJobs, { async ensurePrepared() {} }, async () => {}, "grant", "");
  try {
    const cancel = handlers.get("cancel_subagent");
    assert.equal((await cancel({ jobId: waiting.jobId }, { _meta: { "openai/session": "stranger" } })).isError, true);
    assert.equal((await batchJobs.job(waiting.jobId)).state, "pending");
    assert.equal((await cancel({ jobId: waiting.jobId }, { _meta: { "openai/session": "owner" } })).isError, true,
      "an unresolved in-flight startup cannot release its reservation");
    await batchJobs.recordPreparationFailure(waiting.jobId, "startup could not be confirmed");
    await cancel({ jobId: waiting.jobId }, { _meta: { "openai/session": "owner" } });
    assert.equal((await batchJobs.job(waiting.jobId)).state, "cancelled");

    const childThreadId = "22222222-2222-4222-8222-222222222222";
    const childUrl = `https://chatgpt.com/c/${childThreadId}`;
    const cancellable = await batchJobs.create(parent);
    await batchJobs.assignChild(cancellable.jobId, { threadId: childThreadId, conversationUrl: childUrl });
    await registry.register(childUrl, { agentCreated: true, parentThreadId: parent.threadId });
    const cancellation = cancel({ jobId: cancellable.jobId }, { _meta: { "openai/session": "owner" } });
    const stopCommand = await toolBus.claim("browser", ["threadMessaging"], 1000);
    assert.equal(stopCommand.kind, "stop_thread");
    assert.equal(stopCommand.targetUrl, childUrl);
    assert.equal((await batchJobs.job(cancellable.jobId)).state, "pending",
      "the slot remains reserved until browser cancellation succeeds");
    toolBus.complete({ commandId: stopCommand.id, browserId: "browser", kind: "stop_thread", ok: true,
      result: { status: "stopped", conversationUrl: childUrl } });
    assert.equal((await cancellation).isError, undefined);
    assert.equal((await batchJobs.job(cancellable.jobId)).state, "cancelled");
    assert.equal((await registry.threads()).find(thread => thread.threadId === childThreadId).state, "complete");

    const limiter = toolBus.execute(
      { feature: "threadMessaging", kind: "send_message", targetUrl: parent.conversationUrl, message: "trigger cooldown" },
      200,
    );
    const limiterCommand = await toolBus.claim("browser", ["threadMessaging"], 0);
    toolBus.complete({ commandId: limiterCommand.id, browserId: "browser", kind: "send_message", ok: false,
      error: "CHATGPT_RATE_LIMITED: Too many messages" });
    const queuedStart = handlers.get("start_subagent")({ message: "queued child start" },
      { requestId: "cooldown-child", _meta: { "openai/session": "owner" } });
    await new Promise(resolve => setTimeout(resolve, 10));
    const queuedJob = (await batchJobs.forParent(parent.threadId)).find(job =>
      job.state === "pending" && !job.childThreadId && job.jobId !== waiting.jobId);
    assert.ok(queuedJob, "a child start during cooldown reserves its parent slot instead of being discarded");
    assert.equal(await toolBus.claim("browser", ["threadMessaging"], 0), undefined,
      "the child-start browser message waits during cooldown");

    await new Promise(resolve => setTimeout(resolve, 35));
    const limiterRetry = await toolBus.claim("browser", ["threadMessaging"], 0);
    assert.equal(limiterRetry.id, limiterCommand.id);
    toolBus.complete({ commandId: limiterRetry.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await limiter;
    await new Promise(resolve => setTimeout(resolve, 20));
    const queuedChildCommand = await toolBus.claim("browser", ["threadMessaging"], 0);
    assert.match(queuedChildCommand.message, /queued child start/);
    const queuedChildThreadId = "33333333-3333-4333-8333-333333333333";
    const queuedChildUrl = `https://chatgpt.com/c/${queuedChildThreadId}`;
    toolBus.complete({ commandId: queuedChildCommand.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: queuedChildUrl, title: "Queued child" } });
    const queuedStartResult = await queuedStart;
    assert.equal(queuedStartResult.isError, undefined);
    assert.equal((await batchJobs.job(queuedJob.jobId)).childConversationUrl, queuedChildUrl);
    await registry.recordComplete(queuedChildThreadId);
    await batchJobs.cancel(queuedJob.jobId);

    const pending = [await batchJobs.create(parent), await batchJobs.create(parent)];
    const refused = await handlers.get("start_subagent")({ message: "third child" }, { requestId: "capacity", _meta: { "openai/session": "owner" } });
    assert.equal(refused.isError, true);
    for (const job of pending) assert.ok(refused.content[0].text.includes(job.jobId));
    assert.equal(await toolBus.claim("browser", ["threadMessaging"], 0), undefined,
      "capacity refusal reaches no browser send");
    const listing = await handlers.get("list_subagents")({}, { _meta: { "openai/session": "owner" } });
    for (const job of pending) assert.ok(listing.structuredContent.subagents.some(view => view.jobId === job.jobId));
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
    if (visible) assert.match(response.error, /^CHATGPT_RATE_LIMITED:/);
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
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("subagent-limits-"));
  await rm(directory, { recursive: true, force: true });
}
