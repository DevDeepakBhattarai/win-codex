import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import vm from "node:vm";
import express from "express";
import { RalphRegistry, SupportCommandBus, supportCommandClaimHandler } from "../dist/chatgpt-support.js";
import { createVoiceApi } from "../dist/voice-api.js";

const source = await readFile("support-extension/service-worker.js", "utf8");
const url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const token = "x".repeat(40);
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recovery-reservation-"));
  const registry = await RalphRegistry.open(directory);
  const bus = new SupportCommandBus(undefined, undefined, undefined, undefined, registry);
  const app = express();
  app.use(express.json());
  app.post("/chatgpt-support/commands/claim", supportCommandClaimHandler(bus, token));
  app.use("/chatgpt-support/voice", createVoiceApi({ token, registry, commands: bus }));
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { extensionToken: token };
  for (const [key, route] of Object.entries({ bindUrl: "/thread-sync/bind", commandClaimUrl: "/chatgpt-support/commands/claim",
    commandResultUrl: "/chatgpt-support/commands/result", threadObserveUrl: "/chatgpt-support/threads/observe",
    ralphRegisterUrl: "/chatgpt-support/ralph/register" })) config[key] = base + route;
  const storage = { threadSync: false, automationExecutor: false, ralph: false, threadMessaging: false };
  const calls = [];
  let inject = async () => {};
  let loseStopResponse = false;
  let reservation;
  const request = (route, body, method = "POST") => fetch(base + route, { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const context = {
    URL, AbortSignal, AbortController, crypto: globalThis.crypto, Response, Error, console, Date,
    setTimeout, clearTimeout, importScripts() {}, LOCAL_CODEX_THREAD_SYNC: config,
    browser: {
      runtime: { id: "support", getPlatformInfo: async () => {}, onMessage: { addListener() {} },
        onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      storage: { local: {
        async get(query) { return typeof query === "string" ? { [query]: storage[query] } : { ...query, ...storage }; },
        async set(values) { Object.assign(storage, values); },
      } },
      scripting: { async executeScript() { await inject(calls.at(-1)); } },
      tabs: {
        async query() { return []; }, async get() { return { id: 7, url, status: "complete" }; },
        async create() { assert.fail("Recovery cannot create another browser tab"); },
        async reload() { assert.fail("Recovery cannot reload this chat"); },
        async sendMessage(_tabId, { command }) {
          calls.push(command.kind);
          if (command.kind === "page_health") return { ok: true, result: { status: "recoverable_error" } };
          assert.ok(command.recoveryExpiresAt > Date.now(), "Side effects carry the server reservation deadline");
          if (command.kind === "stop_thread" && loseStopResponse) throw new Error("Message port closed after delivery");
          return { ok: true, result: { status: command.kind === "stop_thread" ? "stopped" : "sent" } };
        },
      },
    },
    async fetch(endpoint, options) {
      if (endpoint !== config.commandClaimUrl) return new Response(null, { status: 204 });
      const response = await fetch(endpoint, options);
      if (JSON.parse(options.body).recoveryReservation?.action === "acquire" && response.ok) reservation = await response.clone().json();
      return response;
    },
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInNewContext("pollGeneration += 1; pollController?.abort(); voicePollController?.abort();", context);
  context.sleep = async () => {};
  return { bus, registry, context, calls, request, get reservation() { return reservation; },
    onInjection(callback) { inject = callback; }, loseStop() { loseStopResponse = true; },
    async close() {
      bus.close();
      await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(directory), os.tmpdir());
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const races = await fixture();
try {
  races.onInjection(async previous => {
    if (previous === "page_health") {
      const response = await races.request("/chatgpt-support/voice", { conversationUrl: url }, "PUT");
      assert.equal(response.status, 409, "Voice cannot commit between recovery preflight and Stop");
      assert.equal(races.registry.voiceConversationUrl(), undefined);
    }
    if (previous === "stop_thread") {
      await assert.rejects(races.bus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: url, message: "New parent prompt" }),
        /not sent/, "A server message created after the last status read cannot race the continuation");
    }
  });
  await races.context.recoverPage(7);
  assert.deepEqual(races.calls, ["page_health", "stop_thread", "send_message"]);
  assert.equal(await races.bus.claim("chrome", ["threadMessaging"], 0), undefined, "The losing message is never claimable");
  const later = races.bus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: url, message: "Retry after recovery" });
  const claimed = await races.bus.claim("chrome", ["threadMessaging"], 1000);
  assert.equal(claimed.kind, "send_message", "Confirmed recovery releases the reservation for a later request");
  races.bus.complete({ commandId: claimed.id, browserId: "chrome", kind: claimed.kind, ok: true, result: { status: "sent", conversationUrl: url } });
  await later;
} finally { await races.close(); }

const binding = await fixture();
try {
  const configure = binding.request("/chatgpt-support/voice", { conversationUrl: url }, "PUT");
  const probe = await binding.bus.claim("voice-browser", ["voice"], 1000);
  assert.equal(probe.kind, "voice_status");
  await assert.rejects(binding.bus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: url, message: "Competing prompt" }), /not sent/,
    "A pending Voice configuration also blocks a new server message");
  await assert.rejects(binding.context.recoverPage(7), /reservation was unavailable/);
  assert.deepEqual(binding.calls, ["page_health"], "An uncommitted Voice probe protects the target before Stop");
  binding.bus.complete({ commandId: probe.id, browserId: "voice-browser", kind: probe.kind, ok: true, result: { status: "closed", conversationUrl: url } });
  assert.equal((await configure).status, 200);
  assert.equal(binding.registry.voiceConversationUrl(), url);
} finally { await binding.close(); }

const stopping = await fixture();
try {
  const operation = stopping.bus.execute({ feature: "threadMessaging", kind: "stop_thread", targetUrl: url });
  const command = await stopping.bus.claim("chrome", ["threadMessaging"], 1000);
  assert.equal((await stopping.request("/chatgpt-support/voice", { conversationUrl: url }, "PUT")).status, 409,
    "Voice cannot bind over an already dispatched text Stop");
  stopping.bus.complete({ commandId: command.id, browserId: "chrome", kind: command.kind, ok: true,
    result: { status: "stopped", conversationUrl: url } });
  await operation;
} finally { await stopping.close(); }

const queued = await fixture();
try {
  const sending = queued.bus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: url, message: "Original prompt" });
  const browserId = await queued.context.getBrowserId();
  const command = await queued.bus.claim(browserId, ["threadMessaging"], 1000);
  await assert.rejects(queued.context.recoverPage(7), /reservation was unavailable/);
  assert.deepEqual(queued.calls, ["page_health"], "An observer yields to an already claimed send");
  await queued.context.recoverPage(7, false, command.id);
  assert.deepEqual(queued.calls, ["page_health", "page_health", "stop_thread"], "The browser owning the original command can recover without adding a continuation");
  queued.bus.complete({ commandId: command.id, browserId, kind: command.kind, ok: true, result: { status: "sent", conversationUrl: url } });
  await sending;
} finally { await queued.close(); }

const uncertain = await fixture();
try {
  uncertain.loseStop();
  await assert.rejects(uncertain.context.recoverPage(7), /Message port closed/);
  await assert.rejects(uncertain.bus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: url, message: "Must wait" }), /not sent/,
    "An uncertain side effect retains its reservation until the page deadline");
  const response = await uncertain.request("/chatgpt-support/voice", { conversationUrl: url }, "PUT");
  assert.equal(response.status, 409);
} finally { await uncertain.close(); }

const expired = await fixture();
try {
  expired.onInjection(async previous => {
    if (previous === "page_health") expired.context.Date = class extends Date { static now() { return expired.reservation.expiresAt; } };
  });
  await assert.rejects(expired.context.recoverPage(7), /reservation expired/);
  assert.deepEqual(expired.calls, ["page_health"], "An extension delayed past its reservation cannot click Stop");
  await expired.registry.pauseAutomation();
  assert.throws(() => expired.bus.reserveRecovery("helium", url), /conflicts/, "A recovery action cannot acquire permission during the shared pause");
} finally { await expired.close(); }

const pausing = await fixture();
const pause = pausing.bus.pauseAutomation(Date.now() + 150);
try {
  assert.throws(() => pausing.bus.reserveRecovery("helium", url), /conflicts/,
    "A pause already being persisted must win over a new reservation");
  await pause;
  const message = pausing.bus.execute({ feature: "threadMessaging", kind: "send_message", targetUrl: url, message: "Continue after the pause" });
  const command = await pausing.bus.claim("chrome", ["threadMessaging"], 1000);
  assert.equal(command.kind, "send_message", "The waiting message remains claimable after the pause");
  pausing.bus.complete({ commandId: command.id, browserId: "chrome", kind: command.kind, ok: true,
    result: { status: "sent", conversationUrl: url } });
  await message;
} finally { await pause; await pausing.close(); }

const expiryBus = new SupportCommandBus();
try {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const lease = expiryBus.reserveRecovery("helium", url);
  assert.throws(() => expiryBus.reserveRecovery("chrome", url), /conflicts/);
  expiryBus.releaseRecovery("chrome", url, lease.id);
  assert.throws(() => expiryBus.reserveRecovery("chrome", url), /conflicts/, "Another browser cannot release a reservation");
  mock.timers.tick(lease.expiresAt - Date.now() + 1);
  assert.notEqual(expiryBus.reserveRecovery("chrome", url).id, lease.id, "A crashed browser's reservation expires");
} finally { mock.timers.reset(); expiryBus.close(); }
console.log("Recovery reservations passed: post-preflight conflicts, pending Voice probes, claimed sends, uncertain delivery, and expiry.");
