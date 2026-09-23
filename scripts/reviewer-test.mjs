import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { SubagentJobRegistry } from "../dist/subagent-jobs.js";
import { RalphController, RalphRegistry, SubagentResultController, SupportCommandBus, registerChatGptAgents, reviewActionHandler } from "../dist/chatgpt-support.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "subagent-limits-"));
try {
  const parent = { threadId: "11111111-1111-4111-8111-111111111111", conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111" };
  const child = { threadId: "22222222-2222-4222-8222-222222222222", conversationUrl: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" };
  const jobs = await SubagentJobRegistry.open(directory);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => jobs.create(parent)));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1, "concurrent starts reserve only one reviewer per parent");
  const job = attempts.find(result => result.status === "fulfilled").value;
  await jobs.assignChild(job.jobId, child);
  await assert.rejects(jobs.create(child), /cannot start another reviewer/);
  await writeFile(job.resultPath, "An unfinished report file");
  assert.deepEqual(await jobs.jobsNeedingNotification(), [], "writing a file cannot complete a review");
  await jobs.complete(job.jobId, "Review report");
  await assert.rejects(jobs.create(parent), /unfinished review/, "submission alone does not release the parent's handoff");
  await jobs.recordNotificationFailure(job.jobId, "delivery failed", 1);
  assert.equal(await jobs.blocksContinuation(parent.threadId), true, "failed wake-up must not silently resume the parent");
  await jobs.retryNotification(job.jobId);

  const bus = new SupportCommandBus();
  const controller = new SubagentResultController(jobs, bus, async () => {}, 60_000, 0);
  const finish = (command, result) => bus.complete({ commandId: command.id, browserId: "browser", kind: command.kind, ok: true, result });
  try {
    await controller.tick();
    let inspection = await bus.claim("browser", ["threadMessaging"], 1000);
    assert.equal(inspection.kind, "inspect_thread");
    finish(inspection, { status: "running" });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await bus.claim("browser", ["threadMessaging"], 0), undefined, "review_done cannot wake the parent while the reviewer is still running");
    await controller.tick();
    assert.equal(await bus.claim("browser", ["threadMessaging"], 0), undefined, "running reviewer checks back off");
  } finally { controller.close(); bus.close(); }

  const wakeBus = new SupportCommandBus();
  const wakeController = new SubagentResultController(jobs, wakeBus, async () => {}, 60_000, 0);
  try {
    await Promise.all([wakeController.tick(), wakeController.tick()]);
    const inspection = await wakeBus.claim("browser", ["threadMessaging"], 1000);
    wakeBus.complete({ commandId: inspection.id, browserId: "browser", kind: "inspect_thread", ok: true,
      result: { status: "idle", users: [], workedSeconds: null, assistant: { synthetic: false, text: "Review done" } } });
    const notice = await wakeBus.claim("browser", ["threadMessaging"], 1000);
    assert.equal(notice.targetUrl, parent.conversationUrl);
    assert.ok(notice.message.includes(JSON.stringify(job.resultPath)));
    assert.equal(await wakeBus.claim("browser", ["threadMessaging"], 0), undefined, "overlapping ticks emit one wake-up");
    wakeBus.complete({ commandId: notice.id, browserId: "browser", kind: "send_message", ok: true, result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await jobs.blocksContinuation(parent.threadId), false);
    assert.equal(await jobs.blocksContinuation(child.threadId), true);
  } finally { wakeController.close(); wakeBus.close(); }

  const suppressedRoot = path.join(directory, "parent-completed-review");
  const suppressedRegistry = await RalphRegistry.open(suppressedRoot, 20);
  await suppressedRegistry.register(parent.conversationUrl, { manual: true });
  const suppressedJobs = await SubagentJobRegistry.open(path.join(suppressedRoot, "jobs"));
  const suppressedJob = await suppressedJobs.create(parent);
  await suppressedJobs.assignChild(suppressedJob.jobId, child);
  await suppressedJobs.complete(suppressedJob.jobId, "Review completed after the parent was abandoned");
  const suppressedBus = new SupportCommandBus();
  const suppressedController = new SubagentResultController(
    suppressedJobs, suppressedBus, async () => {}, 60_000, 0, suppressedRegistry,
  );
  try {
    await suppressedController.tick();
    const inspection = await suppressedBus.claim("browser", ["threadMessaging"], 1000);
    assert.equal(inspection.kind, "inspect_thread");
    await suppressedRegistry.recordComplete(parent.threadId);
    suppressedBus.complete({ commandId: inspection.id, browserId: "browser", kind: "inspect_thread", ok: true,
      result: { status: "idle", users: [], workedSeconds: null, assistant: { synthetic: false, text: "Review done" } } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await suppressedBus.claim("browser", ["threadMessaging"], 0), undefined,
      "a review that finishes after its parent is marked complete cannot wake that parent");
    assert.ok((await suppressedJobs.job(suppressedJob.jobId)).notifiedAt,
      "the suppressed wake-up is finalized so it cannot retry forever");
  } finally { suppressedController.close(); suppressedBus.close(); }

  const duplicates = await Promise.all(Array.from({ length: 8 }, () => jobs.create(parent, "same-review-sha")));
  assert.equal(new Set(duplicates.map(job => job.jobId)).size, 1);
  const reopened = await SubagentJobRegistry.open(directory);
  assert.equal((await reopened.create(parent, "same-review-sha")).jobId, duplicates[0].jobId);
  assert.match((await reopened.job(duplicates[0].jobId)).preparationError, /interrupted/);
  await reopened.cancel(duplicates[0].jobId);
  await assert.rejects(reopened.complete(duplicates[0].jobId, "late"), /cancelled/);

  const legacyRoot = path.join(directory, "legacy-review-storage");
  const legacyDirectory = path.join(legacyRoot, "subagents");
  await mkdir(legacyDirectory, { recursive: true });
  const legacyJobId = "44444444-4444-4444-8444-444444444444";
  const legacyResultPath = path.join(legacyDirectory, `${legacyJobId}.md`);
  await writeFile(legacyResultPath, "Legacy review report\n");
  await writeFile(path.join(legacyDirectory, "jobs.json"), JSON.stringify({
    version: 1,
    jobs: [{
      jobId: legacyJobId,
      parentThreadId: parent.threadId,
      parentConversationUrl: parent.conversationUrl,
      childThreadId: child.threadId,
      childConversationUrl: child.conversationUrl,
      resultPath: legacyResultPath,
      state: "complete",
      createdAt: "2026-09-01T00:00:00.000Z",
      completedAt: "2026-09-01T00:01:00.000Z",
      notifiedAt: "2026-09-01T00:02:00.000Z",
      notificationAttempts: 0,
    }],
  }));
  const migratedJobs = await SubagentJobRegistry.open(legacyRoot);
  const migratedJob = await migratedJobs.job(legacyJobId);
  assert.equal(path.dirname(migratedJob.resultPath), path.join(legacyRoot, "reviews"),
    "legacy sub-agent storage migrates to reviewer-named storage without changing the internal job registry");
  assert.equal((await readFile(migratedJob.resultPath, "utf8")).trim(), "Legacy review report");
  const migratedStore = JSON.parse(await readFile(path.join(legacyRoot, "reviews", "jobs.json"), "utf8"));
  assert.equal(migratedStore.jobs[0].resultPath, migratedJob.resultPath,
    "the canonical reviewer store persists the migrated report path");

  const registry = await RalphRegistry.open(path.join(directory, "ralph"), 1);
  await registry.register(parent.conversationUrl, { agentCreated: true });
  await registry.scheduleNow(parent.threadId);
  const handlers = new Map();
  const toolJobs = await SubagentJobRegistry.open(path.join(directory, "tools"));
  const toolBus = new SupportCommandBus();
  let preparations = 0;
  registerChatGptAgents({ registerResource() {}, registerTool(name, definition, handler) { handlers.set(name, handler); } },
    toolBus, { async binding({ sessionId }) { return sessionId === "owner" ? parent : sessionId === "child" ? child : undefined; } },
    registry, toolJobs, { markPrepared() { preparations += 1; } }, async () => {}, "grant", "");
  const owner = { requestId: "review", _meta: { "openai/session": "owner" } };
  try {
    assert.deepEqual([...handlers.keys()].sort(), ["list_reviewers", "review_done", "send_thread_message", "start_reviewer", "start_thread"]);
    assert.equal((await handlers.get("start_reviewer")({ message: "review" }, { requestId: "unsynced" })).isError, true);
    const start = handlers.get("start_reviewer")({ message: "Review this PR at exact SHA" }, owner);
    const command = await toolBus.claim("browser", ["threadMessaging"], 1000);
    assert.match(command.message, /read-only/);
    assert.match(command.message, /GitHub COMMENT review/);
    toolBus.complete({ commandId: command.id, browserId: "browser", kind: "send_message", ok: true, result: { status: "sent", conversationUrl: child.conversationUrl } });
    const started = await start;
    assert.match(started.content[0].text, /End this turn now/);
    assert.equal(preparations, 1);
    assert.equal(await toolBus.claim("browser", ["threadPreparation"], 0), undefined, "new reviewer tabs need no redundant preparation command");
    const reviewJob = started.structuredContent.reviews[0];
    assert.equal(reviewJob.conversationUrl, child.conversationUrl);
    const listed = await handlers.get("list_reviewers")({}, owner);
    assert.equal(listed.structuredContent.reviews.some(review => review.conversationUrl === child.conversationUrl), true);
    assert.match(listed.content[0].text, new RegExp(child.conversationUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((await handlers.get("start_reviewer")({ message: "another" }, { ...owner, requestId: "another" })).isError, true);
    assert.equal((await handlers.get("start_thread")({ message: "nested" }, { _meta: { "openai/session": "child" } })).isError, true);
    assert.equal((await handlers.get("review_done")({ jobId: reviewJob.jobId, result: "report" }, owner)).isError, true, "the parent cannot submit the reviewer's report");
    const ralph = new RalphController({ registry, commands: toolBus, jobs: toolJobs, model: "unused", auditLogPath: path.join(directory, "audit.log"), checkEveryMs: 60_000 });
    try {
      await registry.setMode(parent.threadId, "continuous");
      await registry.scheduleNow(parent.threadId);
      await ralph.tick();
      await new Promise(resolve => setTimeout(resolve, 10));
      // Child may be inspected, but the parent may not be inspected or continued.
      const pendingCommand = await toolBus.claim("browser", ["ralph"], 0);
      if (pendingCommand) {
        assert.equal(pendingCommand.conversationUrl, child.conversationUrl);
        toolBus.complete({ commandId: pendingCommand.id, browserId: "browser", kind: "inspect_thread", ok: true, result: { status: "running" } });
      }
    } finally { ralph.close(); }
    const explicit = handlers.get("start_thread")({ message: "Explicit user-requested task" }, { ...owner, requestId: "new-thread" });
    const newThread = await toolBus.claim("browser", ["threadMessaging"], 1000);
    assert.equal(newThread.message, "Explicit user-requested task", "explicit threads receive no child transport or review instructions");
    toolBus.complete({ commandId: newThread.id, browserId: "browser", kind: "send_message", ok: true, result: { status: "sent", conversationUrl: "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333" } });
    assert.equal((await explicit).isError, undefined);
    assert.equal((await toolJobs.all()).length, 1, "explicit thread creation creates no review job");
  } finally { toolBus.close(); }

  const checkpointRegistry = await RalphRegistry.open(path.join(directory, "checkpoint"), 1);
  await checkpointRegistry.register(parent.conversationUrl, { agentCreated: true });
  const checkpointBus = new SupportCommandBus();
  const ralph = new RalphController({ registry: checkpointRegistry, commands: checkpointBus, model: "unused", auditLogPath: path.join(directory, "checkpoint-audit.log"), checkEveryMs: 60_000 });
  const inspectCheckpoint = async (text) => {
    await checkpointRegistry.scheduleNow(parent.threadId);
    await ralph.tick();
    const inspection = await checkpointBus.claim("browser", ["ralph"], 1000);
    checkpointBus.complete({ commandId: inspection.id, browserId: "browser", kind: "inspect_thread", ok: true,
      result: { status: "idle", workedSeconds: null, users: [{ id: "user", text: "Implement the feature" }], assistant: { id: "assistant", synthetic: false, text } } });
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  try {
    await inspectCheckpoint("Checkpoint saved\nRALPH_STATUS: CONTINUE");
    const resume = await checkpointBus.claim("browser", ["ralph"], 1000);
    assert.equal(resume.kind, "send_message", "a short unfinished turn bypasses the worked-time classifier threshold");
    checkpointBus.complete({ commandId: resume.id, browserId: "browser", kind: "send_message", ok: true, result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await new Promise(resolve => setTimeout(resolve, 10));
    await inspectCheckpoint("Checkpoint saved\nRALPH_STATUS: CONTINUE");
    assert.equal(await checkpointBus.claim("browser", ["ralph"], 0), undefined, "an unchanged checkpoint cannot trigger another send");
    await inspectCheckpoint("CI pending\nRALPH_STATUS: WAIT_CI");
    assert.equal(await checkpointBus.claim("browser", ["ralph"], 0), undefined);
    const waitingThread = (await checkpointRegistry.threads())[0];
    assert.ok(waitingThread.nextCheckAt >= Date.now() + 290_000, "CI polling backs off for five minutes");
    const persisted = await RalphRegistry.open(path.join(directory, "checkpoint"));
    assert.equal((await persisted.threads())[0].checkpointWakeAt, waitingThread.checkpointWakeAt);
    const realNow = Date.now;
    Date.now = () => realNow() + 301_000;
    try {
      await inspectCheckpoint("CI pending\nRALPH_STATUS: WAIT_CI");
      const checkCi = await checkpointBus.claim("browser", ["ralph"], 1000);
      assert.match(checkCi.message, /Inspect CI once/);
      checkpointBus.complete({ commandId: checkCi.id, browserId: "browser", kind: "send_message", ok: true, result: { status: "sent", conversationUrl: parent.conversationUrl } });
      await new Promise(resolve => setTimeout(resolve, 10));
    } finally { Date.now = realNow; }
    await inspectCheckpoint("Need access\nRALPH_STATUS: BLOCKED");
    assert.equal(await checkpointRegistry.isActive(parent.threadId), false);
  } finally { ralph.close(); checkpointBus.close(); }

  const recoveryJobs = await SubagentJobRegistry.open(path.join(directory, "recovery"));
  const recoveryBus = new SupportCommandBus(undefined, undefined, undefined, registry, recoveryJobs);
  const recovery = reviewActionHandler(recoveryJobs, registry, recoveryBus, async () => {}, "test-token");
  const requestAction = async (jobId, body, authorized = true) => {
    let status = 200;
    let result;
    await recovery({ params: { jobId }, body, get(name) { return name === "authorization" && authorized ? "Bearer test-token" : undefined; } },
      { status(value) { status = value; return this; }, json(value) { result = value; }, setHeader() {} });
    return { status, result };
  };
  try {
    const staleSend = recoveryBus.execute({ feature: "ralph", kind: "send_message", targetUrl: parent.conversationUrl, message: "stale continuation" });
    const staleRejection = assert.rejects(staleSend, /paused for review/);
    const pending = await recoveryJobs.create(parent);
    assert.equal(await recoveryBus.claim("browser", ["ralph"], 0), undefined, "a queued continuation is discarded when review starts before delivery");
    await staleRejection;
    assert.equal((await requestAction(pending.jobId, { action: "cancel" }, false)).status, 401);
    assert.equal((await requestAction(pending.jobId, { action: "cancel" })).status, 200,
      "unknown reviewer startup can always be cancelled locally");
    assert.equal((await recoveryJobs.job(pending.jobId)).state, "cancelled");

    const errored = await recoveryJobs.create(parent);
    await recoveryJobs.recordPreparationFailure(errored.jobId, "unconfirmed startup");
    assert.equal((await requestAction(errored.jobId, { action: "complete" })).status, 200,
      "an errored reviewer can always be marked complete locally");
    assert.equal((await recoveryJobs.job(errored.jobId)).resolution, "completed_manually");

    const known = await recoveryJobs.create(parent);
    await recoveryJobs.assignChild(known.jobId, child);
    const cancel = requestAction(known.jobId, { action: "cancel" });
    const stop = await recoveryBus.claim("browser", ["threadMessaging"], 1000);
    assert.equal(stop.kind, "stop_thread");
    assert.equal((await cancel).status, 200, "browser stop failure cannot block local review cancellation");
    assert.equal((await recoveryJobs.job(known.jobId)).state, "cancelled");
    recoveryBus.complete({ commandId: stop.id, browserId: "browser", kind: "stop_thread", ok: false, error: "cannot confirm stop" });

    const undelivered = await recoveryJobs.create(parent);
    await recoveryJobs.complete(undelivered.jobId, "report");
    await recoveryJobs.recordNotificationFailure(undelivered.jobId, "failed", 1);
    assert.equal((await requestAction(undelivered.jobId, { action: "retry" })).status, 200);
    assert.equal((await recoveryJobs.job(undelivered.jobId)).notificationAbandonedAt, undefined);
  } finally { recoveryBus.close(); }

  const operationBus = new SupportCommandBus(undefined, 30, 15);
  try {
    const pendingSend = operationBus.execute(
      { feature: "threadMessaging", kind: "send_message", targetUrl: parent.conversationUrl, message: "abandoned" },
      60_000,
      { operation: { label: "Send thread message", parentThreadId: parent.threadId } },
    );
    const [operation] = operationBus.operations();
    assert.equal(operation.label, "Send thread message");
    assert.equal(operation.state, "queued");
    assert.equal(operationBus.cancel(operation.id), true);
    await assert.rejects(pendingSend, /cancelled by user/i,
      "a visible queued operation can be stopped before it sends");
    assert.deepEqual(operationBus.operations(), []);
  } finally { operationBus.close(); }

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

    const normalSend = cooldownBus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: parent.conversationUrl, message: "normal" });
    const normal = await cooldownBus.claim("browser", ["threadMessaging"], 0);
    assert.equal(normal.message, "normal", "pacing turns off after the deferred backlog is drained");
    cooldownBus.complete({ commandId: normal.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: parent.conversationUrl } });
    await normalSend;
  } finally { cooldownBus.close(); }

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

  console.log("Reviewer tests passed: sequential handoff, explicit threads, checkpoints, cancellation, restart recovery, and rate-limit queueing.");
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("subagent-limits-"));
  await rm(directory, { recursive: true, force: true });
}
