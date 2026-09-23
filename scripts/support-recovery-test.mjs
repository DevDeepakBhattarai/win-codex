import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const workerScript = await readFile("support-extension/service-worker.js", "utf8");
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

async function runWorker(command, responses) {
  const results = [];
  let dispatches = 0;
  let reloads = 0;
  const storage = {};
  const context = {
    URL, AbortSignal, AbortController, crypto: globalThis.crypto, Response,
    setTimeout, clearTimeout, console, importScripts() {},
    LOCAL_CODEX_THREAD_SYNC: config,
    browser: {
      runtime: {
        id: "a".repeat(32), getPlatformInfo: async () => {},
        onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      },
      tabs: {
        onUpdated: { addListener() {} }, query: async () => [],
        create: async () => ({ id: 11 }),
        get: async () => ({ id: 11, status: "complete", url }),
        reload: async () => { reloads += 1; },
        sendMessage: async () => {
          const response = responses[dispatches++];
          if (response instanceof Error) throw response;
          return response;
        },
        remove: async () => {},
      },
      webNavigation: { onHistoryStateUpdated: { addListener() {} }, onCommitted: { addListener() {} } },
      scripting: { executeScript: async () => {} },
      storage: { local: {
        async get(query) { return typeof query === "string" ? { [query]: storage[query] } : { ...query, ...storage }; },
        async set(values) { Object.assign(storage, values); },
      } },
    },
    fetch: async (_endpoint, options) => {
      results.push(JSON.parse(options.body));
      return new Response("", { status: 200 });
    },
  };
  vm.runInNewContext(workerScript, context);
  await context.executeCommand(command, "browser-a");
  return { results, dispatches, reloads };
}

function inspectCommand(id) {
  return { id, feature: "ralph", kind: "inspect_thread", conversationUrl: url };
}

function sendCommand(id) {
  return { id, feature: "threadMessaging", kind: "send_message", targetUrl: url, message: "Continue" };
}

{
  const run = await runWorker(inspectCommand("page-error"), [
    { ok: false, error: "Message delivery failed." },
    { ok: true, result: { status: "running" } },
  ]);
  assert.equal(run.reloads, 1, "a page error refreshes the thread once");
  assert.equal(run.dispatches, 2, "inspection resumes after refresh");
  assert.equal(run.results[0].ok, true);
}

{
  const run = await runWorker(inspectCommand("repeated-error"), [
    { ok: false, error: "Stream interrupted." },
    { ok: false, error: "Stream interrupted." },
  ]);
  assert.equal(run.reloads, 1, "a second failure does not cause a refresh loop");
  assert.equal(run.results[0].ok, false);
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
  assert.equal(run.reloads, 1, "an uncertain send still refreshes the broken page");
  assert.equal(run.dispatches, 1, "an uncertain send must not duplicate the message");
  assert.equal(run.results[0].ok, false);
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
    type: "local-codex-support/automation-v1", command: { kind: "inspect_thread" },
  }, {}, resolve));
  assert.equal(response.ok, false);
  assert.match(response.error, /Message delivery failed/);
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
  assert.equal(response.ok, false);
  assert.match(response.error, /did not become ready for inspection/,
    "a timed-out inspection must reach the worker's refresh path");
}

console.log("Support recovery tests passed.");
