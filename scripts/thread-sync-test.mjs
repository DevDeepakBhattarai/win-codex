import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { THREAD_SYNC_AGENT_INSTRUCTION, THREAD_SYNC_WIDGET_URI, ThreadSyncRegistry, parseConversationUrl, prepareThreadSync, registerThreadSync, threadSyncBindHandler, threadSyncBindUrl } from "../dist/thread-sync.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "win-codex-thread-sync-test-"));
const projectId = "g-project-test";
const urlA = `https://chatgpt.com/g/${projectId}/c/11111111-1111-4111-8111-111111111111`;
const urlB = `https://chatgpt.com/g/${projectId}/c/12345678-abcd-4321-abcd-123456789abc`;
const idA = { ownerId: "grant-one", sessionId: "session-A" };
const idB = { ownerId: "grant-one", sessionId: "session-B" };
let client;
let server;

try {
  assert.equal(threadSyncBindUrl(), "http://127.0.0.1:6002/thread-sync/bind");
  assert.match(THREAD_SYNC_AGENT_INSTRUCTION, /first call sync_current_thread, then call get_current_thread_url/);
  assert.match(THREAD_SYNC_AGENT_INSTRUCTION, /get_current_thread_url is the only source of the URL/);
  assert.equal(threadSyncBindUrl(7002), "http://127.0.0.1:7002/thread-sync/bind");
  for (const port of [6000, 22, 5060, 6667, 10080]) {
    assert.throws(() => threadSyncBindUrl(port), /blocked by browsers/);
  }
  for (const port of [0, -1, 65536, 6002.5, NaN]) {
    assert.throws(() => threadSyncBindUrl(port), /integer between/);
  }
  const sync = await prepareThreadSync(temporaryRoot, 6002);
  const manifest = JSON.parse(await readFile(path.join(sync.extensionDirectory, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "http://127.0.0.1/*"]);
  assert.equal(manifest.version, "0.4.2");
  assert.equal(manifest.minimum_chrome_version, undefined, "thread sync is not tied to a Chrome-branded minimum");
  assert.deepEqual(manifest.permissions, ["scripting"]);
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'self'; connect-src http://127.0.0.1:*");
  const preparedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), preparedConfig);
  const registry = sync.registry;
  const [a, b, againA] = await Promise.all([registry.context(idA), registry.context(idB), registry.context(idA)]);
  assert.equal(a.ticket.token, againA.ticket.token, "repeated sync calls reuse the pending ticket");
  assert.notEqual(a.ticket.token, b.ticket.token);
  await Promise.all([registry.bind(b.ticket.token, urlB), registry.bind(a.ticket.token, urlA)]);
  assert.equal((await registry.context(idA)).conversationUrl, urlA);
  assert.equal((await registry.context(idB)).conversationUrl, urlB);
  assert.equal((await registry.bind(a.ticket.token, urlA)).conversationUrl, urlA, "replay is idempotent");
  await assert.rejects(registry.bind(a.ticket.token, urlB), /different conversation/);
  const c = await registry.context({ ...idA, sessionId: "session-C" });
  await assert.rejects(registry.bind(c.ticket.token, urlA), /different session/);
  assert.equal((await registry.context({ ...idA, ownerId: "another-grant" })).status, "syncing", "OAuth grants cannot read each other's mapping");
  const reopened = await ThreadSyncRegistry.open(temporaryRoot);
  assert.equal((await reopened.context(idA)).conversationUrl, urlA, "bindings survive a registry reload");
  assert.equal((await reopened.context({ ...idA, sessionId: "session-C" })).ticket.token, c.ticket.token, "pending sync survives a registry reload");
  for (const url of ["https://evil.example/c/123", "https://chatgpt.com.evil.example/c/123", "http://chatgpt.com/c/123", "https://chatgpt.com/", "https://chatgpt.com/share/123", urlA.replace("https://", "https://user:pass@")]) {
    assert.throws(() => parseConversationUrl(url));
  }
  assert.equal(parseConversationUrl(urlA + "?test=1#bottom").conversationUrl, urlA);
  assert.equal(parseConversationUrl(urlA).projectId, projectId);
  assert.equal(parseConversationUrl(urlA.replace(`/g/${projectId}`, "")).projectId, undefined);

  const handler = threadSyncBindHandler(registry, sync.extensionToken);
  async function request(body, authorization = `Bearer ${sync.extensionToken}`, origin = "chrome-extension://" + "a".repeat(32)) {
    const result = { status: 200, body: undefined };
    const req = { body, get: key => ({ authorization, origin })[key] };
    const res = {
      status(code) { result.status = code; return this; },
      json(value) { result.body = value; return this; },
      setHeader() {},
    };
    await handler(req, res, error => { throw error; });
    return result;
  }
  assert.equal((await request({ token: a.ticket.token, conversationUrl: urlA }, "Bearer wrong")).status, 401);
  assert.equal((await request({ token: a.ticket.token, conversationUrl: urlA }, sync.extensionToken)).status, 401);
  assert.equal((await request({ token: a.ticket.token, conversationUrl: urlA }, undefined, "https://chatgpt.com")).status, 403);
  assert.equal((await request({ token: a.ticket.token, conversationUrl: urlA, extra: "unexpected" })).status, 400);
  assert.equal((await request({ token: "x".repeat(43), conversationUrl: urlA })).status, 409);
  assert.equal((await request({ token: a.ticket.token, conversationUrl: urlB })).status, 409);
  assert.deepEqual((await request({ token: a.ticket.token, conversationUrl: urlA })).body, { status: "bound" });
  assert.deepEqual((await request({ token: a.ticket.token, conversationUrl: urlA }, `Bearer ${sync.extensionToken}`, "moz-extension://thread-sync-test")).body,
    { status: "bound" }, "standard non-Chrome WebExtension origins are accepted");

  // Exercise actual MCP metadata forwarding without opening an HTTP listener.
  server = new McpServer({ name: "thread-sync-test", version: "1" });
  registerThreadSync(server, sync, "mcp-grant");
  client = new Client({ name: "thread-sync-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  const syncDefinition = tools.find(tool => tool.name === "sync_current_thread");
  const getDefinition = tools.find(tool => tool.name === "get_current_thread_url");
  assert.equal(syncDefinition._meta.ui.resourceUri, THREAD_SYNC_WIDGET_URI);
  assert.match(syncDefinition.description, /Required step 1/);
  assert.match(syncDefinition.description, /call this tool first/);
  assert.equal(getDefinition._meta?.ui, undefined, "URL lookup must not mount UI");
  assert.match(getDefinition.description, /Required step 2/);
  assert.match(getDefinition.description, /Call sync_current_thread first/);
  const syncCall = sessionId => client.callTool({ name: "sync_current_thread", arguments: {}, _meta: { "openai/session": sessionId } });
  const getCall = sessionId => client.callTool({ name: "get_current_thread_url", arguments: {}, _meta: { "openai/session": sessionId } });
  const [mcpA, mcpB] = await Promise.all([syncCall("mcp-A"), syncCall("mcp-B")]);
  const tokenA = mcpA._meta["local-codex/thread-binding"].token;
  const tokenB = mcpB._meta["local-codex/thread-binding"].token;
  assert.notEqual(tokenA, tokenB);
  assert.ok(!JSON.stringify(mcpA).includes(sync.extensionToken), "extension credential never reaches the model or widget");
  assert.equal((await syncCall("mcp-A"))._meta["local-codex/thread-binding"].token, tokenA);
  const waitingLookup = getCall("mcp-A");
  await new Promise(resolve => setTimeout(resolve, 25));
  await Promise.all([registry.bind(tokenB, urlB), registry.bind(tokenA, urlA)]);
  assert.equal((await waitingLookup).structuredContent.conversationUrl, urlA,
    "lookup waits for the hidden extension handshake instead of racing it");
  assert.equal((await getCall("mcp-A")).structuredContent.conversationUrl, urlA);
  assert.equal((await getCall("mcp-B")).structuredContent.conversationUrl, urlB);
  assert.equal((await syncCall("mcp-A")).structuredContent.status, "synced");
  assert.equal((await client.callTool({ name: "sync_current_thread", arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: "get_current_thread_url", arguments: {} })).isError, true);
  const resource = await client.readResource({ uri: THREAD_SYNC_WIDGET_URI });
  assert.match(resource.contents[0].mimeType, /profile=mcp-app/);
  assert.equal(resource.contents[0]._meta.ui.prefersBorder, true);
  assert.doesNotMatch(resource.contents[0].text, /display:\s*none/);
  assert.match(resource.contents[0].text, /Thread Sync/);
  assert.ok(!resource.contents[0].text.includes(sync.extensionToken));

  await testContentScript(a.ticket.token, b.ticket.token);
  await testWorker(sync, a.ticket.token, request);
  await testWidget(sync.widgetHtml, c.ticket);

  // Expired tokens cannot bind, and a new call replaces them.
  const storePath = path.join(temporaryRoot, "thread-sync.json");
  const stored = JSON.parse(await readFile(storePath, "utf8"));
  stored.tickets.find(ticket => ticket.token === c.ticket.token).expiresAt = 0;
  await writeFile(storePath, JSON.stringify(stored));
  const expiredRegistry = await ThreadSyncRegistry.open(temporaryRoot);
  await assert.rejects(expiredRegistry.bind(c.ticket.token, urlB), /expired/);
  assert.notEqual((await expiredRegistry.context({ ...idA, sessionId: "session-C" })).ticket.token, c.ticket.token);
  await writeFile(storePath, "not valid json");
  await assert.rejects(ThreadSyncRegistry.open(temporaryRoot), SyntaxError, "corrupt state must not be silently reset");

  console.log("Thread sync passed: required sync/get sequencing, handshake waiting, browser-neutral WebExtension APIs, DOM-independent MCP UI routing, persistence, auth, real Fetch port checks, and CSP.");
  console.log("All tests were isolated. No network listener or browser was started.");
} finally {
  await client?.close();
  await server?.close();
  // Only remove this test's own mkdtemp directory, never a configured data directory.
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("win-codex-thread-sync-test-"));
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function testContentScript(tokenA, tokenB) {
  const listeners = new Map();
  const sent = [];
  const replies = [];
  const location = new URL(urlA);
  const childA = { postMessage: message => replies.push(message) };
  const childB = { postMessage: message => replies.push(message) };
  const window = { addEventListener: (event, fn) => listeners.set(event, fn) };
  const browser = { runtime: { sendMessage: async message => { sent.push(message); return { status: "bound", conversationUrl: message.conversationUrl }; } } };
  vm.runInNewContext(await readFile("thread-sync-extension/content-script.js", "utf8"), {
    window, location, browser,
  });
  const message = (source, token, origin = "https://web-sandbox.oaiusercontent.com") =>
    listeners.get("message")({ source, origin, data: { type: "local-codex-thread-sync/bind-v1", token } });

  await message(childA, tokenA);
  const bindings = () => sent.filter(item => item.type === "local-codex-thread-sync/bind-v1");
  assert.equal(bindings()[0].conversationUrl, urlA,
    "MCP UI messages work even when the source window is not discoverable through iframe DOM traversal");
  assert.equal(replies[0].status, "bound");

  location.href = urlB;
  await message(childA, tokenA);
  assert.equal(bindings().length, 1, "an old MCP UI source cannot bind itself to a new conversation route");
  assert.equal(replies.at(-1).retryable, false);

  await message(childB, tokenB);
  assert.equal(bindings().at(-1).conversationUrl, urlB);
  await message(window, tokenA);
  await message(childB, "invalid");
  assert.equal(bindings().length, 2, "top-page messages and invalid tokens cannot request bindings");

  let resolveDelivery;
  browser.runtime.sendMessage = () => new Promise(resolve => { resolveDelivery = resolve; });
  const delayed = message(childB, tokenB);
  const previousReplies = replies.length;
  location.href = urlA;
  resolveDelivery({ status: "bound", conversationUrl: urlB });
  await delayed;
  assert.equal(replies.length, previousReplies, "delayed acknowledgement is not applied after navigation");
}

async function testWorker(sync, token, request) {
  let listener;
  let currentUrl = urlA;
  let fetches = 0;
  const injected = [];
  const lifecycle = {};
  const extensionId = "a".repeat(32);
  const generatedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), generatedConfig);
  const context = {
    URL, AbortSignal, importScripts() {},
    LOCAL_CODEX_THREAD_SYNC: generatedConfig.LOCAL_CODEX_THREAD_SYNC,
    browser: {
      runtime: {
        id: extensionId,
        onMessage: { addListener: fn => { listener = fn; } },
        onInstalled: { addListener: fn => { lifecycle.installed = fn; } },
        onStartup: { addListener: fn => { lifecycle.startup = fn; } },
      },
      tabs: {
        get: async () => ({ url: currentUrl }),
        query: async () => [{ id: 7 }, { id: undefined }],
      },
      scripting: { executeScript: async options => { injected.push(options); } },
    },
    fetch: (url, options) => {
      assert.equal(url, generatedConfig.LOCAL_CODEX_THREAD_SYNC.bindUrl);
      assert.equal(options.redirect, "error");
      // Keep real Fetch's URL/port checks. Replace only socket transport, so no
      // listener or browser is needed and blocked ports fail before dispatch.
      return fetch(url, { ...options, dispatcher: {
        dispatch(_options, handler) {
          fetches += 1;
          const responsePromise = request(JSON.parse(options.body), options.headers.authorization);
          void responsePromise.then(response => {
            handler.onConnect(() => {});
            handler.onHeaders(response.status, ["content-type", "application/json"], () => {}, "OK");
            handler.onData(Buffer.from(JSON.stringify(response.body)));
            handler.onComplete([]);
          }).catch(error => handler.onError(error));
          return true;
        },
      } });
    },
  };
  const script = await readFile("thread-sync-extension/service-worker.js", "utf8");
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(injected), JSON.stringify([{ target: { tabId: 7 }, files: ["content-script.js"] }]));
  assert.equal(typeof lifecycle.installed, "function");
  assert.equal(typeof lifecycle.startup, "function");
  const sender = { id: extensionId, frameId: 0, tab: { id: 1 }, url: "https://chatgpt.com/" };
  const send = (source = sender) => new Promise(resolve => listener({ type: "local-codex-thread-sync/bind-v1", token, conversationUrl: urlA }, source, resolve));
  const delivered = await send();
  assert.equal(delivered.status, "bound", delivered.error);
  assert.equal(fetches, 1);
  // Prove this transport seam catches the original blocked-port bug.
  await assert.rejects(fetch("http://127.0.0.1:6000/thread-sync/bind", {
    dispatcher: { dispatch() { throw new Error("Blocked ports must not reach the transport."); } },
  }), error => error.cause?.message === "bad port");
  assert.equal(fetches, 1, "blocked port never reaches the transport");
  currentUrl = urlB;
  assert.equal((await send()).retryable, false);
  assert.equal((await send({ ...sender, frameId: 3 })).retryable, false);
  assert.equal((await send({ ...sender, id: "other-extension" })).retryable, false);
  assert.equal(fetches, 1);
  currentUrl = urlA;
  context.fetch = async () => { throw new Error("offline"); };
  const offline = await send();
  assert.equal(offline.retryable, true);
  assert.ok(offline.error.includes(sync.bindUrl.replace("/thread-sync/bind", "")));
  assert.ok(!offline.error.includes("Start it"), "a network failure does not prove the server is stopped");
  assert.throws(() => vm.runInNewContext(script, { ...context, LOCAL_CODEX_THREAD_SYNC: { bindUrl: "https://evil.example/thread-sync/bind" } }), /loopback/);
}

async function testWidget(html, ticket) {
  const listeners = new Map();
  const sent = [];
  let cleared = false;
  const parent = { postMessage: message => sent.push(message) };
  const top = { postMessage: message => sent.push(message) };
  const window = { parent, top, addEventListener: (event, fn) => listeners.set(event, fn) };
  const document = { getElementById: () => ({ textContent: "" }) };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window, document, Date, setInterval: () => 1, clearInterval: () => { cleared = true; },
  });
  assert.equal(sent[0].method, "ui/initialize");
  listeners.get("message")({ source: parent, data: { jsonrpc: "2.0", id: "thread-sync-init", result: {} } });
  assert.equal(sent.at(-1).method, "ui/notifications/initialized");
  listeners.get("message")({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { "local-codex/thread-binding": ticket } } } });
  assert.equal(sent.at(-1).token, ticket.token);
  assert.equal(sent.at(-1).type, "local-codex-thread-sync/bind-v1");
  listeners.get("message")({ source: top, origin: "https://chatgpt.com", data: { type: "local-codex-thread-sync/result-v1", token: ticket.token, status: "bound", conversationUrl: urlA } });
  assert.equal(cleared, true, "the URL bridge stops retrying after the extension confirms binding");
}
