import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentJobRegistry } from "../dist/subagent-jobs.js";
import { RalphController, RalphRegistry, SubagentResultController, SupportCommandBus, taskActionHandler } from "../dist/chatgpt-support.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "task-test-"));
const jobs = await SubagentJobRegistry.open(directory);
const parent = { threadId: "11111111-1111-4111-8111-111111111111", conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111" };
const child = { threadId: "22222222-2222-4222-8222-222222222222", conversationUrl: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" };
try {
  const registry = await RalphRegistry.open(path.join(directory, "ralph"), 1);
  await registry.register(child.conversationUrl, { agentCreated: true });
  const unreported = await jobs.create({ threadId: "api:unreported" });
  await jobs.assignChild(unreported.jobId, child);
  const bus = new SupportCommandBus(undefined, undefined, 0);
  await registry.setLoopIntervalSeconds(1800);
  const monitor = new SubagentResultController(jobs, bus, async () => {}, registry, 60_000);
  const inspect = async status => {
    await monitor.tick();
    const command = await bus.claim("browser", ["threadMessaging"], 1000);
    assert.equal(command.kind, "inspect_thread");
    bus.complete({ commandId: command.id, browserId: "browser", kind: "inspect_thread", ok: true,
      result: status === "idle" ? { status, users: [], workedSeconds: null, assistant: { synthetic: false, text: "Stopped before reporting" } } : { status } });
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  const realNow = Date.now;
  try {
    await monitor.tick();
    assert.equal(await bus.claim("browser", ["threadMessaging"], 0), undefined, "workers are not inspected before thirty minutes");
    Date.now = () => realNow() + 1800_001;
    await inspect("running");
    assert.equal((await jobs.job(unreported.jobId)).state, "pending", "a running worker remains pending");
    assert.equal(await bus.claim("browser", ["threadMessaging"], 0), undefined, "running work receives no continuation");
    Date.now = () => realNow() + 3600_100;
    await inspect("idle");
    const resumed = await bus.claim("browser", ["threadMessaging"], 0);
    assert.ok(resumed, "an idle unfinished worker must receive a continuation");
    assert.equal(resumed.kind, "send_message", "a worker that stops without a report resumes instead of being declared complete");
    assert.match(resumed.message, /rename/);
    bus.complete({ commandId: resumed.id, browserId: "browser", kind: "send_message", ok: true,
      result: { status: "sent", conversationUrl: child.conversationUrl } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await jobs.job(unreported.jobId)).state, "pending");
    await writeFile(unreported.resultPath + ".tmp", "Completed assigned check. PASS.\n");
    await rename(unreported.resultPath + ".tmp", unreported.resultPath);
    Date.now = () => realNow() + 5400_200;
    await monitor.tick();
    assert.equal((await jobs.job(unreported.jobId)).state, "complete");
    assert.match(await readFile(unreported.resultPath, "utf8"), /PASS/);
    await monitor.tick();
    assert.equal(await registry.isActive(child.threadId), false);
    assert.equal(await bus.claim("browser", ["threadMessaging"], 0), undefined, "completion never sends a parent wake-up");
  } finally { Date.now = realNow; monitor.close(); bus.close(); }
  const legacyRoot = path.join(directory, "legacy-task-storage");
  const legacyDirectory = path.join(legacyRoot, "subagents");
  await mkdir(legacyDirectory, { recursive: true });
  const legacyJobId = "44444444-4444-4444-8444-444444444444";
  const legacyResultPath = path.join(legacyDirectory, `${legacyJobId}.md`);
  await writeFile(legacyResultPath, "Legacy task report\n");
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
  assert.equal(path.dirname(migratedJob.resultPath), await realpath(path.join(legacyRoot, "tasks")),
    "legacy sub-agent storage migrates to worker-named storage without changing the internal job registry");
  assert.equal((await readFile(migratedJob.resultPath, "utf8")).trim(), "Legacy task report");
  const migratedStore = JSON.parse(await readFile(path.join(legacyRoot, "tasks", "jobs.json"), "utf8"));
  assert.equal(migratedStore.jobs[0].resultPath, migratedJob.resultPath,
    "the canonical worker store persists the migrated report path");
  await migratedJobs.close();

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
  const recoveryBus = new SupportCommandBus(undefined, undefined, undefined, undefined, registry, recoveryJobs);
  const recovery = taskActionHandler(recoveryJobs, registry, recoveryBus, async () => {
    await recoveryBus.claim("browser-launch", ["threadMessaging"], 0);
  }, "test-token");
  const requestAction = async (jobId, body, authorized = true) => {
    let status = 200;
    let result;
    await recovery({ params: { jobId }, body, get(name) { return name === "authorization" && authorized ? "Bearer test-token" : undefined; } },
      { status(value) { status = value; return this; }, json(value) { result = value; }, setHeader() {} });
    return { status, result };
  };
  try {
    const pending = await recoveryJobs.create(parent);
    assert.equal((await requestAction(pending.jobId, { action: "cancel" }, false)).status, 401);
    assert.equal((await requestAction(pending.jobId, { action: "cancel", confirmedStopped: true })).status, 409);
    await recoveryJobs.recordPreparationFailure(pending.jobId, "unconfirmed startup");
    assert.equal((await requestAction(pending.jobId, { action: "cancel" })).status, 409);
    assert.equal((await requestAction(pending.jobId, { action: "cancel", confirmedStopped: true })).status, 200);
    const known = await recoveryJobs.create(parent);
    await recoveryJobs.assignChild(known.jobId, child);
    const cancel = requestAction(known.jobId, { action: "cancel" });
    const stop = await recoveryBus.claim("browser", ["threadMessaging"], 1000);
    assert.equal(stop.kind, "stop_thread");
    recoveryBus.complete({ commandId: stop.id, browserId: "browser", kind: "stop_thread", ok: false, error: "cannot confirm stop" });
    assert.equal((await cancel).status, 409);
    assert.equal((await recoveryJobs.job(known.jobId)).state, "pending");
    const retryCancel = requestAction(known.jobId, { action: "cancel" });
    const confirmed = await recoveryBus.claim("browser", ["threadMessaging"], 1000);
    recoveryBus.complete({ commandId: confirmed.id, browserId: "browser", kind: "stop_thread", ok: true, result: { status: "stopped", conversationUrl: child.conversationUrl } });
    assert.equal((await retryCancel).status, 200);
    assert.equal((await requestAction(known.jobId, { action: "retry" })).status, 400, "parent notification retries no longer exist");
  } finally { recoveryBus.close(); await recoveryJobs.close(); }
  console.log("Task service passed: missing reports, resumed workers, operator cancellation, migration, and continuation checkpoints.");
} finally {
  await jobs.close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("task-test-"));
  await rm(directory, { recursive: true, force: true });
}
