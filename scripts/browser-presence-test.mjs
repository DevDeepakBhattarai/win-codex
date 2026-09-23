import assert from 'node:assert/strict';
import { SupportCommandBus } from '../dist/chatgpt-support.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const url = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';

let launches = 0;
const launchAwareBus = new SupportCommandBus(undefined, undefined, undefined, async () => { launches += 1; });
try {
  await launchAwareBus.claim('helium', [], 0, undefined, [url]);
  const observed = launchAwareBus.execute({ feature: 'ralph', kind: 'inspect_thread', conversationUrl: url });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0, 'inspection must not launch Chrome when Helium already has the thread');
  const observedCommand = await launchAwareBus.claim('helium', [], 0, undefined, [url]);
  launchAwareBus.complete({ commandId: observedCommand.id, browserId: 'helium', kind: observedCommand.kind,
    ok: true, result: { status: 'running' } });
  await observed;

  const send = launchAwareBus.execute({ feature: 'ralph', kind: 'send_message', targetUrl: url, message: 'continue' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 1, 'message delivery still launches the Chrome executor when only an observer is present');
  const sendCommand = await launchAwareBus.claim('chrome', ['ralph'], 0);
  launchAwareBus.complete({ commandId: sendCommand.id, browserId: 'chrome', kind: sendCommand.kind,
    ok: true, result: { status: 'sent', conversationUrl: url } });
  await send;
} finally {
  launchAwareBus.close();
}

const fallbackLaunchBus = new SupportCommandBus(undefined, undefined, undefined, async () => { launches += 1; });
try {
  await fallbackLaunchBus.claim('helium-fallback', [], 0, undefined, []);
  const fallback = fallbackLaunchBus.execute({ feature: 'ralph', kind: 'inspect_thread', conversationUrl: url });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 2, 'inspection launches Chrome only after no browser reports the thread');
  const command = await fallbackLaunchBus.claim('chrome-fallback', ['ralph'], 0);
  fallbackLaunchBus.complete({ commandId: command.id, browserId: 'chrome-fallback', kind: command.kind,
    ok: true, result: { status: 'running' } });
  await fallback;
} finally {
  fallbackLaunchBus.close();
}

let backgroundLaunches = 0;
const backgroundBus = new SupportCommandBus(undefined, undefined, undefined, async () => { backgroundLaunches += 1; });
try {
  await backgroundBus.ensureBackgroundBrowserOnce('ralph');
  await backgroundBus.ensureBackgroundBrowserOnce('ralph');
  assert.equal(backgroundLaunches, 1, 'background RALPH may launch Chrome once, but must not keep spawning windows while no executor claims it');
  await backgroundBus.claim('chrome-background', ['ralph'], 0);
  await backgroundBus.ensureBackgroundBrowserOnce('ralph');
  assert.equal(backgroundLaunches, 1, 'an executor claim clears the outstanding background launch without opening another window');
} finally {
  backgroundBus.close();
}

const bus = new SupportCommandBus();
try {
  await bus.claim('helium', [], 0, undefined, [url]);
  const result = bus.execute({ feature: 'ralph', kind: 'inspect_thread', conversationUrl: url });
  result.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await bus.claim('chrome', ['ralph'], 0), undefined,
    'Chrome must not open a duplicate when Helium already has the thread');
  const command = await bus.claim('helium', [], 0, undefined, [url]);
  assert.equal(command?.kind, 'inspect_thread');
  bus.complete({ commandId: command.id, browserId: 'helium', kind: command.kind,
    ok: true, result: { status: 'running', title: 'Live Helium title' } });
  assert.equal((await result).result.title, 'Live Helium title');

  const send = bus.execute({ feature: 'ralph', kind: 'send_message', targetUrl: url, message: 'continue' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await bus.claim('helium', [], 0, undefined, [url]), undefined, 'observers cannot send');
  const sent = await bus.claim('chrome', ['ralph'], 0);
  bus.complete({ commandId: sent.id, browserId: 'chrome', kind: 'send_message', ok: true,
    result: { status: 'sent', conversationUrl: url } });
  await send;

  const preparation = bus.execute({ feature: 'threadPreparation', kind: 'prepare_thread', conversationUrl: url });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await bus.claim('helium', [], 0, undefined, [url]), undefined,
    'observer-only browsers must never claim executor preparation');
  const preparationCommand = await bus.claim('chrome-preparer', ['threadPreparation'], 0);
  assert.equal(preparationCommand?.kind, 'prepare_thread');
  bus.complete({ commandId: preparationCommand.id, browserId: 'chrome-preparer', kind: preparationCommand.kind,
    ok: true, result: { status: 'prepared', conversationUrl: url } });
  await preparation;

  await bus.claim('helium', [], 0, undefined, []);
  const fallback = bus.execute({ feature: 'ralph', kind: 'inspect_thread', conversationUrl: url });
  await new Promise(resolve => setImmediate(resolve));
  const reopened = await bus.claim('chrome', ['ralph'], 0);
  assert.equal(reopened?.kind, 'inspect_thread', 'closed observer tabs allow Chrome fallback');
  bus.complete({ commandId: reopened.id, browserId: 'chrome', kind: reopened.kind,
    ok: true, result: { status: 'running' } });
  await fallback;

  const originalNow = Date.now;
  try {
    await bus.claim('helium', [], 0, undefined, [url]);
    const now = Date.now();
    Date.now = () => now + 91_000;
    const stale = bus.execute({ feature: 'ralph', kind: 'inspect_thread', conversationUrl: url });
    await new Promise(resolve => setImmediate(resolve));
    const claimed = await bus.claim('chrome', ['ralph'], 0);
    assert.equal(claimed?.kind, 'inspect_thread', 'disconnected browsers cannot retain ownership indefinitely');
    bus.complete({ commandId: claimed.id, browserId: 'chrome', kind: claimed.kind,
      ok: true, result: { status: 'running' } });
    await stale;
  } finally { Date.now = originalNow; }
} finally {
  bus.close();
}

const ownerHandoffBus = new SupportCommandBus();
try {
  await ownerHandoffBus.claim('helium-handoff', [], 0, undefined, [url]);
  const handoff = ownerHandoffBus.execute({ feature: 'ralph', kind: 'inspect_thread', conversationUrl: url });
  await new Promise(resolve => setImmediate(resolve));
  const chromeWait = ownerHandoffBus.claim('chrome-handoff', ['ralph'], 1000, undefined, [url]);
  await new Promise(resolve => setImmediate(resolve));
  await ownerHandoffBus.claim('helium-handoff', [], 0, undefined, []);
  const handoffCommand = await chromeWait;
  assert.equal(handoffCommand?.kind, 'inspect_thread', 'inspection moves immediately to another browser that still owns the thread');
  ownerHandoffBus.complete({ commandId: handoffCommand.id, browserId: 'chrome-handoff', kind: handoffCommand.kind,
    ok: true, result: { status: 'running' } });
  await handoff;
} finally {
  ownerHandoffBus.close();
}

let ownershipLossLaunches = 0;
const ownershipLossBus = new SupportCommandBus(undefined, undefined, undefined, async () => { ownershipLossLaunches += 1; });
try {
  await ownershipLossBus.claim('helium-race', [], 0, undefined, [url]);
  const inspection = ownershipLossBus.execute({ feature: 'ralph', kind: 'inspect_thread', conversationUrl: url });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ownershipLossLaunches, 0, 'an observed thread does not launch Chrome while its owner is present');
  await ownershipLossBus.claim('helium-race', [], 0, undefined, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ownershipLossLaunches, 1, 'losing the last observed owner launches the Chrome inspection fallback');
  const fallbackCommand = await ownershipLossBus.claim('chrome-race', ['ralph'], 0);
  assert.equal(fallbackCommand?.kind, 'inspect_thread');
  ownershipLossBus.complete({ commandId: fallbackCommand.id, browserId: 'chrome-race', kind: fallbackCommand.kind,
    ok: true, result: { status: 'running' } });
  await inspection;
} finally {
  ownershipLossBus.close();
}

const source = await readFile('support-extension/service-worker.js', 'utf8');
let now = 1_000_000;
let health = 'ok';
let clicks = 0;
let reloads = 0;
let creations = 0;
const results = [];
const presenceClaims = [];
const storage = {};
const config = { extensionToken: 'x'.repeat(40) };
for (const [key, route] of Object.entries({ bindUrl: '/thread-sync/bind', commandClaimUrl: '/chatgpt-support/commands/claim',
  commandResultUrl: '/chatgpt-support/commands/result', threadObserveUrl: '/chatgpt-support/threads/observe',
  ralphRegisterUrl: '/chatgpt-support/ralph/register' })) config[key] = `http://127.0.0.1:6002${route}`;
function worker() {
  const context = {
    URL, AbortSignal, AbortController, crypto: globalThis.crypto, Response, console,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => setTimeout(fn, ms === 250 ? 0 : ms), clearTimeout,
    importScripts() {}, LOCAL_CODEX_THREAD_SYNC: config,
    browser: {
      runtime: { id: 'x', onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      storage: { local: {
        async get(query) { return typeof query === 'string' ? { [query]: storage[query] } : { ...query, threadSync: false, ...storage }; },
        async set(values) { Object.assign(storage, values); },
      } },
      scripting: { async executeScript() {} },
      tabs: {
        async query() { return [{ id: 7, url, status: 'complete' }]; },
        async get() { return { id: 7, url, status: 'complete' }; },
        async create() { creations++; throw new Error('must reuse existing tab'); },
        async reload() { reloads++; },
        async sendMessage(_id, { command }) {
          if (command.kind === 'page_health') return { ok: true, result: { status: health } };
          if (command.kind === 'dismiss_rate_limit') { clicks++; health = 'ok'; return { ok: true, result: { status: 'dismissed' } }; }
          return { ok: true, result: { status: 'running', title: 'Helium title' } };
        },
      },
    },
    async fetch(endpoint, options) {
      if (endpoint === config.commandClaimUrl) {
        presenceClaims.push(JSON.parse(options.body));
        return new Response(null, { status: 204 });
      }
      assert.equal(endpoint, config.commandResultUrl);
      results.push(JSON.parse(options.body));
      return new Response('', { status: 200 });
    },
  };
  vm.runInNewContext(source, context);
  return context;
}
let context = worker();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(presenceClaims.at(-1).openThreads, [], 'an idle observer publishes empty presence before stopping its poll loop');
const inspect = () => context.executeCommand({ id: String(now), kind: 'inspect_thread', feature: 'ralph', conversationUrl: url,
  refreshRevision: 'external-change' }, 'helium');
await context.executeCommand({ id: 'observer-prepare', kind: 'prepare_thread', feature: 'threadPreparation', conversationUrl: url }, 'helium');
assert.equal(results.at(-1).ok, false, 'observer-only workers reject executor preparation commands');
assert.match(results.at(-1).error, /only available for thread observation/);
await inspect();
assert.equal(results.at(-1).result.title, 'Helium title');
assert.equal(reloads, 0, 'Helium observation never refreshes for its own external revision');
health = 'rate_limited';
await inspect();
assert.match(results.at(-1).error, /CHATGPT_RATE_LIMITED/);
now += 599_999;
await inspect();
assert.equal(clicks, 0, 'Got It must not be clicked before ten minutes');
assert.equal(reloads, 0, 'rate-limited tabs must not reload');
context = worker();
await new Promise(resolve => setImmediate(resolve));
now += 1;
await inspect();
assert.equal(clicks, 1, 'persisted cooldown survives a worker restart and permits dismissal at ten minutes');
assert.equal(results.at(-1).ok, true);
health = 'recoverable_error';
await inspect();
assert.equal(reloads, 1, 'recognized timeout errors reload the existing tab');
now += 120_000;
await inspect();
assert.equal(reloads, 1, 'persistent errors cannot cause a reload on every RALPH tick');
assert.equal(creations, 0);

let listener;
let domClicks = 0;
let noticeText = 'Too many requests. Got It';
const notice = {
  get textContent() { return noticeText; }, getClientRects: () => [{}],
  querySelectorAll: () => [{ textContent: 'Got It', click() { domClicks++; } }],
};
const page = {
  document: { title: 'ChatGPT', querySelector: () => null,
    querySelectorAll: selector => selector.includes('[role="alert"]') ? [notice] : [] },
  location: new URL(url), window: { addEventListener() {} },
  browser: { runtime: { async sendMessage() {}, onMessage: { addListener(fn) { listener = fn; } } } },
};
vm.runInNewContext(await readFile('support-extension/content-script.js', 'utf8'), page);
const pageCommand = kind => new Promise(resolve => listener({ type: 'local-codex-support/automation-v1', command: { kind } }, {}, resolve));
assert.equal((await pageCommand('page_health')).result.status, 'rate_limited');
assert.equal(domClicks, 0, 'observing a notice never dismisses it');
assert.equal((await pageCommand('dismiss_rate_limit')).result.status, 'dismissed');
assert.equal(domClicks, 1, 'dismissal clicks the Got It button inside the rate-limit notice');
noticeText = 'Request timed out. Please try again.';
assert.equal((await pageCommand('page_health')).result.status, 'recoverable_error');
assert.equal((await pageCommand('dismiss_rate_limit')).result.status, 'not_found');
console.log('Browser presence tests passed.');
