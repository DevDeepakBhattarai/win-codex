import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const workerScript = await readFile(process.argv[2] ?? "support-extension/service-worker.js", "utf8");
const contentScript = await readFile("support-extension/content-script.js", "utf8");
const url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const config = {
  bindUrl: "http://127.0.0.1:3000/thread-sync/bind",
  commandClaimUrl: "http://127.0.0.1:3000/chatgpt-support/commands/claim",
  commandResultUrl: "http://127.0.0.1:3000/chatgpt-support/commands/result",
  threadObserveUrl: "http://127.0.0.1:3000/chatgpt-support/threads/observe",
  ralphRegisterUrl: "http://127.0.0.1:3000/chatgpt-support/ralph/register",
  extensionToken: "x".repeat(32),
};

async function runWorker(command, responses, healthResponses = [], injectionFailures = [], temporary = false, globalPause = false, recoveryPhase, duplicateTabs = false) {
  const results = [];
  const protectionAtResult = [];
  let dispatches = 0;
  let reloads = 0;
  let removals = 0;
  const calls = [];
  const deliveredMessages = [];
  let releaseRecovery;
  let recoveryEntered;
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
  const recoveryStarted = new Promise(resolve => { recoveryEntered = resolve; });
  const waits = [];
  let tabUrl = url + (temporary ? "?temporary-chat=true" : "");
  let activeInjectionFailures = [];
  let clock = 1_800_000_000_000;
  let sharedPauseUntil = globalPause === "restart" ? clock + 300_000 : 0;
  let serviceOnline = true;
  const storage = globalPause === "restart" ? { automationPausedUntil: sharedPauseUntil } : {};
  if (duplicateTabs) storage.voiceConversationUrl = url.replace("11111111", "22222222");
  if (globalPause === "stale") storage["pageRecovery:11"] = { conversationUnavailableAt: clock - 300_001, conversationUnavailableUrl: tabUrl };
  let messageListener;
  const dispatchTimes = [];
  const context = {
    Date: globalPause ? class extends Date { static now() { return clock; } } : Date,
    URL, AbortSignal, AbortController, crypto: globalThis.crypto, Response, Error,
    setTimeout, clearTimeout, console, importScripts() {},
    LOCAL_CODEX_THREAD_SYNC: config,
    browser: {
      runtime: {
        id: "a".repeat(32), getPlatformInfo: async () => {},
        onMessage: { addListener(listener) { messageListener = listener; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      },
      tabs: {
        onUpdated: { addListener() {} }, query: async () => [{ id: 11, status: "complete", url: tabUrl },
          ...(duplicateTabs ? [{ id: 12, status: "complete", url: tabUrl }] : [])],
        create: async () => ({ id: 11 }),
        get: async () => ({ id: 11, status: "complete", url: tabUrl }),
        reload: async () => { reloads += 1; },
        update: async () => {},
        sendMessage: async (_tabId, payload) => {
          calls.push(payload.command.kind);
          if (payload.command.kind === "send_message") deliveredMessages.push(payload.command.message);
          dispatchTimes.push(clock);
          if (recoveryPhase && payload.command.kind === (recoveryPhase === "stopping" ? "stop_thread" : "send_message")) {
            recoveryEntered();
            await recoveryGate;
          }
          if (payload.command.kind === "page_health") {
            const response = healthResponses.shift();
            if (response instanceof Error) throw response;
            return response ?? { ok: true, result: { status: "ok" } };
          }
          const response = responses[dispatches++];
          if (response instanceof Error) throw response;
          return response;
        },
        remove: async () => { removals += 1; },
      },
      webNavigation: { onHistoryStateUpdated: { addListener() {} }, onCommitted: { addListener() {} } },
      scripting: { executeScript: async () => { const failure = activeInjectionFailures.shift(); if (failure) throw failure; } },
      storage: { local: {
        async get(query) { return typeof query === "string" ? { [query]: storage[query] } : { ...query, threadSync: false, ...storage }; },
        async set(values) { Object.assign(storage, values); },
      } },
    },
    fetch: async (endpoint, options) => {
      if (globalPause && endpoint === config.commandClaimUrl) {
        if (!serviceOnline) throw new Error("Local service unavailable");
        const request = JSON.parse(options.body);
        if (request.conversationUnavailable && sharedPauseUntil <= clock) {
          sharedPauseUntil = Math.min(request.automationPausedUntil ?? clock + 300_000, clock + 300_000);
        }
        return new Response(null, { status: 204, headers: { "X-Automation-Paused-Until": String(sharedPauseUntil > clock ? sharedPauseUntil : 0) } });
      }
      if (endpoint !== config.commandResultUrl) return new Response(null, { status: 204 });
      protectionAtResult.push(storage.voiceConversationUrl);
      results.push(JSON.parse(options.body));
      return new Response("", { status: 200 });
    },
  };
  vm.runInNewContext(workerScript, context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInNewContext("pollGeneration += 1; pollController?.abort();", context);
  activeInjectionFailures = injectionFailures;
  context.restartPolling = () => {};
  context.sleep = async ms => { waits.push(ms); if (globalPause) clock += ms; };
  context.getSettings = async () => ({ threadSync: true, automationExecutor: true });
  const background = recoveryPhase ? context.recoverPage(11) : undefined;
  if (background) await recoveryStarted;
  const execution = context.executeCommand(command, "browser-a");
  if (command.feature === "voice" && background) await execution;
  releaseRecovery();
  await Promise.all([background, execution]);
  return { results, protectionAtResult, dispatches, reloads, removals, calls, deliveredMessages, waits, dispatchTimes, storage,
    closeThread() { return context.closeOwnedThreadTab(url); },
    advanceTime(ms) { clock += ms; },
    setServiceOnline(online) { serviceOnline = online; },
    syncPause() { return context.syncAutomationPause(); },
    notifyUnavailable(nextUrl) {
      tabUrl = nextUrl;
      return new Promise(resolve => messageListener({ type: "local-codex-support/conversation-unavailable-v1", conversationUrl: nextUrl },
        { id: "a".repeat(32), frameId: 0, tab: { id: 11 }, url: nextUrl }, resolve));
    },
  };
}

{
  const run = await runWorker({ id: "voice-pending-recovery", feature: "voice", kind: "voice_status", targetUrl: url }, [
    { ok: true, result: { status: "closed", conversationUrl: url } },
    { ok: true, result: { status: "stopped", conversationUrl: url } },
    { ok: true, result: { status: "sent", conversationUrl: url } },
  ], [{ ok: true, result: { status: "connection_interrupted" } }], [], false, false, "stopping");
  assert.equal(run.results[0].ok, true);
  assert.equal(run.protectionAtResult[0], url, "the extension protects the target before acknowledging its status probe");
  assert.deepEqual(run.calls, ["page_health", "stop_thread", "voice_status"], "protecting Voice prevents an already pending recovery from resuming the text turn");
}

{
  const run = await runWorker({ id: "voice-duplicate-config", feature: "voice", kind: "voice_status", targetUrl: url }, [], [], [], false, false, undefined, true);
  assert.equal(run.results[0].ok, false);
  assert.match(run.results[0].error, /multiple tabs/);
  assert.equal(run.storage.voiceConversationUrl, url.replace("11111111", "22222222"), "a rejected new target keeps the previous chat protected");
  assert.equal(run.dispatches, 0);
}

for (const kind of ["voice_start", "voice_stop"]) {
  const run = await runWorker({ id: kind, feature: "voice", kind, targetUrl: url }, [
    { ok: true, result: { status: kind === "voice_start" ? "active" : "closed", conversationUrl: url } },
  ], [], [], false, "restart");
  assert.equal(run.results[0].ok, true);
  assert.equal(run.reloads, 0, "Voice controls never refresh the conversation");
  assert.deepEqual(run.calls, [kind], "Voice bypasses page recovery and the worker automation pause");
  assert.equal(run.dispatchTimes[0], 1_800_000_000_000);
  run.storage.automationThreadTabsV1 = { [url]: 11 };
  assert.equal((await run.closeThread()).status, "not_owned", "worker cleanup cannot close the dedicated Voice tab");
  assert.equal(run.removals, 0);
}
{
  const run = await runWorker({ id: "voice-failed-stop", feature: "voice", kind: "voice_stop", targetUrl: url }, [
    { ok: false, error: "End Voice unavailable" },
  ]);
  assert.equal(run.results[0].ok, false);
  assert.equal(run.reloads, 0, "a failed Voice stop does not reload or replay the call");
  assert.equal(run.removals, 0, "a failed stop preserves the tab for recovery");
}

function inspectCommand(id) {
  return { id, feature: "ralph", kind: "inspect_thread", conversationUrl: url };
}

function sendCommand(id) {
  return { id, feature: "threadMessaging", kind: "send_message", targetUrl: url, message: "Continue" };
}

{
  const run = await runWorker({ ...inspectCommand("empty-conversation"), conversationUrl: url + "?temporary-chat=true" }, [
    { ok: true, result: { status: "recovery_started" } }, { ok: true, result: { status: "running" } },
  ], [{ ok: true, result: { status: "conversation_unavailable" } }], [], true, true);
  assert.equal(run.reloads, 0, "an empty temporary conversation is never refreshed");
  assert.deepEqual(run.calls, ["page_health", "recover_page", "inspect_thread"]);
  assert.equal(run.dispatchTimes[1] - run.dispatchTimes[0], 300_000, "Retry waits for the entire shared five-minute pause");
  assert.equal(run.results[0].result.status, "running", "the original request continues after the pause");
}
{
  const run = await runWorker(inspectCommand("restart-during-pause"), [{ ok: true, result: { status: "running" } }], [], [], false, "restart");
  assert.ok(run.dispatchTimes.every(time => time >= 1_800_000_300_000), "a restarted extension performs no page checks before the persisted deadline");
  assert.equal(run.results[0].result.status, "running");
}

{
  const run = await runWorker(inspectCommand("healthy-after-pause"), [{ ok: true, result: { status: "running" } }], [], [], false, "stale");
  assert.equal(run.storage["pageRecovery:11"]?.conversationUnavailableAt, undefined, "healthy pages clear old recovery markers instead of being checked forever");
  assert.equal((await run.notifyUnavailable(url)).ok, true);
  const firstUntil = run.storage.automationPausedUntil;
  run.advanceTime(300_001);
  const nextUrl = url.replace("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  assert.equal((await run.notifyUnavailable(nextUrl)).ok, true);
  assert.ok(run.storage.automationPausedUntil > firstUntil, "a different failed conversation in the same tab starts a fresh pause after the first expires");
}

{
  const run = await runWorker(inspectCommand("service-outage"), [{ ok: true, result: { status: "running" } }], [], [], false, "outage");
  run.setServiceOnline(false);
  await run.notifyUnavailable(url);
  const originalUntil = run.storage.automationPausedUntil;
  assert.equal(run.storage.automationPausePending, true);
  run.advanceTime(120_000);
  run.setServiceOnline(true);
  await run.syncPause();
  assert.equal(run.storage.automationPausedUntil, originalUntil, "reconnecting after an outage preserves the original five-minute deadline");
  assert.equal(run.storage.automationPausePending, false);
}

for (const kind of ["inspect_thread", "prepare_thread"]) {
  const run = await runWorker({ id: `health-${kind}`, feature: kind === "inspect_thread" ? "ralph" : "threadPreparation",
    kind, conversationUrl: url }, [{ ok: true, result: { status: "running" } }], [
    new Error("Timed out waiting for ChatGPT page automation."),
    { ok: true, result: { status: "ok" } },
  ]);
  assert.equal(run.reloads, 1, "page-health failures refresh the existing tab");
  assert.equal(run.results[0].ok, true);
  assert.equal(run.results[0].result.status, kind === "inspect_thread" ? "running" : "prepared");
}

for (const temporary of [false, true]) {
  const target = url + (temporary ? "?temporary-chat=true" : "");
  const run = await runWorker({ ...inspectCommand("stuck-stream"), conversationUrl: target }, [
    { ok: true, result: { status: "stopped", conversationUrl: target } },
    { ok: true, result: { status: "sent", conversationUrl: target } },
    { ok: true, result: { status: "running" } },
  ], Array.from({ length: 4 }, () => ({ ok: true, result: { status: "connection_interrupted" } })), [], temporary);
  assert.equal(run.reloads, 0, "stuck streams stop and continue in the same chat without reloads");
  assert.deepEqual(run.waits.filter(ms => ms === 30_000), []);
  assert.deepEqual(run.calls, ["page_health", "stop_thread", "send_message", "inspect_thread"], "Stop is confirmed before one continuation");
  assert.equal(run.results[0].result.status, "running", "the original inspection observes the resumed turn");
}
{
  const temporaryUrl = url + "?temporary-chat=true";
  const run = await runWorker({ ...inspectCommand("finishes-during-recovery"), conversationUrl: temporaryUrl }, [
    { ok: true, result: { status: "idle", conversationUrl: temporaryUrl } },
    { ok: true, result: { status: "sent", conversationUrl: temporaryUrl } },
    { ok: true, result: { status: "idle" } },
  ], Array.from({ length: 4 }, () => ({ ok: true, result: { status: "connection_interrupted" } })), [], true);
  assert.equal(run.results[0].result.status, "idle", "an already-finished recovery result reaches the original inspection");
  assert.equal(run.reloads, 0);
}
{
  const run = await runWorker(inspectCommand("uncertain-recovery"), [{ ok: true, result: { status: "stopped" } }, new Error("Acknowledgement lost after recovery Send")],
    [{ ok: true, result: { status: "connection_interrupted" } }]);
  assert.equal(run.reloads, 0, "uncertain recovery preserves the existing conversation");
  assert.equal(run.calls.filter(kind => kind === "send_message").length, 1, "uncertain recovery never resends immediately");
  assert.equal(run.results[0].result.status, "loading");
}

for (const kind of ["connection_interrupted", "recoverable_error"]) {
  const run = await runWorker({ ...sendCommand("recover-send"), targetUrl: url + "?temporary-chat=true" }, [
    { ok: true, result: { status: "stopped", conversationUrl: url } },
    { ok: true, result: { status: "sent", conversationUrl: url } },
  ], [{ ok: true, result: { status: kind } }], [], true);
  assert.deepEqual(run.calls, ["page_health", "stop_thread", "send_message"], "a pending message replaces recovery continuation without duplicate sends");
  assert.equal(run.reloads, 0);
  assert.equal(run.results[0].ok, true);
}

{
  const run = await runWorker({ ...sendCommand("queued-during-stop"), targetUrl: url + "?temporary-chat=true" }, [
    { ok: true, result: { status: "stopped" } }, { ok: true, result: { status: "sent", conversationUrl: url } },
  ], [{ ok: true, result: { status: "connection_interrupted" } }], [], true, false, "stopping");
  assert.equal(run.calls.filter(kind => kind === "stop_thread").length, 1);
  assert.equal(run.reloads, 0);
  assert.deepEqual(run.deliveredMessages, ["Continue"], "a queued message supersedes background continuation while Stop is in flight");
  assert.equal(run.results[0].ok, true);
}
{
  const run = await runWorker({ ...sendCommand("queued-after-recovery-send"), targetUrl: url + "?temporary-chat=true" }, [
    { ok: true, result: { status: "stopped" } }, { ok: true, result: { status: "sent", conversationUrl: url } },
  ], [{ ok: true, result: { status: "connection_interrupted" } }], [], true, false, "sending");
  assert.deepEqual(run.deliveredMessages, ["Continue the existing task from its current state. Do not repeat completed work."], "an irreversible recovery send never receives a second queued prompt");
  assert.equal(run.results[0].ok, false);
  assert.equal(run.results[0].deliveryUncertain, false, "the original queued message definitely was not dispatched");
  assert.match(run.results[0].error, /queued message was not sent/);
}

{
  const run = await runWorker(inspectCommand("persistently-blocked"), [], [
    { ok: true, result: { status: "recoverable_error" } },
    { ok: true, result: { status: "recoverable_error" } },
  ]);
  assert.equal(run.reloads, 0);
  assert.equal(run.dispatches, 1, "failed recovery remains loading rather than complete without a second send");
  assert.equal(run.calls.includes("inspect_thread"), false, "a still-blocked page is never inspected as complete");
  assert.equal(run.results[0].result.status, "loading");
}


{
  const run = await runWorker(inspectCommand("inspection-timeout"), [
    new Error("Timed out waiting for ChatGPT page automation."),
    { ok: true, result: { status: "running" } },
  ]);
  assert.equal(run.reloads, 1, "an inspection timeout refreshes the same tab once");
  assert.equal(run.results[0].ok, true);
  assert.equal(run.results[0].result.status, "running");
}

{
  const run = await runWorker(inspectCommand("page-error"), [
    { ok: false, error: "Message delivery failed." },
    { ok: true, result: { status: "running" } },
  ]);
  assert.equal(run.reloads, 1, "an inspection refreshes a failed page");
  assert.equal(run.dispatches, 2, "inspection repeats on the refreshed tab");
  assert.equal(run.results[0].ok, true);
  assert.equal(run.results[0].result.status, "running");
}

{
  const run = await runWorker(inspectCommand("repeated-error"), [
    { ok: false, error: "Stream interrupted." },
    { ok: false, error: "Stream interrupted." },
  ]);
  assert.equal(run.reloads, 1, "a persistent failure does not cause a refresh loop");
  assert.equal(run.dispatches, 2);
  assert.equal(run.results[0].result.status, "loading");
}

for (const failure of [new Error("Timed out waiting for ChatGPT page automation."),
  { ok: false, error: "ChatGPT did not confirm that the child run stopped." }]) {
  const run = await runWorker({ id: "stop-recovery", feature: "threadMessaging", kind: "stop_thread", targetUrl: url }, [
    failure, { ok: true, result: { status: "stopped", conversationUrl: url } },
  ]);
  assert.equal(run.reloads, 1, "a failed stop refreshes the same tab");
  assert.equal(run.dispatches, 2, "stop state is checked again after refresh");
  assert.equal(run.results[0].ok, true);
  assert.equal(run.results[0].result.status, "stopped");
}

{
  const run = await runWorker(inspectCommand("rate-limit"), [
    { ok: false, error: "CHATGPT_RATE_LIMITED: Too many messages." },
  ]);
  assert.equal(run.reloads, 0, "rate limits must back off without refreshing");
  assert.equal(run.dispatches, 1);
}

{
  const run = await runWorker(sendCommand("send-rate-limit"), [
    { ok: false, error: "CHATGPT_RATE_LIMITED: Too many messages.", retryable: true },
  ]);
  assert.equal(run.reloads, 0, "a rate-limited send must not refresh or retry");
  assert.equal(run.dispatches, 1);
}

{
  const run = await runWorker(sendCommand("uncertain-send"), [new Error("The message port closed after delivery.")]);
  assert.equal(run.reloads, 0, "an uncertain send preserves the worker that may already be running");
  assert.equal(run.dispatches, 1, "an uncertain send must not duplicate the message");
  assert.equal(run.results[0].ok, false);
  assert.equal(run.results[0].deliveryUncertain, true, "lost acknowledgement preserves uncertain delivery");
}

{
  const run = await runWorker(sendCommand("failed-before-send"), [
    { ok: false, error: "ChatGPT send button did not become actionable.", retryable: true },
    { ok: false, error: "ChatGPT send button did not become actionable.", retryable: true },
  ]);
  assert.equal(run.dispatches, 2);
  assert.equal(run.results[0].ok, false);
  assert.equal(run.results[0].deliveryUncertain, false, "a persistent pre-Send failure remains definitely unsent");
}

{
  const run = await runWorker(sendCommand("unsent-message"), [
    { ok: false, error: "Composer did not load.", retryable: true },
    { ok: true, result: { status: "sent", conversationUrl: url } },
  ]);
  assert.equal(run.reloads, 1);
  assert.equal(run.dispatches, 2, "a known unsent message is retried after refresh");
  assert.equal(run.results[0].ok, true);
}

{
  const run = await runWorker(sendCommand("receiver-setup-failure"), [
    { ok: true, result: { status: "sent", conversationUrl: url } },
  ], [], [undefined, new Error("Could not establish the page receiver.")]);
  assert.equal(run.reloads, 1);
  assert.equal(run.dispatches, 1, "failure before dispatch can retry without sending twice");
  assert.equal(run.results[0].ok, true);
}

{
  let listener;
  const alert = { textContent: "Message delivery failed.", getClientRects: () => [{}] };
  const document = {
    title: "ChatGPT", readyState: "complete",
    querySelector: () => null,
    querySelectorAll: selector => selector.includes('[role="alert"]') ? [alert] : [],
  };
  vm.runInNewContext(contentScript, {
    document, location: new URL(url), window: { addEventListener() {} },
    browser: { runtime: { async sendMessage() {}, onMessage: { addListener(value) { listener = value; } } } },
  });
  for (const kind of ["inspect_thread"]) {
    const response = await new Promise(resolve => listener({
      type: "local-codex-support/automation-v1", command: { kind },
    }, {}, resolve));
    assert.equal(response.ok, false);
    assert.match(response.error, /Message delivery failed/);
  }
}

{
  let listener;
  const alert = { textContent: "Message delivery failed.", getClientRects: () => [{}] };
  const document = {
    title: "ChatGPT", readyState: "complete",
    querySelector: () => null,
    querySelectorAll: selector => selector.includes('[role="alert"]') ? [alert] : [],
  };
  vm.runInNewContext(contentScript, {
    document, location: new URL(url), window: { addEventListener() {} },
    browser: { runtime: { async sendMessage() {}, onMessage: { addListener(value) { listener = value; } } } },
  });
  const response = await new Promise(resolve => listener({
    type: "local-codex-support/automation-v1", command: { kind: "send_message", message: "Continue" },
  }, {}, resolve));
  assert.equal(response.ok, false);
  assert.equal(response.retryable, true, "a page error before Send is safe to retry");
}

{
  let listener;
  let now = 0;
  const document = {
    title: "ChatGPT", readyState: "complete",
    querySelector: () => null, querySelectorAll: () => [],
  };
  vm.runInNewContext(contentScript, {
    document, location: new URL(url), window: { addEventListener() {} },
    Date: { now: () => { now += 60_000; return now; } },
    setTimeout: callback => { callback(); return 1; },
    browser: { runtime: { async sendMessage() {}, onMessage: { addListener(value) { listener = value; } } } },
  });
  const response = await new Promise(resolve => listener({
    type: "local-codex-support/automation-v1", command: { kind: "inspect_thread" },
  }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.result.status, "loading", "an unready page is checked again later");
}

console.log("Support recovery tests passed.");
