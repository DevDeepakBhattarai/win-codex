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
import { RalphController, RalphRegistry, SupportCommandBus, normalizeChatGptMessageTarget, parseRalphProjectId, ralphRegistrationHandler, ralphSettingsGetHandler, ralphSettingsPutHandler, ralphThreadActiveHandler, ralphThreadCheckHandler, ralphThreadCompleteHandler, ralphThreadsGetHandler, registerChatGptMessaging, supportCommandClaimHandler } from "../dist/chatgpt-support.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "win-codex-thread-sync-test-"));
const projectId = "g-p-6a87fafd6d948191ab3338e485c07c39";
const namedProjectHome = `https://chatgpt.com/g/${projectId}-deepak/project`;
const urlA = `https://chatgpt.com/g/${projectId}/c/11111111-1111-4111-8111-111111111111`;
const urlB = `https://chatgpt.com/g/${projectId}/c/12345678-abcd-4321-abcd-123456789abc`;
const idA = { ownerId: "grant-one", sessionId: "session-A" };
const idB = { ownerId: "grant-one", sessionId: "session-B" };
let client;
let server;
let supportCommands;
let ralphRegistry;

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
  assert.equal(manifest.version, "1.3.3");
  assert.equal(manifest.minimum_chrome_version, undefined, "thread sync is not tied to a Chrome-branded minimum");
  assert.deepEqual(manifest.permissions, ["scripting", "storage", "tabs", "webNavigation"]);
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'self'; connect-src http://127.0.0.1:*");
  const preparedPopup = await readFile(path.join(sync.extensionDirectory, "popup.html"), "utf8");
  assert.match(preparedPopup, /Sub-agent project URL/);
  assert.match(preparedPopup, /id="panel-threads"/, "the popup exposes the RALPH threads tab");
  assert.match(preparedPopup, /id="panel-settings"/, "the popup exposes the settings tab");
  assert.match(preparedPopup, /RALPH projects/);
  assert.match(preparedPopup, /RALPH loop interval \(seconds\)/);
  assert.match(preparedPopup, /RALPH minimum worked time \(seconds\)/);
  assert.match(preparedPopup, /config\.js/);
  const preparedPopupScript = await readFile(path.join(sync.extensionDirectory, "popup.js"), "utf8");
  assert.match(preparedPopupScript, /Mark complete/,
    "active RALPH thread cards expose a manual completion action");
  assert.match(preparedPopupScript, /Mark active/,
    "completed RALPH thread cards expose a manual reactivation action");
  assert.match(preparedPopupScript, /textContent = "Check now"/,
    "active RALPH thread cards expose an immediate check action");
  assert.match(preparedPopupScript, /threadStateEndpoint\(thread\.threadId, "check"\)/,
    "the popup immediate action uses the server check endpoint");
  assert.match(preparedPopup, /id="markCurrentThread"/, "the popup can mark its active ChatGPT thread for RALPH");
  assert.match(preparedPopupScript, /tabs\.query\(\{ active: true, currentWindow: true \}\)/,
    "manual RALPH registration reads the current tab URL");
  assert.match(preparedPopupScript, /JSON\.stringify\(\{ conversationUrl: currentConversationUrl, manual: true \}\)/,
    "the popup requests a project-filter override for the current thread");
  assert.match(preparedPopup, /data-thread-filter="active"[^>]*>[\s\S]*?id="activeCount"/,
    "the active thread filter shows its count");
  assert.match(preparedPopup, /data-thread-filter="complete"/);
  assert.doesNotMatch(preparedPopup, /id="(?:threadCount|completeCount)"/,
    "the popup does not count all or completed threads");
  assert.match(preparedPopupScript, /textContent: thread\.conversationUrl/,
    "thread cards show their full ChatGPT URL");
  assert.match(preparedPopupScript,
    /sort\(\(left, right\) => Date\.parse\(right\.registeredAt\) - Date\.parse\(left\.registeredAt\)\)/,
    "thread cards sort from most recently registered to oldest");
  const preparedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), preparedConfig);
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.commandClaimUrl, "http://127.0.0.1:6002/chatgpt-support/commands/claim");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.commandResultUrl, "http://127.0.0.1:6002/chatgpt-support/commands/result");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.ralphRegisterUrl, "http://127.0.0.1:6002/chatgpt-support/ralph/register");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.ralphProjectsUrl, "http://127.0.0.1:6002/chatgpt-support/ralph/projects");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.ralphSettingsUrl, "http://127.0.0.1:6002/chatgpt-support/ralph/settings");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.ralphThreadsUrl, "http://127.0.0.1:6002/chatgpt-support/ralph/threads");
  const preparedContentScript = await readFile(path.join(sync.extensionDirectory, "content-script.js"), "utf8");
  assert.doesNotMatch(preparedContentScript, /Run RALPH now|installManualRalphButton/,
    "the content script does not inject a RALPH button into ChatGPT");
  assert.throws(() => normalizeChatGptMessageTarget("https://chatgpt.com/"), /project URL/);
  assert.equal(normalizeChatGptMessageTarget(namedProjectHome), namedProjectHome);
  assert.equal(parseRalphProjectId(namedProjectHome), projectId);
  assert.equal(parseRalphProjectId(urlA), projectId);
  assert.throws(() => normalizeChatGptMessageTarget("https://evil.example/"));

  const registry = sync.registry;
  ralphRegistry = await RalphRegistry.open(temporaryRoot, 20);
  await ralphRegistry.setProjects([projectId]);
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
  const projectScopedRegistry = await RalphRegistry.open(routeRefreshRoot, 20);
  assert.equal(await projectScopedRegistry.register(urlA), false,
    "RALPH ignores project threads until their project is explicitly configured");
  assert.deepEqual(await projectScopedRegistry.setProjects([namedProjectHome, projectId]), [projectId],
    "named project home URLs canonicalize to the stable project id");
  assert.equal(await projectScopedRegistry.register(urlA), true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await projectScopedRegistry.due()).some(thread => thread.conversationUrl === urlA), true);
  assert.deepEqual((await projectScopedRegistry.threads()).map(thread => [thread.conversationUrl, thread.state]),
    [[urlA, "active"]], "the popup thread list reports every registered thread");
  const listThreads = (authorization = `Bearer ${sync.extensionToken}`) => new Promise(resolve => {
    const response = { status(code) { response.code = code; return response; }, json(body) { resolve({ code: response.code ?? 200, body }); }, setHeader() {} };
    ralphThreadsGetHandler(projectScopedRegistry, sync.extensionToken)({ get: name => (name === "authorization" ? authorization : undefined) }, response);
  });
  assert.equal((await listThreads("Bearer wrong")).code, 401, "the thread list requires the extension token");
  assert.deepEqual((await listThreads()).body.threads.map(thread => thread.threadId), [parseConversationUrl(urlA).threadId]);
  const completeThreadHandler = ralphThreadCompleteHandler(projectScopedRegistry, sync.extensionToken);
  const completeThread = (threadId, authorization = `Bearer ${sync.extensionToken}`) => new Promise(resolve => {
    const response = {
      status(code) { response.code = code; return response; },
      json(body) { resolve({ code: response.code ?? 200, body }); },
      setHeader() {},
    };
    completeThreadHandler({
      params: { threadId },
      get: name => (name === "authorization" ? authorization : undefined),
    }, response);
  });
  assert.equal((await completeThread(parseConversationUrl(urlA).threadId, "Bearer wrong")).code, 401);
  assert.equal((await completeThread("22222222-2222-4222-8222-222222222222")).code, 404);
  assert.deepEqual((await completeThread(parseConversationUrl(urlA).threadId)).body,
    { threadId: parseConversationUrl(urlA).threadId, state: "complete" });
  assert.equal(await projectScopedRegistry.isActive(parseConversationUrl(urlA).threadId), false);
  assert.deepEqual((await projectScopedRegistry.threads()).map(thread => thread.state), ["complete"],
    "manually completed threads stay listed for the popup after they stop being due");
  assert.deepEqual(await projectScopedRegistry.due(), []);
  await projectScopedRegistry.setLoopIntervalSeconds(1);
  const activateThreadHandler = ralphThreadActiveHandler(projectScopedRegistry, sync.extensionToken);
  const activateThread = (threadId, authorization = `Bearer ${sync.extensionToken}`) => new Promise(resolve => {
    const response = {
      status(code) { response.code = code; return response; },
      json(body) { resolve({ code: response.code ?? 200, body }); },
      setHeader() {},
    };
    activateThreadHandler({
      params: { threadId },
      get: name => (name === "authorization" ? authorization : undefined),
    }, response);
  });
  assert.equal((await activateThread(parseConversationUrl(urlA).threadId, "Bearer wrong")).code, 401);
  assert.equal((await activateThread("22222222-2222-4222-8222-222222222222")).code, 404);
  const activatedAt = Date.now();
  assert.deepEqual((await activateThread(parseConversationUrl(urlA).threadId)).body,
    { threadId: parseConversationUrl(urlA).threadId, state: "active" });
  assert.equal(await projectScopedRegistry.isActive(parseConversationUrl(urlA).threadId), true);
  const [reactivatedThread] = await projectScopedRegistry.threads();
  assert.ok(reactivatedThread.nextCheckAt >= activatedAt + 900 && reactivatedThread.nextCheckAt <= activatedAt + 1_100,
    "reactivating a completed thread schedules a fresh loop check");
  assert.deepEqual(await projectScopedRegistry.due(), [], "reactivation does not trigger an immediate stale check");
  let manualCheckTicks = 0;
  const checkThreadHandler = ralphThreadCheckHandler(projectScopedRegistry, {
    async tick() { manualCheckTicks += 1; },
  }, sync.extensionToken);
  const checkThread = (threadId, authorization = `Bearer ${sync.extensionToken}`) => new Promise(resolve => {
    const response = {
      status(code) { response.code = code; return response; },
      json(body) { resolve({ code: response.code ?? 200, body }); },
      setHeader() {},
    };
    checkThreadHandler({
      params: { threadId },
      get: name => (name === "authorization" ? authorization : undefined),
    }, response);
  });
  const scheduledAt = Date.now();
  assert.deepEqual(await checkThread(parseConversationUrl(urlA).threadId), {
    code: 202,
    body: { threadId: parseConversationUrl(urlA).threadId, status: "scheduled" },
  });
  assert.equal(manualCheckTicks, 1, "a manual RALPH request starts the scheduler immediately");
  assert.ok((await projectScopedRegistry.threads())[0].nextCheckAt >= scheduledAt);
  assert.equal((await projectScopedRegistry.due()).length, 1,
    "a manual RALPH request sets the active thread timer to now");
  await completeThread(parseConversationUrl(urlA).threadId);
  assert.equal((await checkThread(parseConversationUrl(urlA).threadId)).code, 409,
    "completed RALPH threads cannot be checked without reactivation");
  assert.equal((await checkThread("22222222-2222-4222-8222-222222222222")).code, 404);
  assert.equal((await checkThread(parseConversationUrl(urlA).threadId, "Bearer wrong")).code, 401);
  const registerThreadHandler = ralphRegistrationHandler(projectScopedRegistry, sync.extensionToken);
  const registerThread = (body) => new Promise(resolve => {
    const response = {
      status(code) { response.code = code; return response; },
      json(responseBody) { resolve({ code: response.code ?? 200, body: responseBody }); },
      setHeader() {},
    };
    registerThreadHandler({
      body,
      get: name => (name === "authorization" ? `Bearer ${sync.extensionToken}` : undefined),
    }, response);
  });
  const messageSentAt = Date.now();
  assert.deepEqual(await registerThread({ conversationUrl: urlA, reactivate: true }), {
    code: 200,
    body: { status: "registered" },
  });
  const [messageReactivatedThread] = await projectScopedRegistry.threads();
  assert.equal(messageReactivatedThread.state, "active",
    "a send-to-stop composer transition reactivates an existing completed RALPH thread");
  assert.ok(messageReactivatedThread.nextCheckAt >= messageSentAt + 900 &&
    messageReactivatedThread.nextCheckAt <= messageSentAt + 1_100,
  "the composer transition starts a fresh loop interval from the new message");
  await registerThread({ conversationUrl: urlA, reactivate: true });
  assert.equal((await projectScopedRegistry.threads())[0].nextCheckAt, messageReactivatedThread.nextCheckAt,
    "reactivation does not reschedule a thread that is already active");
  await projectScopedRegistry.setProjects([]);
  assert.equal((await projectScopedRegistry.due()).length, 0,
    "removing a RALPH project removes its registered threads");
  assert.deepEqual(await projectScopedRegistry.threads(), []);
  assert.deepEqual(await registerThread({ conversationUrl: urlA, manual: true }), {
    code: 200,
    body: { status: "registered" },
  });
  assert.deepEqual((await projectScopedRegistry.threads()).map(thread => ({
    conversationUrl: thread.conversationUrl,
    manuallyRegistered: thread.manuallyRegistered,
    state: thread.state,
  })), [{ conversationUrl: urlA, manuallyRegistered: true, state: "active" }],
  "the popup can register a thread whose project is not allowlisted");
  await projectScopedRegistry.setProjects([]);
  assert.equal((await projectScopedRegistry.threads()).length, 1,
    "project allowlist changes retain manually registered threads");
  await completeThread(parseConversationUrl(urlA).threadId);
  await registerThread({ conversationUrl: urlA, manual: true });
  assert.equal(await projectScopedRegistry.isActive(parseConversationUrl(urlA).threadId), true,
    "marking a completed thread from the popup starts a fresh RALPH loop");
  await completeThread(parseConversationUrl(urlA).threadId);
  await registerThread({ conversationUrl: urlA, reactivate: true });
  assert.equal(await projectScopedRegistry.isActive(parseConversationUrl(urlA).threadId), true,
    "new messages can reactivate a manually registered thread outside the project allowlist");

  const timingRoot = path.join(temporaryRoot, "ralph-timing");
  const timingRegistry = await RalphRegistry.open(timingRoot);
  await timingRegistry.setProjects([projectId]);
  await timingRegistry.register(urlA);
  async function requestRalphSettings(handler, body, authorization = `Bearer ${sync.extensionToken}`) {
    const result = { status: 200, body: undefined };
    const req = { body, get: name => (name === "authorization" ? authorization : undefined) };
    const res = {
      status(code) { result.status = code; return this; },
      json(value) { result.body = value; return this; },
      setHeader() {},
    };
    await handler(req, res);
    return result;
  }
  const getRalphSettings = ralphSettingsGetHandler(timingRegistry, sync.extensionToken);
  const putRalphSettings = ralphSettingsPutHandler(timingRegistry, sync.extensionToken);
  assert.deepEqual((await requestRalphSettings(getRalphSettings)).body, { loopIntervalSeconds: 25 * 60 });
  assert.equal((await requestRalphSettings(getRalphSettings, undefined, "Bearer wrong")).status, 401);
  const intervalChangedAt = Date.now();
  assert.deepEqual((await requestRalphSettings(putRalphSettings, { loopIntervalSeconds: 1 })).body,
    { loopIntervalSeconds: 1 });
  const [rescheduledThread] = await timingRegistry.threads();
  assert.ok(rescheduledThread.nextCheckAt >= intervalChangedAt + 900 &&
    rescheduledThread.nextCheckAt <= intervalChangedAt + 1_100,
    "changing the loop interval reschedules active threads from the current time");
  assert.deepEqual((await requestRalphSettings(getRalphSettings)).body, { loopIntervalSeconds: 1 });
  assert.equal((await requestRalphSettings(putRalphSettings, { loopIntervalSeconds: 0 })).status, 400);
  assert.deepEqual(await (await RalphRegistry.open(timingRoot)).settings(), { loopIntervalSeconds: 1 },
    "the RALPH loop interval survives a server restart");

  const legacyRalphRoot = path.join(temporaryRoot, "legacy-ralph");
  await mkdir(legacyRalphRoot, { recursive: true });
  await writeFile(path.join(legacyRalphRoot, "ralph.json"), JSON.stringify({
    version: 1,
    threads: [{
      conversationUrl: urlA,
      threadId: "11111111-1111-4111-8111-111111111111",
      registeredAt: new Date(0).toISOString(),
      nextCheckAt: 0,
      state: "active",
    }],
    exclusions: [{
      conversationUrl: urlB,
      threadId: "12345678-abcd-4321-abcd-123456789abc",
      excludedAt: new Date(0).toISOString(),
    }],
  }));
  const migratedRalphRegistry = await RalphRegistry.open(legacyRalphRoot, 20);
  assert.deepEqual(await migratedRalphRegistry.projects(), []);
  assert.deepEqual(await migratedRalphRegistry.due(), [],
    "legacy blanket RALPH registrations do not survive the project-scoped migration");
  assert.equal(JSON.parse(await readFile(path.join(legacyRalphRoot, "ralph.json"), "utf8")).version, 2);

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
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await ralphRegistry.due()).some(thread => thread.conversationUrl === urlA), false,
    "thread sync does not register conversations for RALPH");

  // Exercise actual MCP metadata forwarding without opening an HTTP listener.
  server = new McpServer({ name: "thread-sync-test", version: "1" });
  registerThreadSync(server, sync, "mcp-grant");
  registerChatGptMessaging(server, supportCommands);
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
  const directNewThread = await client.callTool({
    name: "chatgpt_message",
    arguments: { targetUrl: "https://chatgpt.com/", message: "must use a project" },
  });
  assert.equal(directNewThread.isError, true, "agent-created new threads must be spawned inside a project");

  const configuredProjectCall = client.callTool({
    name: "chatgpt_message",
    arguments: { message: "configured project sub-agent test" },
  });
  const configuredProjectCommand = await supportCommands.claim("chrome-browser", ["threadMessaging"], 1000);
  assert.equal(configuredProjectCommand.targetUrl, undefined,
    "new sub-agent commands defer their project target to the enabled extension");
  supportCommands.complete({
    commandId: configuredProjectCommand.id,
    browserId: "chrome-browser",
    kind: "send_message",
    ok: true,
    result: { status: "sent", conversationUrl: urlA },
  });
  assert.equal((await configuredProjectCall).structuredContent.conversationUrl, urlA);

  const messageCall = client.callTool({
    name: "chatgpt_message",
    arguments: { targetUrl: namedProjectHome, message: "project sub-agent test" },
  });
  const messageCommand = await supportCommands.claim("chrome-browser", ["threadMessaging"], 1000);
  assert.equal(messageCommand.targetUrl, namedProjectHome);
  supportCommands.complete({
    commandId: messageCommand.id,
    browserId: "chrome-browser",
    kind: "send_message",
    ok: true,
    result: { status: "sent", conversationUrl: urlA },
  });
  const messageResult = await messageCall;
  assert.notEqual(messageResult.isError, true);
  assert.equal(messageResult.structuredContent.conversationUrl, urlA);

  const abandonedController = new AbortController();
  const abandonedClaim = supportCommands.claim("chrome-browser", ["ralph"], 1000, abandonedController.signal);
  abandonedController.abort();
  assert.equal(await abandonedClaim, undefined, "an aborted browser poll cannot steal a later command");

  const claimHandlerBus = new SupportCommandBus();
  const claimHandler = supportCommandClaimHandler(claimHandlerBus, sync.extensionToken);
  const makeClaimRequest = (browserId) => {
    const req = new EventEmitter();
    req.body = { browserId, features: ["ralph"] };
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
    feature: "ralph",
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
    feature: "ralph",
    kind: "inspect_thread",
    conversationUrl: urlA,
  });
  const retryCommand = await claimHandlerBus.claim("retry-browser", ["ralph"], 1000);
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

  const orphanedCommandBus = new SupportCommandBus();
  const orphanedResult = orphanedCommandBus.execute({
    feature: "ralph",
    kind: "inspect_thread",
    conversationUrl: urlA,
  }, 25);
  const orphanedOutcome = orphanedResult.then(
    result => ({ result }),
    error => ({ error }),
  );
  const orphanedCommand = await orphanedCommandBus.claim("same-browser", ["ralph"], 0);
  const reclaimedCommand = await orphanedCommandBus.claim("same-browser", ["ralph"], 0);
  let orphanedError;
  if (!reclaimedCommand) {
    await new Promise(resolve => setTimeout(resolve, 50));
    orphanedError = (await orphanedOutcome).error;
  }
  assert.equal(reclaimedCommand?.id, orphanedCommand.id,
    `a browser must be able to resume its claimed RALPH inspection instead of leaving it orphaned: ${orphanedError?.message ?? "no timeout captured"}`);
  orphanedCommandBus.complete({
    commandId: reclaimedCommand.id,
    browserId: "same-browser",
    kind: "inspect_thread",
    ok: true,
    result: { status: "running" },
  });
  assert.equal((await orphanedResult).result.status, "running");
  orphanedCommandBus.close();

  const ralphControllerRoot = path.join(temporaryRoot, "ralph-controller");
  const ralphControllerRegistry = await RalphRegistry.open(ralphControllerRoot, 20);
  await ralphControllerRegistry.setProjects([projectId]);
  const ralphCommands = new SupportCommandBus();
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const ralphOpenAiLogs = [];
  let apiRequest;
  let apiRequestCount = 0;
  let failNextApiRequest = false;
  console.log = (...values) => ralphOpenAiLogs.push(values.join(" "));
  console.error = (...values) => ralphOpenAiLogs.push(values.join(" "));
  globalThis.fetch = async (_url, options) => {
    apiRequestCount += 1;
    apiRequest = JSON.parse(options.body);
    if (failNextApiRequest) {
      failNextApiRequest = false;
      return new Response(JSON.stringify({ error: { message: "Rate limit reached for test." } }), {
        status: 429,
        headers: { "content-type": "application/json", "x-request-id": "req_ralph_failure" },
      });
    }
    return new Response(JSON.stringify({
      output: [
        { type: "reasoning", encrypted_content: "opaque-test-reasoning" },
        { type: "message", content: [{ type: "output_text", text: "Inspect the remaining CI failure and fix the specific blocker before stopping." }] },
      ],
      usage: { input_tokens: 123, output_tokens: 17, total_tokens: 140 },
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_ralph_success" },
    });
  };
  const ralphController = new RalphController({
    registry: ralphControllerRegistry,
    commands: ralphCommands,
    apiKey: "test-key",
    model: "gpt-5.6-terra",
    auditLogPath: path.join(ralphControllerRoot, "ralph-openai.log"),
    checkEveryMs: 60_000,
  });
  try {
    const ralphUrl = `https://chatgpt.com/g/${projectId}/c/22222222-2222-4222-8222-222222222222`;
    await ralphControllerRegistry.register(ralphUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralphController.tick();
    const inspectCommand = await ralphCommands.claim("chrome-browser", ["ralph"], 1000);
    assert.equal(inspectCommand.kind, "inspect_thread");
    ralphCommands.complete({
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
    const continueCommand = await ralphCommands.claim("chrome-browser", ["ralph"], 1000);
    assert.equal(continueCommand.kind, "send_message");
    assert.equal(continueCommand.targetUrl, ralphUrl);
    assert.equal(continueCommand.message, "Inspect the remaining CI failure and fix the specific blocker before stopping.");
    assert.equal(apiRequest.model, "gpt-5.6-terra");
    assert.deepEqual(apiRequest.reasoning, { effort: "low" });
    assert.equal("max_output_tokens" in apiRequest, false,
      "RALPH must not impose an output-token budget on classification");
    assert.match(JSON.stringify(apiRequest.input), /Fix the implementation end to end/);
    assert.match(JSON.stringify(apiRequest.input), /one CI failure remains/);
    assert.ok(ralphOpenAiLogs.some(line => line.includes("[ralph/openai]") && line.includes('"event":"request_started"') &&
      line.includes(`"thread":${JSON.stringify(ralphUrl)}`) && line.includes('"model":"gpt-5.6-terra"') &&
      line.includes("Fix the implementation end to end") && line.includes("one CI failure remains")),
      "the request audit log includes the exact RALPH instruction and transcript sent to OpenAI");
    assert.ok(ralphOpenAiLogs.some(line => line.includes('"event":"request_succeeded"') &&
      line.includes('"request_id":"req_ralph_success"') && line.includes('"http_status":200') &&
      line.includes('"input_tokens":123') && line.includes('"output_tokens":17') &&
      line.includes('"total_tokens":140') && line.includes('"action":"continue"') &&
      line.includes("Inspect the remaining CI failure and fix the specific blocker before stopping.")),
      "the success audit log includes the exact OpenAI response body");
    assert.ok(ralphOpenAiLogs.every(line => !line.includes("test-key")),
      "RALPH OpenAI audit logs must not expose the API key");
    const persistedSuccessLogs = (await readFile(path.join(ralphControllerRoot, "ralph-openai.log"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    assert.equal(persistedSuccessLogs.length, 2);
    assert.equal(persistedSuccessLogs[0].event, "request_started");
    assert.match(persistedSuccessLogs[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(JSON.stringify(persistedSuccessLogs[0].request), /Fix the implementation end to end/);
    assert.deepEqual(persistedSuccessLogs[0].request.reasoning, { effort: "low" });
    assert.equal("max_output_tokens" in persistedSuccessLogs[0].request, false);
    assert.equal(persistedSuccessLogs[1].event, "request_succeeded");
    assert.equal(persistedSuccessLogs[1].request_id, "req_ralph_success");
    assert.equal(persistedSuccessLogs[1].total_tokens, 140);
    assert.equal(persistedSuccessLogs[1].response_text,
      "Inspect the remaining CI failure and fix the specific blocker before stopping.");
    assert.equal("response" in persistedSuccessLogs[1], false,
      "the success audit record stores extracted response text instead of the opaque API payload");
    assert.ok(!JSON.stringify(persistedSuccessLogs).includes("opaque-test-reasoning"));
    assert.ok(!JSON.stringify(persistedSuccessLogs).includes("test-key"));
    ralphCommands.complete({
      commandId: continueCommand.id,
      browserId: "chrome-browser",
      kind: "send_message",
      ok: true,
      result: { status: "sent", conversationUrl: ralphUrl },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    await ralphControllerRegistry.recordComplete("22222222-2222-4222-8222-222222222222");

    const shortRalphUrl = `https://chatgpt.com/g/${projectId}/c/33333333-3333-4333-8333-333333333333`;
    await ralphControllerRegistry.register(shortRalphUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralphController.tick();
    const shortInspectCommand = await ralphCommands.claim("chrome-browser", ["ralph"], 1000);
    assert.equal(shortInspectCommand.kind, "inspect_thread");
    ralphCommands.complete({
      commandId: shortInspectCommand.id,
      browserId: "chrome-browser",
      kind: "inspect_thread",
      ok: true,
      result: {
        status: "idle",
        workedSeconds: null,
        users: [{ id: "u3", text: "Finish this small task." }],
        assistant: { synthetic: false, id: "a2", text: "Done." },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(apiRequestCount, 1, "RALPH must not call OpenAI for a task that took 19 minutes or less");
    assert.equal(await ralphCommands.claim("chrome-browser", ["ralph"], 0), undefined);

    const unknownRalphUrl = `https://chatgpt.com/g/${projectId}/c/44444444-4444-4444-8444-444444444444`;
    await ralphControllerRegistry.register(unknownRalphUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralphController.tick();
    const unknownInspectCommand = await ralphCommands.claim("chrome-browser", ["ralph"], 1000);
    assert.equal(unknownInspectCommand.kind, "inspect_thread");
    ralphCommands.complete({
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
    assert.equal(apiRequestCount, 1, "RALPH must not call OpenAI when the worked duration is unavailable");
    assert.equal(await ralphCommands.claim("chrome-browser", ["ralph"], 0), undefined);

    const failedRalphUrl = `https://chatgpt.com/g/${projectId}/c/55555555-5555-4555-8555-555555555555`;
    await ralphControllerRegistry.register(failedRalphUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    failNextApiRequest = true;
    await ralphController.tick();
    const failedInspectCommand = await ralphCommands.claim("chrome-browser", ["ralph"], 1000);
    assert.equal(failedInspectCommand.kind, "inspect_thread");
    ralphCommands.complete({
      commandId: failedInspectCommand.id,
      browserId: "chrome-browser",
      kind: "inspect_thread",
      ok: true,
      result: {
        status: "idle",
        workedSeconds: 20 * 60,
        users: [{ id: "u5", text: "Finish the failing task." }],
        assistant: { synthetic: false, id: "a4", text: "A blocker remains." },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(apiRequestCount, 2);
    assert.ok(ralphOpenAiLogs.some(line => line.includes('"event":"request_failed"') &&
      line.includes('"request_id":"req_ralph_failure"') && line.includes('"http_status":429') &&
      line.includes('"duration_ms":') && line.includes("Rate limit reached for test")),
      "the failure audit log includes the exact OpenAI error response body");
    assert.match((await ralphControllerRegistry.threads()).find(thread => thread.conversationUrl === failedRalphUrl).lastError,
      /HTTP 429/, "an OpenAI failure remains visible in the RALPH thread state");
    const persistedLogs = (await readFile(path.join(ralphControllerRoot, "ralph-openai.log"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(persistedLogs.map(record => record.event), [
      "request_started",
      "request_succeeded",
      "request_started",
      "request_failed",
    ]);
    assert.equal(persistedLogs.at(-1).response.error.message, "Rate limit reached for test.");

    const blankRalphUrl = `https://chatgpt.com/g/${projectId}/c/77777777-7777-4777-8777-777777777777`;
    await ralphControllerRegistry.register(blankRalphUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralphController.tick();
    const blankInspectCommand = await ralphCommands.claim("chrome-browser", ["ralph"], 1000);
    assert.equal(blankInspectCommand.kind, "inspect_thread");
    ralphCommands.complete({
      commandId: blankInspectCommand.id,
      browserId: "chrome-browser",
      kind: "inspect_thread",
      ok: true,
      result: {
        status: "idle",
        workedSeconds: 20 * 60,
        users: [{ id: "u7", text: "" }],
        assistant: { synthetic: false, id: "a6", text: "" },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const blankThread = (await ralphControllerRegistry.threads())
      .find(thread => thread.conversationUrl === blankRalphUrl);
    assert.equal(apiRequestCount, 2, "RALPH must not classify a blank extracted transcript");
    assert.equal(blankThread.state, "active", "a blank extracted transcript must not complete the thread");
    assert.match(blankThread.lastError, /could not extract every ChatGPT user message/);
  } finally {
    ralphController.close();
    ralphCommands.close();
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  const blockedAuditRoot = path.join(temporaryRoot, "ralph-blocked-audit");
  const blockedAuditRegistry = await RalphRegistry.open(blockedAuditRoot, 20);
  await blockedAuditRegistry.setProjects([projectId]);
  const blockedAuditCommands = new SupportCommandBus();
  let blockedApiRequestCount = 0;
  globalThis.fetch = async () => {
    blockedApiRequestCount += 1;
    throw new Error("OpenAI must not be called when the audit log cannot be written.");
  };
  console.log = (...values) => ralphOpenAiLogs.push(values.join(" "));
  console.error = (...values) => ralphOpenAiLogs.push(values.join(" "));
  const blockedAuditController = new RalphController({
    registry: blockedAuditRegistry,
    commands: blockedAuditCommands,
    apiKey: "test-key",
    model: "gpt-5.6-terra",
    auditLogPath: blockedAuditRoot,
    checkEveryMs: 60_000,
  });
  try {
    const blockedAuditUrl = `https://chatgpt.com/g/${projectId}/c/66666666-6666-4666-8666-666666666666`;
    await blockedAuditRegistry.register(blockedAuditUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await blockedAuditController.tick();
    const blockedAuditInspect = await blockedAuditCommands.claim("chrome-browser", ["ralph"], 1000);
    blockedAuditCommands.complete({
      commandId: blockedAuditInspect.id,
      browserId: "chrome-browser",
      kind: "inspect_thread",
      ok: true,
      result: {
        status: "idle",
        workedSeconds: 20 * 60,
        users: [{ id: "u6", text: "Finish this audited task." }],
        assistant: { synthetic: false, id: "a5", text: "Work remains." },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(blockedApiRequestCount, 0,
      "RALPH must not spend money when it cannot persist the request audit record");
    assert.match((await blockedAuditRegistry.threads())[0].lastError, /Cannot persist the RALPH OpenAI audit log/);
  } finally {
    blockedAuditController.close();
    blockedAuditCommands.close();
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  const resource = await client.readResource({ uri: THREAD_SYNC_WIDGET_URI });
  assert.match(resource.contents[0].mimeType, /profile=mcp-app/);
  assert.equal(resource.contents[0]._meta.ui.prefersBorder, true);
  assert.doesNotMatch(resource.contents[0].text, /display:\s*none/);
  assert.match(resource.contents[0].text, /Thread Sync/);
  assert.ok(!resource.contents[0].text.includes(sync.extensionToken));

  await testContentScript(a.ticket.token, b.ticket.token);
  await testWorkerKeepsLongAutomationAlive(sync);
  await testRalphComposerObserver();
  await testSendWaitsForSettlementAndRetriesIgnoredClick();
  await testNewProjectComposerWithoutDataType();
  await testReactTrackedTextareaEnablesSendButton();
  await testRunningHydrationDetection();
  await testWorkedDurationDetection();
  await testRalphAutoRegistration(sync);
  await testRalphWorkerReactivation(sync);
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

  console.log("Thread sync passed: required sync/get sequencing, handshake waiting, long automation keepalive, blank-project composer discovery, React-tracked textarea input, browser-neutral WebExtension APIs, DOM-independent MCP UI routing, persistence, auth, real Fetch port checks, and CSP.");
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

async function testSendWaitsForSettlementAndRetriesIgnoredClick() {
  let automationListener;
  let now = 0;
  let userCount = 1;
  let generationStarted = false;
  const clickTimes = [];
  const editorEvents = [];
  const stopButton = {};
  const location = new URL(urlA);
  const editor = {
    textContent: "",
    focus() {},
    dispatchEvent(event) { editorEvents.push(event.type); },
    getAttribute(key) { return key === "contenteditable" ? "true" : null; },
  };
  const sendButton = {
    get disabled() { return now < 5_000; },
    getAttribute() { return null; },
    click() {
      clickTimes.push(now);
      if (clickTimes.length === 2) {
        editor.textContent = "";
        userCount = 2;
        generationStarted = true;
      }
    },
  };
  const composer = {
    getAttribute() { return null; },
    querySelector(selector) {
      if (selector === '#prompt-textarea[contenteditable="true"]') return editor;
      if (selector === 'button[data-testid="stop-button"]') return null;
      return null;
    },
  };
  const document = {
    readyState: "complete",
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"] [data-message-author-role="user"]') {
        return now >= 5_000 ? {} : null;
      }
      if (selector === '#composer-submit-button' || selector === 'button[aria-label="Send prompt"]') return sendButton;
      if (selector === 'form[data-type="unified-composer"] button[data-testid="stop-button"]' ||
          selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'section[data-turn="user"]') return Array.from({ length: userCount }, () => ({}));
      if (selector === "section[data-turn]") {
        return [{
          dataset: { turn: "assistant", turnId: "a1" },
          get textContent() { return now < 5_000 ? "Hydrating" : "Ready"; },
        }];
      }
      return [];
    },
    createRange() { return { selectNodeContents() {} }; },
    execCommand(command) {
      assert.equal(command, "insertText");
      return false;
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
  const window = {
    addEventListener() {},
    getSelection() {
      return { removeAllRanges() {}, addRange() {} };
    },
  };

  vm.runInNewContext(await readFile("support-extension/content-script.js", "utf8"), {
    window, location, document, browser,
    Date: { now: () => now },
    InputEvent: class {
      constructor(type) { this.type = type; }
    },
    setTimeout: fakeSetTimeout,
  });

  const response = await new Promise(resolve => {
    const keepChannelOpen = automationListener({
      type: "local-codex-support/automation-v1",
      command: { kind: "send_message", message: "hello" },
    }, {}, resolve);
    assert.equal(keepChannelOpen, true);
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.status, "sent");
  assert.equal(response.result.conversationUrl, urlA);
  assert.deepEqual(editorEvents, ["input"],
    "contenteditable insertion falls back to an input event when execCommand is unavailable");
  assert.equal(clickTimes.length, 2, "an ignored first click is retried once");
  assert.ok(clickTimes[0] >= 10_000,
    "an existing conversation must finish hydrating and remain stable before insertion");
  assert.ok(clickTimes[1] >= 30_000, "the retry does not start until the first 30-second send attempt has timed out");
  assert.ok(now >= clickTimes[1] + 2_000,
    "the automation tab remains open for two seconds after ChatGPT starts generating");
}

async function testNewProjectComposerWithoutDataType() {
  let automationListener;
  let now = 0;
  let generationStarted = false;
  let userCount = 0;
  const location = new URL(namedProjectHome);
  const stopButton = {};
  const editor = {
    textContent: "",
    focus() {},
    closest(selector) { return selector === "form" ? composer : null; },
    dispatchEvent() {},
    getAttribute(key) { return key === "contenteditable" ? "true" : null; },
  };
  const sendButton = {
    disabled: false,
    getAttribute(key) { return key === "aria-disabled" ? "false" : null; },
    click() {
      editor.textContent = "";
      userCount = 1;
      generationStarted = true;
      location.href = urlA;
    },
  };
  const composer = {
    getAttribute() { return null; },
    querySelector(selector) {
      if (selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
  };
  const document = {
    readyState: "complete",
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return null;
      if (selector === '#prompt-textarea[contenteditable="true"]' ||
          selector === 'textarea[name="prompt-textarea"]') return editor;
      if (selector === '#composer-submit-button' || selector === 'button[aria-label="Send prompt"]') return sendButton;
      if (selector === 'form[data-type="unified-composer"] button[data-testid="stop-button"]' ||
          selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'section[data-turn="user"]') return Array.from({ length: userCount }, () => ({}));
      return [];
    },
    createRange() { return { selectNodeContents() {} }; },
    execCommand() { return false; },
  };
  const browser = {
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener: listener => { automationListener = listener; } },
    },
  };
  const fakeSetTimeout = (callback, ms) => {
    now += ms;
    callback();
    return 1;
  };
  const window = {
    addEventListener() {},
    getSelection() { return { removeAllRanges() {}, addRange() {} }; },
  };

  vm.runInNewContext(await readFile("support-extension/content-script.js", "utf8"), {
    window, location, document, browser,
    Date: { now: () => now },
    InputEvent: class {},
    setTimeout: fakeSetTimeout,
  });
  const response = await new Promise(resolve => {
    automationListener({
      type: "local-codex-support/automation-v1",
      command: { kind: "send_message", message: "start the new project thread" },
    }, {}, resolve);
  });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.conversationUrl, urlA);
}

async function testReactTrackedTextareaEnablesSendButton() {
  let automationListener;
  let now = 0;
  let generationStarted = false;
  let userCount = 1;
  let visibleValue = "";
  let nativeValueWritten = false;
  let reactValue = "";
  const location = new URL(urlA);
  const message = "send the completed review to the parent";
  const stopButton = {};
  const textareaPrototype = {};
  Object.defineProperty(textareaPrototype, "value", {
    configurable: true,
    get() { return visibleValue; },
    set(value) {
      visibleValue = value;
      nativeValueWritten = true;
    },
  });
  const editor = Object.create(textareaPrototype);
  Object.defineProperty(editor, "value", {
    configurable: true,
    get() { return visibleValue; },
    set(value) {
      visibleValue = value;
      nativeValueWritten = false;
    },
  });
  Object.assign(editor, {
    focus() {},
    dispatchEvent(event) {
      if (event.type === "input" && nativeValueWritten) reactValue = visibleValue;
    },
    getAttribute(key) { return key === "name" ? "prompt-textarea" : null; },
  });
  const sendButton = {
    disabled: false,
    getAttribute(key) {
      if (key === "aria-disabled") return reactValue === message ? "false" : "true";
      return null;
    },
    click() {
      visibleValue = "";
      reactValue = "";
      userCount = 2;
      generationStarted = true;
    },
  };
  const composer = {
    getAttribute() { return null; },
    querySelector(selector) {
      if (selector === 'textarea[name="prompt-textarea"]') return editor;
      if (selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
  };
  const userTurn = { dataset: { turn: "user", turnId: "u1" }, textContent: "original request" };
  const document = {
    readyState: "complete",
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"] [data-message-author-role="user"]') return userTurn;
      if (selector === '#composer-submit-button' || selector === 'button[aria-label="Send prompt"]') return sendButton;
      if (selector === 'form[data-type="unified-composer"] button[data-testid="stop-button"]' ||
          selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'section[data-turn="user"]') return Array.from({ length: userCount }, () => ({}));
      if (selector === "section[data-turn]") return [userTurn];
      return [];
    },
    createRange() { return { selectNodeContents() {} }; },
    execCommand() { return false; },
  };
  const browser = {
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener: listener => { automationListener = listener; } },
    },
  };
  const fakeSetTimeout = (callback, ms) => {
    now += ms;
    callback();
    return 1;
  };
  const window = {
    addEventListener() {},
    getSelection() { return { removeAllRanges() {}, addRange() {} }; },
  };

  vm.runInNewContext(await readFile("support-extension/content-script.js", "utf8"), {
    window, location, document, browser,
    Date: { now: () => now },
    InputEvent: class {
      constructor(type) { this.type = type; }
    },
    setTimeout: fakeSetTimeout,
  });
  const response = await new Promise(resolve => {
    automationListener({
      type: "local-codex-support/automation-v1",
      command: { kind: "send_message", message },
    }, {}, resolve);
  });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.conversationUrl, urlA);
}

async function testRalphComposerObserver() {
  let observed;
  let running = false;
  const sent = [];
  const location = new URL(urlA);
  let createdElements = 0;
  const composer = {
    querySelector(selector) {
      if (selector === 'button[data-testid="stop-button"]') return running ? {} : null;
      return null;
    },
  };
  const document = {
    readyState: "complete",
    documentElement: {},
    createElement() { createdElements += 1; return {}; },
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === "#composer-submit-button" || selector === 'button[aria-label="Send prompt"]') {
        return running ? null : {};
      }
      return null;
    },
  };
  const browser = { runtime: {
    sendMessage: async message => {
      sent.push(message);
      return { ok: true, status: "scheduled" };
    },
    onMessage: { addListener() {} },
  } };
  class MutationObserver {
    constructor(listener) { observed = listener; }
    observe() {}
  }
  vm.runInNewContext(await readFile("support-extension/content-script.js", "utf8"), {
    window: { addEventListener() {} },
    location,
    document,
    browser,
    MutationObserver,
    setTimeout: callback => { callback(); return 1; },
  });
  assert.equal(createdElements, 0, "the content script does not add controls to the ChatGPT page");
  assert.equal(typeof observed, "function");
  assert.equal(sent.length, 0, "an initially idle composer does not reactivate RALPH");
  running = true;
  observed();
  await new Promise(resolve => setImmediate(resolve));
  const reactivations = sent.filter(message => message.type === "local-codex-support/ralph-reactivate-v1");
  assert.equal(reactivations.length, 1, "the send-to-stop transition reactivates the current RALPH thread");
  assert.equal(reactivations[0].conversationUrl, urlA);
  observed();
  assert.equal(sent.filter(message => message.type === "local-codex-support/ralph-reactivate-v1").length, 1,
    "later stop-button mutations do not repeat the reactivation");
  location.href = urlB;
  observed();
  assert.equal(sent.filter(message => message.type === "local-codex-support/ralph-reactivate-v1").length, 1,
    "loading a different thread directly into a stop-button state does not reactivate it");
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
  let ralphMinWorkedSeconds = 19 * 60;

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
    get textContent() {
      return now >= 3_000 ? `${assistantMessage.textContent} ${durationButton.textContent}` : assistantMessage.textContent;
    },
    querySelectorAll(selector) {
      if (selector === "button") return now >= 3_000 ? [durationButton] : [];
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
      let childText = "";
      return {
        style: {},
        setAttribute() {},
        get innerText() {
          return this.style.cssText?.includes("visibility:hidden") ? "" : childText;
        },
        appendChild(child) { childText = child.text; },
        remove() {},
      };
    },
  };
  const browser = {
    runtime: {
      sendMessage: async () => ({ status: "bound" }),
      onMessage: { addListener: fn => { automationListener = fn; } },
    },
    storage: {
      local: {
        get: async defaults => ({ ...defaults, ralphMinWorkedSeconds }),
      },
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
  assert.equal(response.result.users.length, 1);
  assert.equal(response.result.users[0].id, "F1");
  assert.equal(response.result.users[0].text, "Fix this end to end.",
    "RALPH inspection extracts the visible user message text");
  assert.equal(response.result.assistant.synthetic, false);
  assert.equal(response.result.assistant.id, "T1");
  assert.equal(response.result.assistant.text, "The implementation is complete.",
    "RALPH inspection extracts the visible final assistant message text");
  assert.equal(response.result.workedSeconds, 26 * 60 + 15,
    "RALPH inspection must parse a Worked for label that appears late during hydration");
  assert.ok(now >= 8_000, "RALPH waits for the hydrated assistant turn to remain settled before reading duration");

  durationButton.textContent = "Worked for 19m";
  const shortResponse = await new Promise(resolve => {
    automationListener({
      type: "local-codex-support/automation-v1",
      command: { kind: "inspect_thread" },
    }, {}, resolve);
  });
  assert.equal(shortResponse.ok, true);
  assert.equal(shortResponse.result.workedSeconds, null,
    "content-script RALPH cutoff filters durations at or below the configured threshold");

  ralphMinWorkedSeconds = 0;
  durationButton.textContent = "Worked for 1s";
  const testModeResponse = await new Promise(resolve => {
    automationListener({
      type: "local-codex-support/automation-v1",
      command: { kind: "inspect_thread" },
    }, {}, resolve);
  });
  assert.equal(testModeResponse.ok, true);
  assert.equal(testModeResponse.result.workedSeconds, 1,
    "RALPH inspection uses the popup-configured minimum worked time");
}


async function testRalphAutoRegistration(sync) {
  const generatedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), generatedConfig);
  const registrationBodies = [];
  const commandResults = [];
  const createdUrls = [];
  let historyListener;
  let updatedListener;
  const storage = { subagentProjectUrl: namedProjectHome };
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
        onUpdated: { addListener: fn => { updatedListener = fn; } },
        query: async () => [],
        create: async ({ url }) => { createdUrls.push(url); return { id: 11 }; },
        get: async () => ({ id: 11, status: "complete", url: namedProjectHome }),
        sendMessage: async () => ({ ok: true, result: { status: "sent", conversationUrl: urlB } }),
        remove: async () => {},
      },
      webNavigation: {
        onHistoryStateUpdated: { addListener: fn => { historyListener = fn; } },
        onCommitted: { addListener() {} },
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
      if (endpoint === generatedConfig.LOCAL_CODEX_THREAD_SYNC.ralphRegisterUrl) {
        registrationBodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ status: "registered" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (endpoint === generatedConfig.LOCAL_CODEX_THREAD_SYNC.commandResultUrl) {
        commandResults.push(JSON.parse(options.body));
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected support fetch: ${endpoint}`);
    },
  };

  vm.runInNewContext(await readFile("support-extension/service-worker.js", "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof historyListener, "function");
  assert.equal(typeof updatedListener, "function");

  historyListener({ frameId: 0, url: urlA });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(registrationBodies, [{ conversationUrl: urlA }],
    "a ChatGPT SPA navigation into a project conversation registers it without thread sync");

  historyListener({ frameId: 0, url: urlA });
  updatedListener(1, { url: urlA });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registrationBodies.length, 1, "duplicate route observations are deduplicated in the extension");

  historyListener({ frameId: 0, url: "https://chatgpt.com/c/55555555-5555-4555-8555-555555555555" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registrationBodies.length, 1, "normal non-project conversations are never offered to RALPH");

  await context.executeCommand({
    id: "agent-project-thread",
    feature: "threadMessaging",
    kind: "send_message",
    message: "spawn the project sub-agent",
  }, "browser-a");
  assert.equal(createdUrls.at(-1), namedProjectHome,
    "a target-less new-thread command opens the project saved in extension settings");
  assert.deepEqual(registrationBodies.at(-1), { conversationUrl: urlB },
    "an AI-created project thread is registered from its saved conversation URL");
  assert.equal(commandResults.at(-1).ok, true);
}

async function testRalphWorkerReactivation(sync) {
  const generatedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), generatedConfig);
  const extensionId = "a".repeat(32);
  const storage = {};
  const requests = [];
  let runtimeListener;
  let updatedListener;
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
        id: extensionId,
        onMessage: { addListener: listener => { runtimeListener = listener; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      tabs: {
        onUpdated: { addListener: listener => { updatedListener = listener; } },
        query: async () => [],
        get: async () => ({ id: 7, url: urlA }),
      },
      webNavigation: {
        onHistoryStateUpdated: { addListener() {} },
        onCommitted: { addListener() {} },
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
      requests.push({ endpoint, options });
      if (endpoint === generatedConfig.LOCAL_CODEX_THREAD_SYNC.ralphRegisterUrl) {
        return new Response(JSON.stringify({ status: "registered" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "scheduled" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  };
  vm.runInNewContext(await readFile("support-extension/service-worker.js", "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  updatedListener(7, { url: urlA });
  await new Promise(resolve => setImmediate(resolve));
  const registrationRequests = () => requests.filter(request =>
    request.endpoint === generatedConfig.LOCAL_CODEX_THREAD_SYNC.ralphRegisterUrl);
  assert.deepEqual(JSON.parse(registrationRequests()[0].options.body), { conversationUrl: urlA });

  const reactivation = await new Promise(resolve => {
    runtimeListener({
      type: "local-codex-support/ralph-reactivate-v1",
      conversationUrl: urlA,
    }, {
      id: extensionId,
      frameId: 0,
      tab: { id: 7 },
      url: urlA,
    }, resolve);
  });
  assert.equal(reactivation.ok, true);
  assert.equal(registrationRequests().length, 2,
    "composer reactivation bypasses navigation registration deduplication");
  assert.deepEqual(JSON.parse(registrationRequests()[1].options.body), {
    conversationUrl: urlA,
    reactivate: true,
  });
}

async function testWorkerKeepsLongAutomationAlive(sync) {
  const generatedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), generatedConfig);
  let keepAliveCallback;
  let keepAliveCalls = 0;
  let resolveAutomation;
  const automationResult = new Promise(resolve => { resolveAutomation = resolve; });
  const storage = {};
  const context = {
    URL,
    AbortSignal,
    AbortController,
    crypto: globalThis.crypto,
    console,
    Response,
    importScripts() {},
    setTimeout(callback, ms) {
      if (ms === 20_000) {
        keepAliveCallback = callback;
        return 99;
      }
      return setTimeout(callback, ms);
    },
    clearTimeout(timer) {
      if (timer !== 99) clearTimeout(timer);
    },
    LOCAL_CODEX_THREAD_SYNC: generatedConfig.LOCAL_CODEX_THREAD_SYNC,
    browser: {
      runtime: {
        id: "a".repeat(32),
        getPlatformInfo: async () => { keepAliveCalls += 1; },
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      tabs: {
        onUpdated: { addListener() {} },
        query: async () => [],
        create: async () => ({ id: 11 }),
        get: async () => ({ id: 11, status: "complete", url: namedProjectHome }),
        sendMessage: async () => await automationResult,
        remove: async () => {},
      },
      webNavigation: {
        onHistoryStateUpdated: { addListener() {} },
        onCommitted: { addListener() {} },
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
    fetch: async () => new Response("", { status: 200 }),
  };
  vm.runInNewContext(await readFile("support-extension/service-worker.js", "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));

  const command = context.executeCommand({
    id: "long-send",
    feature: "threadMessaging",
    kind: "send_message",
    targetUrl: namedProjectHome,
    message: "start a project thread",
  }, "browser-a");
  await new Promise(resolve => setImmediate(resolve));
  await keepAliveCallback?.();
  resolveAutomation({ ok: true, result: { status: "sent", conversationUrl: urlA } });
  await command;
  assert.equal(keepAliveCalls, 1,
    "a long ChatGPT automation call must reset the extension worker idle timer before Chrome closes its response channel");
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
  assert.equal(context.automationTargetMatches(namedProjectHome, `https://chatgpt.com/g/${projectId}/project`), true,
    "project display-name suffixes do not change the automation target identity");
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
