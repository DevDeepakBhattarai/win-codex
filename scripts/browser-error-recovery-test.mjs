import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("support-extension/service-worker.js", "utf8");
const url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const config = { extensionToken: "x".repeat(40) };
for (const [key, route] of Object.entries({ bindUrl: "/thread-sync/bind", commandClaimUrl: "/chatgpt-support/commands/claim",
  commandResultUrl: "/chatgpt-support/commands/result", threadObserveUrl: "/chatgpt-support/threads/observe",
  ralphRegisterUrl: "/chatgpt-support/ralph/register" })) config[key] = `http://127.0.0.1:6002${route}`;

async function worker(settings = {}, serverVoiceUrl) {
  const storage = { threadSync: false, automationExecutor: false, ralph: false, threadMessaging: false, ...settings };
  const calls = [];
  let listener;
  let clock = 1_800_000_000_000;
  let health = "connection_interrupted";
  let currentUrl = url;
  let navigateAfterStop = false;
  let stopGate;
  let stopError;
  let pendingMessage = false;
  let serviceOnline = true;
  const context = {
    URL, AbortSignal, AbortController, crypto: globalThis.crypto, Response, Error, console,
    Date: class extends Date { static now() { return clock; } },
    setTimeout, clearTimeout, importScripts() {}, LOCAL_CODEX_THREAD_SYNC: config,
    browser: {
      runtime: { id: "support", getPlatformInfo: async () => {},
        onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      storage: { local: {
        async get(query) { return typeof query === "string" ? { [query]: storage[query] } : { ...query, ...storage }; },
        async set(values) { Object.assign(storage, values); }, async remove(key) { delete storage[key]; },
      } },
      scripting: { async executeScript() {} },
      tabs: {
        async query() { return [{ id: 7, url: currentUrl, status: "complete" }]; },
        async get() { return { id: 7, url: currentUrl, status: "complete" }; },
        async create() { assert.fail("Recovery must not open a Chrome copy of a Helium chat"); },
        async reload() { assert.fail("Recovery must not refresh the chat"); },
        async sendMessage(tabId, { command }) {
          assert.equal(tabId, 7);
          calls.push(command.kind);
          if (command.kind === "page_health") return { ok: true, result: { status: health } };
          if (command.kind === "stop_thread") {
            if (stopGate) await stopGate;
            if (stopError) return { ok: false, error: stopError };
            if (navigateAfterStop) currentUrl = url.replace("11111111", "22222222");
            return { ok: true, result: { status: "stopped" } };
          }
          if (command.kind === "send_message") { health = "ok"; return { ok: true, result: { status: "sent" } }; }
          if (command.kind === "dismiss_rate_limit") { health = "ok"; return { ok: true, result: { status: "dismissed" } }; }
          if (command.kind === "recover_page") { health = "ok"; return { ok: true, result: { status: "recovery_started" } }; }
          assert.fail(`Unexpected command ${command.kind}`);
        },
      },
    },
    async fetch(endpoint, options) {
      await new Promise(resolve => setImmediate(resolve));
      if (!serviceOnline) throw new Error("Local service unavailable");
      const request = JSON.parse(options.body);
      if (request.recoveryReservation?.action === "acquire") return pendingMessage ? new Response(null, { status: 409 }) :
        new Response(JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expiresAt: clock + 540_000 }));
      return endpoint === config.ralphRegisterUrl ? new Response(JSON.stringify({ status: "ignored" })) : new Response(null, {
        status: 204, headers: { "X-Voice-Conversation-Url": serverVoiceUrl ?? "", "X-Recovery-Message-Pending": String(pendingMessage) },
      });
    },
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInNewContext("pollGeneration += 1; pollController?.abort(); voicePollController?.abort();", context);
  context.sleep = async () => {};
  const notify = message => new Promise(resolve => listener({ type: "local-codex-support/ralph-reactivate-v1",
    conversationUrl: url, activity: "blocked", interrupted: true, ...message },
    { id: "support", frameId: 0, tab: { id: 7 } }, resolve));
  return { calls, storage, context, notify,
    async settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); },
    setHealth(value) { health = value; }, advance(ms) { clock += ms; },
    navigateAfterStop() { navigateAfterStop = true; },
    holdStop(gate) { stopGate = gate; }, failStop(error) { stopError = error; },
    setServerVoice(value) { serverVoiceUrl = value; }, setPendingMessage(value) { pendingMessage = value; },
    disconnect() { serviceOnline = false; },
  };
}

const helium = await worker();
assert.equal((await helium.notify()).ok, true);
await helium.settle();
assert.deepEqual(helium.calls, ["page_health", "stop_thread", "send_message"],
  "An interrupted user chat must stop and resume in Helium even when its Chrome executor and RALPH are disabled");
for (const automationExecutor of [false, true]) {
  const run = await worker({ automationExecutor });
  run.setHealth("recoverable_error");
  await run.notify({ interrupted: false, pageHealth: "recoverable_error" });
  await run.settle();
  assert.deepEqual(run.calls, ["page_health", "stop_thread", "send_message"], "Page errors recover in the browser that reports them, including user-owned Chrome tabs");
}

const disabled = await worker({ errorRecovery: false, automationExecutor: true, threadMessaging: true });
await disabled.notify();
await disabled.settle();
assert.deepEqual(disabled.calls, [], "The local error recovery toggle disables unsolicited recovery");

const protectedChat = await worker({ voiceConversationUrl: url });
await protectedChat.notify();
await protectedChat.settle();
assert.deepEqual(protectedChat.calls, [], "Text recovery cannot interrupt the configured Voice conversation");

const protectedFromChrome = await worker({}, url);
await protectedFromChrome.notify();
await protectedFromChrome.settle();
assert.deepEqual(protectedFromChrome.calls, [], "Helium learns the server's Voice binding even when it never claimed a Voice command");

const freshBinding = await worker();
await freshBinding.context.syncAutomationPause();
freshBinding.setServerVoice(url);
await freshBinding.notify();
await freshBinding.settle();
assert.deepEqual(freshBinding.calls, [], "A Voice binding committed within the five-second pause cache window prevents observer recovery immediately");

const queuedInChrome = await worker();
queuedInChrome.setPendingMessage(true);
await queuedInChrome.notify();
await queuedInChrome.settle();
assert.deepEqual(queuedInChrome.calls, ["page_health"], "Helium yields to a Chrome message rather than racing its delivery");

const queuedDuringStop = await worker();
let releaseQueuedStop;
queuedDuringStop.holdStop(new Promise(resolve => { releaseQueuedStop = resolve; }));
await queuedDuringStop.notify();
await queuedDuringStop.settle();
assert.equal(queuedDuringStop.calls.at(-1), "stop_thread");
queuedDuringStop.setPendingMessage(true);
releaseQueuedStop();
await queuedDuringStop.settle();
assert.equal(queuedDuringStop.calls.includes("send_message"), false, "A message queued in Chrome during Stop suppresses Helium's continuation");

const unavailableService = await worker();
await unavailableService.context.syncAutomationPause();
unavailableService.disconnect();
await unavailableService.notify();
await unavailableService.settle();
assert.deepEqual(unavailableService.calls, [], "Recovery cannot use cached protection when the current server status is unavailable");

const pendingVoiceBinding = await worker({ voiceConversationUrl: url }, url.replace("11111111", "22222222"));
await pendingVoiceBinding.notify();
await pendingVoiceBinding.settle();
assert.deepEqual(pendingVoiceBinding.calls, [], "A stale poll cannot overwrite protection recorded by a new Voice binding probe");

const duplicate = await worker();
let releaseStop;
duplicate.holdStop(new Promise(resolve => { releaseStop = resolve; }));
await duplicate.notify();
await duplicate.notify();
releaseStop();
await duplicate.settle();
assert.equal(duplicate.calls.filter(kind => kind === "send_message").length, 1, "Concurrent notices cannot send two continuations");

const navigated = await worker();
navigated.navigateAfterStop();
await navigated.notify();
await navigated.settle();
assert.equal(navigated.calls.includes("send_message"), false, "A tab that navigates during Stop cannot receive the continuation for its previous chat");

const failedStop = await worker();
failedStop.failStop("Stop did not finish");
await failedStop.notify();
await failedStop.settle();
assert.equal(failedStop.calls.includes("send_message"), false, "A failed Stop cannot send a continuation");

const limited = await worker();
limited.setHealth("rate_limited");
await limited.notify({ interrupted: false, pageHealth: "rate_limited" });
await limited.settle();
assert.deepEqual(limited.calls, ["page_health"], "A rate limit starts a cooldown without sending or dismissing");
limited.advance(599_999);
await assert.rejects(limited.context.recoverPage(7), /Waiting ten minutes/);
assert.deepEqual(limited.calls, ["page_health"]);
limited.advance(1);
await limited.context.pollCommands(vm.runInNewContext("pollGeneration", limited.context));
await limited.settle();
assert.deepEqual(limited.calls, ["page_health", "page_health", "dismiss_rate_limit", "page_health", "stop_thread", "send_message"],
  "An observer's normal cooldown poll dismisses the notice and resumes once in place after ten minutes");
assert.equal(Object.keys(limited.storage["pageRecovery:7"]).length, 0);

const legacyCooldown = await worker({ "pageRecovery:7": { rateLimitedAt: 1_800_000_000_000 - 60_000 } });
legacyCooldown.setHealth("recoverable_error");
await legacyCooldown.context.recoverPage(7);
assert.deepEqual(legacyCooldown.calls, ["page_health", "stop_thread", "send_message"], "A legacy cooldown without a conversation association cannot block another chat");

const emptyChat = await worker({ "pageRecovery:7": { conversationUnavailableAt: 1_800_000_000_000 - 300_001, conversationUnavailableUrl: url } });
emptyChat.setHealth("conversation_unavailable");
await emptyChat.context.pollCommands(vm.runInNewContext("pollGeneration", emptyChat.context));
assert.deepEqual(emptyChat.calls, ["page_health", "recover_page"], "Helium retries its empty conversation in place after the shared cooldown");
console.log("Browser error recovery tests passed.");
