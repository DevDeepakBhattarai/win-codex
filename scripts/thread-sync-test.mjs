import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { EventEmitter } from "node:events";
import path from "node:path";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { THREAD_SYNC_AGENT_INSTRUCTION, THREAD_SYNC_WIDGET_URI, ThreadSyncRegistry, parseConversationUrl, prepareThreadSync, registerThreadSync, threadSyncBindHandler, threadSyncBindUrl } from "../dist/thread-sync.js";
import { RalfController, RalfRegistry, SupportCommandBus, normalizeChatGptMessageTarget, registerChatGptMessaging, supportCommandClaimHandler } from "../dist/chatgpt-support.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "win-codex-thread-sync-test-"));
const projectId = "g-project-test";
const urlA = `https://chatgpt.com/g/${projectId}/c/11111111-1111-4111-8111-111111111111`;
const urlB = `https://chatgpt.com/g/${projectId}/c/12345678-abcd-4321-abcd-123456789abc`;
const idA = { ownerId: "grant-one", sessionId: "session-A" };
const idB = { ownerId: "grant-one", sessionId: "session-B" };
let client;
let server;
let supportCommands;
let ralfRegistry;

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
  const legacyExtensionToken = "L".repeat(43);
  const legacyExtensionDirectory = path.join(temporaryRoot, "thread-sync-extension");
  await mkdir(legacyExtensionDirectory, { recursive: true });
  await writeFile(path.join(legacyExtensionDirectory, "obsolete.txt"), "old generated extension");
  await writeFile(path.join(temporaryRoot, "thread-sync-extension-token"), `${legacyExtensionToken}\n`);
  const sync = await prepareThreadSync(temporaryRoot, 6002);
  assert.equal(sync.extensionToken, legacyExtensionToken, "the old extension token is preserved during migration");
  assert.equal((await readFile(path.join(temporaryRoot, "support-extension-token"), "utf8")).trim(), legacyExtensionToken);
  await assert.rejects(readFile(path.join(temporaryRoot, "thread-sync-extension-token"), "utf8"), error => error.code === "ENOENT");
  await assert.rejects(readFile(path.join(legacyExtensionDirectory, "obsolete.txt"), "utf8"), error => error.code === "ENOENT",
    "the obsolete generated thread-sync extension is removed");
  const manifest = JSON.parse(await readFile(path.join(sync.extensionDirectory, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "http://127.0.0.1/*"]);
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.minimum_chrome_version, undefined, "thread sync is not tied to a Chrome-branded minimum");
  assert.deepEqual(manifest.permissions, ["scripting", "storage", "tabs"]);
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'self'; connect-src http://127.0.0.1:*");
  const preparedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), preparedConfig);
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.commandClaimUrl, "http://127.0.0.1:6002/chatgpt-support/commands/claim");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.commandResultUrl, "http://127.0.0.1:6002/chatgpt-support/commands/result");
  assert.equal(normalizeChatGptMessageTarget("https://chatgpt.com/"), "https://chatgpt.com/");
  assert.equal(normalizeChatGptMessageTarget("https://chatgpt.com/g/g-project-test/project"), "https://chatgpt.com/g/g-project-test/project");
  assert.throws(() => normalizeChatGptMessageTarget("https://evil.example/"));

  const registry = sync.registry;
  ralfRegistry = await RalfRegistry.open(temporaryRoot, 20);
  supportCommands = new SupportCommandBus();
  const [a, b, againA] = await Promise.all([registry.context(idA), registry.context(idB), registry.context(idA)]);
  assert.equal(a.ticket.token, againA.ticket.token, "repeated sync calls reuse the pending ticket");
  assert.notEqual(a.ticket.token, b.ticket.token);
  await Promise.all([registry.bind(b.ticket.token, urlB), registry.bind(a.ticket.token, urlA)]);
  assert.equal((await registry.binding(idA)).conversationUrl, urlA);
  assert.equal((await registry.binding(idB)).conversationUrl, urlB);
  assert.equal((await registry.bind(a.ticket.token, urlA)).conversationUrl, urlA, "replay is idempotent");
  await assert.rejects(registry.bind(a.ticket.token, urlB), /different conversation/);
  const c = await registry.context({ ...idA, sessionId: "session-C" });
  await assert.rejects(registry.bind(c.ticket.token, urlA), /different session/);
  assert.equal((await registry.context({ ...idA, ownerId: "another-grant" })).status, "syncing", "OAuth grants cannot read each other's mapping");
  const reopened = await ThreadSyncRegistry.open(temporaryRoot);
  assert.equal((await reopened.binding(idA)).conversationUrl, urlA, "bindings survive a registry reload");
  assert.equal((await reopened.context({ ...idA, sessionId: "session-C" })).ticket.token, c.ticket.token, "pending sync survives a registry reload");
  for (const url of ["https://evil.example/c/123", "https://chatgpt.com.evil.example/c/123", "http://chatgpt.com/c/123", "https://chatgpt.com/", "https://chatgpt.com/share/123", urlA.replace("https://", "https://user:pass@")]) {
    assert.throws(() => parseConversationUrl(url));
  }
  assert.equal(parseConversationUrl(urlA + "?test=1#bottom").conversationUrl, urlA);
  assert.equal(parseConversationUrl(urlA).projectId, projectId);
  assert.equal(parseConversationUrl(urlA.replace(`/g/${projectId}`, "")).projectId, undefined);

  const routeRefreshRoot = path.join(temporaryRoot, "route-refresh");
  const routeRefreshRegistry = await ThreadSyncRegistry.open(routeRefreshRoot);
  const routeRefreshIdentity = { ownerId: "route-grant", sessionId: "route-session" };
  const routeRefreshTicket = await routeRefreshRegistry.context(routeRefreshIdentity);
  const bareUrlA = urlA.replace(`/g/${projectId}`, "");
  await routeRefreshRegistry.bind(routeRefreshTicket.ticket.token, bareUrlA);
  const refreshContext = await routeRefreshRegistry.context(routeRefreshIdentity);
  assert.equal(refreshContext.status, "connected");
  assert.notEqual(refreshContext.ticket.token, routeRefreshTicket.ticket.token);
  let refreshResolved = false;
  const waitingRefresh = routeRefreshRegistry.waitForBinding(routeRefreshIdentity, 1_000).then(binding => {
    refreshResolved = true;
    return binding;
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(refreshResolved, false, "URL lookup waits for the fresh browser observation after a repeated sync");
  await routeRefreshRegistry.bind(refreshContext.ticket.token, urlA);
  const refreshedBinding = await waitingRefresh;
  assert.equal(refreshedBinding.conversationUrl, urlA,
    "rebinding the same thread refreshes its exact ChatGPT route");
  assert.equal((await routeRefreshRegistry.binding(routeRefreshIdentity)).conversationUrl, urlA);
  const migratedRalfRegistry = await RalfRegistry.open(routeRefreshRoot, 20);
  assert.equal(await migratedRalfRegistry.registerMany(
    (await routeRefreshRegistry.allBindings()).map(binding => binding.conversationUrl),
  ), 1, "existing thread bindings can seed RALF during an upgrade");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await migratedRalfRegistry.due()).some(thread => thread.conversationUrl === urlA), true);

  const handler = threadSyncBindHandler(registry, sync.extensionToken, async (binding) => {
    await ralfRegistry.register(binding.conversationUrl);
  });
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
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await ralfRegistry.due()).some(thread => thread.conversationUrl === urlA), true,
    "a manually synced thread is registered for the RALF loop");

  // Exercise actual MCP metadata forwarding without opening an HTTP listener.
  server = new McpServer({ name: "thread-sync-test", version: "1" });
  registerThreadSync(server, sync, "mcp-grant");
  registerChatGptMessaging(server, supportCommands, ralfRegistry);
  client = new Client({ name: "thread-sync-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  const syncDefinition = tools.find(tool => tool.name === "sync_current_thread");
  const getDefinition = tools.find(tool => tool.name === "get_current_thread_url");
  const messageDefinition = tools.find(tool => tool.name === "chatgpt_message");
  assert.equal(syncDefinition._meta.ui.resourceUri, THREAD_SYNC_WIDGET_URI);
  assert.match(syncDefinition.description, /Required step 1/);
  assert.match(syncDefinition.description, /call this tool first/);
  assert.equal(getDefinition._meta?.ui, undefined, "URL lookup must not mount UI");
  assert.match(getDefinition.description, /Required step 2/);
  assert.match(getDefinition.description, /Call sync_current_thread first/);
  assert.match(messageDefinition.description, /Start a new ChatGPT thread or send a message/);
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
  const refreshSync = await syncCall("mcp-A");
  assert.equal(refreshSync.structuredContent.status, "synced");
  const refreshToken = refreshSync._meta["local-codex/thread-binding"].token;
  const refreshedLookup = getCall("mcp-A");
  await new Promise(resolve => setTimeout(resolve, 25));
  await registry.bind(refreshToken, bareUrlA);
  assert.equal((await refreshedLookup).structuredContent.conversationUrl, bareUrlA,
    "repeated sync/get returns the newly observed route instead of a stale binding");
  assert.equal((await client.callTool({ name: "sync_current_thread", arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: "get_current_thread_url", arguments: {} })).isError, true);
  const commandResult = supportCommands.execute({
    feature: "threadMessaging",
    kind: "send_message",
    targetUrl: "https://chatgpt.com/",
    message: "test message",
  });
  const claimed = await supportCommands.claim("chrome-browser", ["threadMessaging"], 1000);
  assert.equal(claimed.kind, "send_message");
  assert.equal(claimed.targetUrl, "https://chatgpt.com/");
  assert.equal(await supportCommands.claim("helium-browser", ["threadMessaging"], 0), undefined,
    "only one enabled browser can claim a support command");
  supportCommands.complete({
    commandId: claimed.id,
    browserId: "chrome-browser",
    kind: "send_message",
    ok: true,
    result: { status: "sent", conversationUrl: urlB },
  });
  assert.equal((await commandResult).result.conversationUrl, urlB);
  await ralfRegistry.exclude(urlB);
  assert.equal(await ralfRegistry.register(urlB), false, "agent-created threads stay excluded from RALF");

  const originalExclude = ralfRegistry.exclude;
  const originalConsoleError = console.error;
  ralfRegistry.exclude = async () => { throw new Error("simulated RALF persistence failure"); };
  console.error = () => {};
  try {
    const messageCall = client.callTool({
      name: "chatgpt_message",
      arguments: { targetUrl: "https://chatgpt.com/", message: "bookkeeping failure test" },
    });
    const messageCommand = await supportCommands.claim("chrome-browser", ["threadMessaging"], 1000);
    supportCommands.complete({
      commandId: messageCommand.id,
      browserId: "chrome-browser",
      kind: "send_message",
      ok: true,
      result: { status: "sent", conversationUrl: urlA },
    });
    const messageResult = await messageCall;
    assert.notEqual(messageResult.isError, true,
      "a confirmed send stays successful when RALF exclusion persistence fails");
    assert.equal(messageResult.structuredContent.conversationUrl, urlA);
  } finally {
    ralfRegistry.exclude = originalExclude;
    console.error = originalConsoleError;
  }

  const abandonedController = new AbortController();
  const abandonedClaim = supportCommands.claim("chrome-browser", ["ralf"], 1000, abandonedController.signal);
  abandonedController.abort();
  assert.equal(await abandonedClaim, undefined, "an aborted browser poll cannot steal a later command");

  const claimHandlerBus = new SupportCommandBus();
  const claimHandler = supportCommandClaimHandler(claimHandlerBus, sync.extensionToken);
  const makeClaimRequest = (browserId) => {
    const req = new EventEmitter();
    req.body = { browserId, features: ["ralf"] };
    req.get = key => ({
      authorization: `Bearer ${sync.extensionToken}`,
      origin: "chrome-extension://" + "a".repeat(32),
    })[key];
    const res = new EventEmitter();
    res.statusCode = 200;
    res.body = undefined;
    res.setHeader = () => {};
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.body = value; return res; };
    res.end = () => res;
    return { req, res };
  };

  const healthyPoll = makeClaimRequest("healthy-browser");
  const healthyPollResult = claimHandler(healthyPoll.req, healthyPoll.res, error => { throw error; });
  await new Promise(resolve => setImmediate(resolve));
  healthyPoll.req.emit("close");
  const healthyCommandResult = claimHandlerBus.execute({
    feature: "ralf",
    kind: "inspect_thread",
    conversationUrl: urlA,
  });
  await healthyPollResult;
  assert.equal(healthyPoll.res.body.kind, "inspect_thread",
    "finishing the HTTP request body must not cancel a healthy long poll");
  claimHandlerBus.complete({
    commandId: healthyPoll.res.body.id,
    browserId: "healthy-browser",
    kind: "inspect_thread",
    ok: true,
    result: { status: "running" },
  });
  assert.equal((await healthyCommandResult).result.status, "running");

  const disconnectedPoll = makeClaimRequest("disconnected-browser");
  const disconnectedPollResult = claimHandler(disconnectedPoll.req, disconnectedPoll.res, error => { throw error; });
  await new Promise(resolve => setImmediate(resolve));
  disconnectedPoll.res.emit("close");
  await disconnectedPollResult;
  const retryCommandResult = claimHandlerBus.execute({
    feature: "ralf",
    kind: "inspect_thread",
    conversationUrl: urlA,
  });
  const retryCommand = await claimHandlerBus.claim("retry-browser", ["ralf"], 1000);
  assert.equal(retryCommand.kind, "inspect_thread",
    "a disconnected long poll must not steal a future command");
  claimHandlerBus.complete({
    commandId: retryCommand.id,
    browserId: "retry-browser",
    kind: "inspect_thread",
    ok: true,
    result: { status: "running" },
  });
  await retryCommandResult;
  claimHandlerBus.close();

  const ralfControllerRoot = path.join(temporaryRoot, "ralf-controller");
  const ralfControllerRegistry = await RalfRegistry.open(ralfControllerRoot, 20);
  const ralfCommands = new SupportCommandBus();
  const originalFetch = globalThis.fetch;
  let apiRequest;
  let apiRequestCount = 0;
  globalThis.fetch = async (_url, options) => {
    apiRequestCount += 1;
    apiRequest = JSON.parse(options.body);
    return new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: "Inspect the remaining CI failure and fix the specific blocker before stopping." }] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const ralfController = new RalfController({
    registry: ralfControllerRegistry,
    commands: ralfCommands,
    apiKey: "test-key",
    model: "gpt-5.6-terra",
    checkEveryMs: 60_000,
  });
  try {
    const ralfUrl = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
    await ralfControllerRegistry.register(ralfUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralfController.tick();
    const inspectCommand = await ralfCommands.claim("chrome-browser", ["ralf"], 1000);
    assert.equal(inspectCommand.kind, "inspect_thread");
    ralfCommands.complete({
      commandId: inspectCommand.id,
      browserId: "chrome-browser",
      kind: "inspect_thread",
      ok: true,
      result: {
        status: "idle",
        workedSeconds: 19 * 60 + 1,
        users: [
          { id: "u1", text: "Fix the implementation end to end." },
          { id: "u2", text: "Do not stop until CI is handled." },
        ],
        assistant: { synthetic: false, id: "a1", text: "I implemented most of it, but one CI failure remains." },
      },
    });
    const continueCommand = await ralfCommands.claim("chrome-browser", ["ralf"], 1000);
    assert.equal(continueCommand.kind, "send_message");
    assert.equal(continueCommand.targetUrl, ralfUrl);
    assert.equal(continueCommand.message, "Inspect the remaining CI failure and fix the specific blocker before stopping.");
    assert.equal(apiRequest.model, "gpt-5.6-terra");
    assert.equal(apiRequest.max_output_tokens, 120);
    assert.match(JSON.stringify(apiRequest.input), /Fix the implementation end to end/);
    assert.match(JSON.stringify(apiRequest.input), /one CI failure remains/);
    ralfCommands.complete({
      commandId: continueCommand.id,
      browserId: "chrome-browser",
      kind: "send_message",
      ok: true,
      result: { status: "sent", conversationUrl: ralfUrl },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    await ralfControllerRegistry.recordComplete("22222222-2222-4222-8222-222222222222");

    const shortRalfUrl = "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333";
    await ralfControllerRegistry.register(shortRalfUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralfController.tick();
    const shortInspectCommand = await ralfCommands.claim("chrome-browser", ["ralf"], 1000);
    assert.equal(shortInspectCommand.kind, "inspect_thread");
    ralfCommands.complete({
      commandId: shortInspectCommand.id,
      browserId: "chrome-browser",
      kind: "inspect_thread",
      ok: true,
      result: {
        status: "idle",
        workedSeconds: 19 * 60,
        users: [{ id: "u3", text: "Finish this small task." }],
        assistant: { synthetic: false, id: "a2", text: "Done." },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(apiRequestCount, 1, "RALF must not call OpenAI for a task that took 19 minutes or less");
    assert.equal(await ralfCommands.claim("chrome-browser", ["ralf"], 0), undefined);

    const unknownRalfUrl = "https://chatgpt.com/c/44444444-4444-4444-8444-444444444444";
    await ralfControllerRegistry.register(unknownRalfUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralfController.tick();
    const unknownInspectCommand = await ralfCommands.claim("chrome-browser", ["ralf"], 1000);
    assert.equal(unknownInspectCommand.kind, "inspect_thread");
    ralfCommands.complete({
      commandId: unknownInspectCommand.id,
      browserId: "chrome-browser",
      kind: "inspect_thread",
      ok: true,
      result: {
        status: "idle",
        workedSeconds: null,
        users: [{ id: "u4", text: "Do the task." }],
        assistant: { synthetic: false, id: "a3", text: "Stopped thinking" },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(apiRequestCount, 1, "RALF must not call OpenAI when the worked duration is unavailable");
    assert.equal(await ralfCommands.claim("chrome-browser", ["ralf"], 0), undefined);
  } finally {
    ralfController.close();
    ralfCommands.close();
    globalThis.fetch = originalFetch;
  }

  const resource = await client.readResource({ uri: THREAD_SYNC_WIDGET_URI });
  assert.match(resource.contents[0].mimeType, /profile=mcp-app/);
  assert.equal(resource.contents[0]._meta.ui.prefersBorder, true);
  assert.doesNotMatch(resource.contents[0].text, /display:\s*none/);
  assert.match(resource.contents[0].text, /Thread Sync/);
  assert.ok(!resource.contents[0].text.includes(sync.extensionToken));

  await testContentScript(a.ticket.token, b.ticket.token);
  await testRunningHydrationDetection();
  await testWorkedDurationDetection();
  await testWorker(sync, a.ticket.token, request);
  await testAutomationRedirectGuard(sync);
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
  const browser = { runtime: {
    sendMessage: async message => { sent.push(message); return { status: "bound", conversationUrl: message.conversationUrl }; },
    onMessage: { addListener() {} },
  } };
  vm.runInNewContext(await readFile("support-extension/content-script.js", "utf8"), {
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

async function testRunningHydrationDetection() {
  let automationListener;
  let now = 0;
  const stopButton = {};
  const userMessage = {
    getAttribute: key => key === "data-message-id" ? "u1" : null,
    querySelector: () => null,
  };
  const userTurn = {
    dataset: { turn: "user", turnId: "u1" },
    textContent: "Keep working on the task.",
    querySelector: selector => selector === '[data-message-author-role="user"]' ? userMessage : null,
  };
  const editor = {};
  const composer = {
    querySelector(selector) {
      if (selector === '#prompt-textarea[contenteditable="true"]') return editor;
      if (selector === 'button[data-testid="stop-button"]' && now >= 2_500) return stopButton;
      return null;
    },
  };
  const document = {
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"]') return userTurn;
      if (selector === 'button[data-testid="stop-button"]' ||
          selector === 'form[data-type="unified-composer"] button[data-testid="stop-button"]') {
        return now >= 2_500 ? stopButton : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "section[data-turn]" ? [userTurn] : [];
    },
  };
  const browser = {
    runtime: {
      sendMessage: async () => ({ status: "bound" }),
      onMessage: { addListener: fn => { automationListener = fn; } },
    },
  };
  const fakeSetTimeout = (callback, ms) => {
    now += ms;
    callback();
    return 1;
  };
  vm.runInNewContext(await readFile("support-extension/content-script.js", "utf8"), {
    window: { addEventListener() {} },
    location: new URL(urlA),
    document,
    browser,
    Date: { now: () => now },
    setTimeout: fakeSetTimeout,
  });

  const response = await new Promise(resolve => {
    const keepChannelOpen = automationListener({
      type: "local-codex-support/automation-v1",
      command: { kind: "inspect_thread" },
    }, {}, resolve);
    assert.equal(keepChannelOpen, true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.status, "running",
    "a still-hydrating running thread must not be classified as stopped before the stop button appears");
  assert.ok(now >= 2_500);
}


async function testWorkedDurationDetection() {
  let automationListener;
  let now = 0;

  const textNode = text => ({
    textContent: text,
    getAttribute: key => key === "data-message-id" ? `${text.slice(0, 1)}1` : null,
    querySelector: () => null,
    cloneNode: () => ({ querySelectorAll: () => [], text }),
  });
  const userMessage = textNode("Fix this end to end.");
  const assistantMessage = textNode("The implementation is complete.");
  const durationButton = { textContent: "Worked for 26m 15s" };
  const userTurn = {
    dataset: { turn: "user", turnId: "u1" },
    textContent: userMessage.textContent,
    querySelector: selector => selector === '[data-message-author-role="user"]' ? userMessage : null,
  };
  const assistantTurn = {
    dataset: { turn: "assistant", turnId: "a1" },
    textContent: `${assistantMessage.textContent} ${durationButton.textContent}`,
    querySelectorAll(selector) {
      if (selector === "button") return [durationButton];
      if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
      return [];
    },
  };
  const editor = {};
  const composer = {
    querySelector(selector) {
      if (selector === '#prompt-textarea[contenteditable="true"]') return editor;
      return null;
    },
  };
  const document = {
    body: { appendChild() {} },
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"]') return userTurn;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "section[data-turn]") return [userTurn, assistantTurn];
      if (selector === 'section[data-turn="assistant"]') return [assistantTurn];
      return [];
    },
    createElement() {
      return {
        style: {},
        innerText: "",
        appendChild(child) { this.innerText = child.text; },
        remove() {},
      };
    },
  };
  const browser = {
    runtime: {
      sendMessage: async () => ({ status: "bound" }),
      onMessage: { addListener: fn => { automationListener = fn; } },
    },
  };
  const fakeSetTimeout = (callback, ms) => {
    now += ms;
    callback();
    return 1;
  };

  vm.runInNewContext(await readFile("support-extension/content-script.js", "utf8"), {
    window: { addEventListener() {} },
    location: new URL(urlA),
    document,
    browser,
    Date: { now: () => now },
    setTimeout: fakeSetTimeout,
  });

  const response = await new Promise(resolve => {
    const keepChannelOpen = automationListener({
      type: "local-codex-support/automation-v1",
      command: { kind: "inspect_thread" },
    }, {}, resolve);
    assert.equal(keepChannelOpen, true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.status, "idle");
  assert.equal(response.result.workedSeconds, 26 * 60 + 15,
    "RALF inspection must parse the latest assistant Worked for label into seconds");
}

async function testAutomationRedirectGuard(sync) {
  const generatedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), generatedConfig);
  const storage = {};
  const postedResults = [];
  let sentToTab = false;
  let removedTab = false;
  const context = {
    URL,
    AbortSignal,
    AbortController,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    console,
    Response,
    importScripts() {},
    LOCAL_CODEX_THREAD_SYNC: generatedConfig.LOCAL_CODEX_THREAD_SYNC,
    browser: {
      runtime: {
        id: "a".repeat(32),
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      tabs: {
        query: async () => [],
        create: async () => ({ id: 11 }),
        get: async () => ({ id: 11, status: "complete", url: "https://chatgpt.com/" }),
        sendMessage: async () => {
          sentToTab = true;
          return { ok: true, result: { status: "sent", conversationUrl: urlA } };
        },
        remove: async () => { removedTab = true; },
      },
      scripting: { executeScript: async () => {} },
      storage: { local: {
        async get(query) {
          if (typeof query === "string") return { [query]: storage[query] };
          return { ...query, ...storage };
        },
        async set(values) { Object.assign(storage, values); },
      } },
    },
    fetch: async (endpoint, options) => {
      assert.equal(endpoint, generatedConfig.LOCAL_CODEX_THREAD_SYNC.commandResultUrl);
      postedResults.push(JSON.parse(options.body));
      return new Response("", { status: 200 });
    },
  };
  vm.runInNewContext(await readFile("support-extension/service-worker.js", "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof context.executeCommand, "function");
  await context.executeCommand({
    id: "redirect-test",
    feature: "threadMessaging",
    kind: "send_message",
    targetUrl: urlA,
    message: "must not be sent to the wrong page",
  }, "browser-a");

  assert.equal(sentToTab, false, "automation must not run after ChatGPT redirects away from the requested target");
  assert.equal(removedTab, true, "redirected automation tabs are still cleaned up");
  assert.equal(postedResults.length, 1);
  assert.equal(postedResults[0].ok, false);
  assert.match(postedResults[0].error, /redirected away from the requested target/);
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
  const storage = {};
  const context = {
    URL, AbortSignal, AbortController, crypto: globalThis.crypto, setTimeout, clearTimeout, console, importScripts() {},
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
      storage: { local: {
        async get(query) {
          if (typeof query === "string") return { [query]: storage[query] };
          return { ...query, ...storage };
        },
        async set(values) { Object.assign(storage, values); },
      } },
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
  const script = await readFile("support-extension/service-worker.js", "utf8");
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
  assert.throws(() => vm.runInNewContext(script, {
    ...context,
    LOCAL_CODEX_THREAD_SYNC: { ...generatedConfig.LOCAL_CODEX_THREAD_SYNC, bindUrl: "https://evil.example/thread-sync/bind" },
  }), /loopback/);
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
