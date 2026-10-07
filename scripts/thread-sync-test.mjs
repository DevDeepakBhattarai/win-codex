import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { EventEmitter } from "node:events";
import path from "node:path";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { THREAD_SYNC_AGENT_INSTRUCTION, THREAD_SYNC_WIDGET_URI, ThreadSyncRegistry, parseConversationUrl, prepareThreadSync, registerThreadSync, threadSyncBindHandler, threadSyncBindUrl } from "../dist/thread-sync.js";
import { RalphController, RalphRegistry, SupportCommandBus, ThreadPreparationCoordinator, ThreadTabCleanupController, parseRalphProjectId, ralphRegistrationHandler, ralphSettingsGetHandler, ralphSettingsPutHandler, ralphThreadActiveHandler, ralphThreadCheckHandler, ralphThreadCompleteHandler, ralphThreadsGetHandler, registerChatGptAgents, supportCommandClaimHandler, threadObservationHandler } from "../dist/chatgpt-support.js";
import { SubagentJobRegistry } from "../dist/subagent-jobs.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "win-codex-thread-sync-test-"));
const projectId = "g-p-6a87fafd6d948191ab3338e485c07c39";
const namedProjectHome = `https://chatgpt.com/g/${projectId}-deepak/project`;
const urlA = `https://chatgpt.com/g/${projectId}/c/11111111-1111-4111-8111-111111111111`;
const urlB = `https://chatgpt.com/g/${projectId}/c/12345678-abcd-4321-abcd-123456789abc`;
const urlC = `https://chatgpt.com/g/${projectId}/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const urlD = `https://chatgpt.com/g/${projectId}/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
const urlE = `https://chatgpt.com/g/${projectId}/c/cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
const idA = { ownerId: "grant-one", sessionId: "session-A" };
const idB = { ownerId: "grant-one", sessionId: "session-B" };
let client;
let server;
let supportCommands;
let ralphRegistry;
let subagentJobs;
let threadPreparer;
let automationLaunches = 0;
const launchSupportBrowser = async () => { automationLaunches += 1; };

try {
  assert.equal(threadSyncBindUrl(), "http://127.0.0.1:6002/thread-sync/bind");
  assert.match(THREAD_SYNC_AGENT_INSTRUCTION, /without a Thread Sync startup step/);
  assert.match(THREAD_SYNC_AGENT_INSTRUCTION, /reading local result files require no syncing/);
  assert.doesNotMatch(THREAD_SYNC_AGENT_INSTRUCTION, /first MCP action/);
  assert.match(THREAD_SYNC_AGENT_INSTRUCTION, /Reuse an existing binding across turns/);
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
  assert.equal(manifest.version, "1.20.1");
  assert.equal(manifest.minimum_chrome_version, undefined, "thread sync is not tied to a Chrome-branded minimum");
  assert.deepEqual(manifest.permissions, ["alarms", "scripting", "sidePanel", "storage", "tabs", "webNavigation"]);
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'self'; connect-src http://127.0.0.1:*");
  for (const file of ["popup.html", "popup.js", "popup.css"]) {
    assert.equal(await readFile(path.join(sync.extensionDirectory, file), "utf8"), await readFile(path.join("support-extension", file), "utf8"),
      "generated extension includes the current UI asset " + file);
  }
  const preparedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), preparedConfig);
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.commandClaimUrl, "http://127.0.0.1:6002/chatgpt-support/commands/claim");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.commandResultUrl, "http://127.0.0.1:6002/chatgpt-support/commands/result");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.threadObserveUrl, "http://127.0.0.1:6002/chatgpt-support/threads/observe");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.ralphRegisterUrl, "http://127.0.0.1:6002/chatgpt-support/ralph/register");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.ralphProjectsUrl, "http://127.0.0.1:6002/chatgpt-support/ralph/projects");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.ralphSettingsUrl, "http://127.0.0.1:6002/chatgpt-support/ralph/settings");
  assert.equal(preparedConfig.LOCAL_CODEX_THREAD_SYNC.ralphThreadsUrl, "http://127.0.0.1:6002/chatgpt-support/ralph/threads");
  const preparedServiceWorker = await readFile(path.join(sync.extensionDirectory, "service-worker.js"), "utf8");
  assert.match(preparedServiceWorker, /if \(settings\.threadSync && settings\.automationExecutor\) features\.push\("threadPreparation"\)/,
    "only the explicitly designated automation browser claims thread preparation");
  assert.match(preparedServiceWorker, /canPrepare: settings\.automationExecutor/,
    "route observations declare whether their browser is the preparation executor");
  assert.match(preparedServiceWorker, /observingConversations\.get\(currentUrl\)/,
    "simultaneous duplicate route observations share one backend request");
  assert.match(preparedServiceWorker, /canonicalProjectId\(match\[1\]\)/,
    "service-worker thread matching canonicalizes project-name slugs");
  assert.doesNotMatch(preparedServiceWorker, /threadMessaging\) features\.push\("threadPreparation"\)/,
    "a thread-messaging observer such as Helium never implicitly claims thread preparation");
  assert.match(preparedServiceWorker, /SUPPORT_POLL_PERIOD_MINUTES = 1/,
    "the Chrome executor has a periodic MV3 wake-up instead of relying on an immortal service worker");
  assert.match(preparedServiceWorker, /alarms\?\.onAlarm\?\.addListener/,
    "the polling alarm wakes command claiming after the extension worker is suspended");
  const preparedContentScript = await readFile(path.join(sync.extensionDirectory, "content-script.js"), "utf8");
  assert.doesNotMatch(preparedContentScript, /Run RALPH now|installManualRalphButton/,
    "the content script does not inject a RALPH button into ChatGPT");
  assert.doesNotMatch(preparedContentScript, /editorMatchesMessage/,
    "page automation never compares ChatGPT-normalized prompt text with the original prompt");
  assert.equal((preparedContentScript.match(/insertMessage\(ready\.editor, message\)/g) ?? []).length, 1,
    "page automation has exactly one prompt insertion call site");
  assert.equal((preparedContentScript.match(/current\.button\.click\(\)/g) ?? []).length, 1,
    "page automation has exactly one send click call site");
  assert.doesNotMatch(preparedContentScript, /waitForSubmissionAcknowledged|composerSettledSignature|turnsSettledSignature/,
    "thread sending does not use acknowledgement or DOM-stability heuristics");
  assert.match(preparedContentScript, /const SEND_SETTLE_MS = 5_000;/,
    "thread sending uses the fixed five-second settle requested for typing and sending");
  assert.match(preparedContentScript, /contentScriptVersion = "1\.20\.1"/,
    "extension reloads can replace a stale page script with the current content-script version");
  assert.equal(parseRalphProjectId(namedProjectHome), projectId);
  assert.equal(parseRalphProjectId(urlA), projectId);

  const registry = sync.registry;
  ralphRegistry = await RalphRegistry.open(temporaryRoot, 20);
  await ralphRegistry.setProjects([projectId]);
  supportCommands = new SupportCommandBus();
  subagentJobs = await SubagentJobRegistry.open(path.join(temporaryRoot, "subagent-jobs"));
  threadPreparer = new ThreadPreparationCoordinator(supportCommands, registry, async () => undefined);
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
  assert.equal(refreshContext.conversationUrl, bareUrlA);
  assert.equal(refreshContext.ticket, undefined,
    "a bound thread never creates a second sync ticket");
  assert.equal((await routeRefreshRegistry.waitForBinding(routeRefreshIdentity, 1_000)).conversationUrl, bareUrlA,
    "repeated lookup returns the permanent binding immediately");
  assert.equal((await routeRefreshRegistry.bind(routeRefreshTicket.ticket.token, urlA)).conversationUrl, bareUrlA,
    "replaying the original ticket cannot refresh or mutate an established binding");
  assert.equal((await routeRefreshRegistry.binding(routeRefreshIdentity)).conversationUrl, bareUrlA);
  const projectScopedRegistry = await RalphRegistry.open(routeRefreshRoot, 20);
  assert.equal(await projectScopedRegistry.register(urlA), "ignored",
    "RALPH ignores project threads until their project is explicitly configured");
  assert.deepEqual(await projectScopedRegistry.setProjects([namedProjectHome, projectId]), [projectId],
    "named project home URLs canonicalize to the stable project id");
  assert.equal(await projectScopedRegistry.register(urlA), "registered");
  assert.equal(await projectScopedRegistry.register(urlA, { title: "RALPH - New chat" }), "active");
  assert.equal(await projectScopedRegistry.register(urlA, { title: "RALPH \u2013 New chat" }), "active");
  assert.equal((await projectScopedRegistry.threads())[0].title, undefined,
    "server-side RALPH state rejects project/new-chat placeholder titles for common separators");
  assert.equal(await projectScopedRegistry.register(urlA, { title: "RALPH - Durable thread title - ChatGPT" }), "active");
  assert.equal((await projectScopedRegistry.threads())[0].title, "RALPH - Durable thread title",
    "a real title is normalized and persisted by the server registry");
  assert.equal((await (await RalphRegistry.open(routeRefreshRoot, 20)).threads())[0].title, "RALPH - Durable thread title",
    "RALPH titles survive reopening the server-side JSON registry");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await projectScopedRegistry.due()).some(thread => thread.conversationUrl === urlA), true);
  const runningCheckedAt = Date.now();
  await projectScopedRegistry.recordRunning(parseConversationUrl(urlA).threadId);
  const [runningThread] = await projectScopedRegistry.threads();
  assert.ok(runningThread.nextCheckAt >= runningCheckedAt + 15 &&
    runningThread.nextCheckAt <= runningCheckedAt + 120,
  "a running RALPH thread is rechecked using the configured short interval");
  const continuationSentAt = Date.now();
  await projectScopedRegistry.recordContinuation(parseConversationUrl(urlA).threadId);
  const [continuedThread] = await projectScopedRegistry.threads();
  assert.ok(continuedThread.nextCheckAt >= continuationSentAt + 15 &&
    continuedThread.nextCheckAt <= continuationSentAt + 120,
  "a continued RALPH thread is rechecked using the configured short interval");
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
  await projectScopedRegistry.setLoopIntervalSeconds(120);
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
  assert.ok(reactivatedThread.nextCheckAt >= activatedAt + 119_900 && reactivatedThread.nextCheckAt <= activatedAt + 120_100,
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
  const preparationRoot = path.join(temporaryRoot, "thread-preparation");
  const preparationBindings = await ThreadSyncRegistry.open(preparationRoot);
  const preparationCommands = new SupportCommandBus();
  let preparationLaunches = 0;
  const preparationCoordinator = new ThreadPreparationCoordinator(
    preparationCommands,
    preparationBindings,
    async () => { preparationLaunches += 1; },
  );
  const observationRegistry = await RalphRegistry.open(path.join(preparationRoot, "ralph"));
  const externalThread = parseConversationUrl(urlC).threadId;
  assert.equal(await observationRegistry.register(urlC, { externalUpdate: true }), "ignored",
    "external activity cannot register an ordinary project");
  await observationRegistry.register(urlC, { manual: true });
  assert.equal(await observationRegistry.externalRevision(urlC), undefined);
  await observationRegistry.register(urlC, { externalUpdate: true });
  const firstRevision = await observationRegistry.externalRevision(urlC);
  assert.ok(firstRevision);
  await observationRegistry.register(urlC, { title: "Observed title" });
  assert.equal(await observationRegistry.externalRevision(urlC), firstRevision, "title and route observations do not invalidate a tab");
  const restoredRegistry = await RalphRegistry.open(path.join(preparationRoot, "ralph"));
  assert.equal(await restoredRegistry.externalRevision(urlC), firstRevision, "stale state survives a backend restart");
  const revisionBus = new SupportCommandBus(undefined, undefined, undefined, undefined, restoredRegistry);
  const revisionRequest = revisionBus.execute({ feature: "ralph", kind: "inspect_thread", conversationUrl: urlC });
  const revisionCommand = await revisionBus.claim("chrome", ["ralph"], 1000);
  assert.equal(revisionCommand.refreshRevision, firstRevision);
  revisionBus.complete({ commandId: revisionCommand.id, browserId: "chrome", kind: "inspect_thread", ok: true, result: { status: "running" } });
  await revisionRequest;
  revisionBus.close();
  await observationRegistry.recordComplete(externalThread);
  const preparationHandler = threadObservationHandler(preparationCoordinator, sync.extensionToken, observationRegistry);
  const requestPreparation = (body, authorization = `Bearer ${sync.extensionToken}`) => new Promise(resolve => {
    const response = {
      status(code) { response.code = code; return response; },
      json(responseBody) { resolve({ code: response.code ?? 200, body: responseBody }); },
      setHeader() {},
    };
    preparationHandler({
      body,
      get: name => (name === "authorization" ? authorization : undefined),
    }, response);
  });
  assert.equal((await requestPreparation({ conversationUrl: urlC }, "Bearer wrong")).code, 401);
  assert.deepEqual(await requestPreparation({ conversationUrl: urlC, canPrepare: false }), {
    code: 200,
    body: { status: "observed" },
  }, "a Helium observation records presence without scheduling Chrome preparation");
  assert.deepEqual(await requestPreparation({ conversationUrl: urlB }), {
    code: 200, body: { status: "ignored" },
  }, "ordinary unregistered observations must not launch Chrome");
  assert.deepEqual(await requestPreparation({ conversationUrl: urlC }), {
    code: 200, body: { status: "ignored" },
  }, "completed observations must not launch Chrome");
  assert.equal(preparationLaunches, 0, "observer-only and unmanaged routes must not launch Chrome");
  for (const url of [urlC, urlD, urlE]) await observationRegistry.register(url, { manual: true });
  assert.deepEqual(await requestPreparation({ conversationUrl: urlC }), {
    code: 200,
    body: { status: "preparing" },
  });
  assert.deepEqual(await requestPreparation({ conversationUrl: urlC }), {
    code: 200,
    body: { status: "preparing" },
  });
  assert.equal(preparationLaunches, 1,
    "duplicate observations share one backend Chrome launch while preparation is in flight");
  const freshPreparation = await preparationCommands.claim("chrome-preparer", ["threadPreparation"], 1000);
  assert.equal(freshPreparation.kind, "prepare_thread");
  assert.equal(freshPreparation.conversationUrl, urlC);
  assert.equal(await preparationCommands.claim("helium-observer", ["threadPreparation"], 0), undefined,
    "only one automation browser can claim the preparation command");
  preparationCommands.complete({
    commandId: freshPreparation.id,
    browserId: "chrome-preparer",
    kind: "prepare_thread",
    ok: true,
    result: { status: "prepared", conversationUrl: urlC },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await requestPreparation({ conversationUrl: urlC }), {
    code: 200,
    body: { status: "prepared" },
  }, "a successfully prepared unsynced thread is prepared only once per server run");
  assert.equal(await preparationCommands.claim("chrome-preparer", ["threadPreparation"], 0), undefined,
    "re-observing a prepared but still-unsynced thread does not schedule another preparation");
  const preparedIdentity = { ownerId: "prepared-grant", sessionId: "prepared-session" };
  const preparedTicket = await preparationBindings.context(preparedIdentity);
  await preparationBindings.bind(preparedTicket.ticket.token, urlC);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(await requestPreparation({ conversationUrl: urlC }), {
    code: 200,
    body: { status: "prepared" },
  }, "binding status does not discard the persistent preparation state");
  assert.equal(await preparationCommands.claim("chrome-preparer", ["threadPreparation"], 0), undefined);

  const alreadyBoundIdentity = { ownerId: "already-bound-grant", sessionId: "already-bound-session" };
  const alreadyBoundTicket = await preparationBindings.context(alreadyBoundIdentity);
  await preparationBindings.bind(alreadyBoundTicket.ticket.token, urlE);
  assert.deepEqual(await requestPreparation({ conversationUrl: urlE }), {
    code: 200,
    body: { status: "preparing" },
  }, "an already-bound observed thread is still opened in the automation browser");
  const alreadyBoundPreparation = await preparationCommands.claim("chrome-preparer", ["threadPreparation"], 1000);
  assert.equal(alreadyBoundPreparation.conversationUrl, urlE);
  preparationCommands.complete({
    commandId: alreadyBoundPreparation.id,
    browserId: "chrome-preparer",
    kind: "prepare_thread",
    ok: true,
    result: { status: "prepared", conversationUrl: urlE },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(await requestPreparation({ conversationUrl: urlD, canPrepare: true }), {
    code: 200,
    body: { status: "preparing" },
  });
  assert.equal(preparationLaunches, 1,
    "an observation from an automation executor does not launch Chrome again during extension startup");
  const executorPreparation = await preparationCommands.claim("chrome-preparer", ["threadPreparation"], 1000);
  assert.equal(executorPreparation.conversationUrl, urlD);
  preparationCommands.complete({
    commandId: executorPreparation.id,
    browserId: "chrome-preparer",
    kind: "prepare_thread",
    ok: true,
    result: { status: "prepared", conversationUrl: urlD },
  });
  const executorIdentity = { ownerId: "executor-grant", sessionId: "executor-session" };
  const executorTicket = await preparationBindings.context(executorIdentity);
  await preparationBindings.bind(executorTicket.ticket.token, urlD);
  preparationCoordinator.markBound(parseConversationUrl(urlD).threadId);
  preparationCommands.close();

  const boundedPreparationRoot = path.join(temporaryRoot, "bounded-thread-preparation");
  const boundedPreparationBindings = await ThreadSyncRegistry.open(boundedPreparationRoot);
  const boundedPreparationCommands = new SupportCommandBus();
  const boundedPreparer = new ThreadPreparationCoordinator(
    boundedPreparationCommands,
    boundedPreparationBindings,
    async () => undefined,
  );
  const boundedUrls = [
    `https://chatgpt.com/g/${projectId}/c/d1111111-1111-4111-8111-111111111111`,
    `https://chatgpt.com/g/${projectId}/c/d2222222-2222-4222-8222-222222222222`,
    `https://chatgpt.com/g/${projectId}/c/d3333333-3333-4333-8333-333333333333`,
    `https://chatgpt.com/g/${projectId}/c/d4444444-4444-4444-8444-444444444444`,
  ];
  for (const conversationUrl of boundedUrls) await boundedPreparer.schedule(conversationUrl, true);
  const boundedPreparationBatch = [];
  for (let index = 0; index < 3; index += 1) {
    const command = await boundedPreparationCommands.claim("bounded-preparer", ["threadPreparation"], 1000);
    boundedPreparationBatch.push(command);
    boundedPreparationCommands.complete({
      commandId: command.id,
      browserId: "bounded-preparer",
      kind: "prepare_thread",
      ok: true,
      result: { status: "prepared", conversationUrl: command.conversationUrl },
    });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await boundedPreparationCommands.claim("bounded-preparer", ["threadPreparation"], 0), undefined,
    "at most three thread preparations can be active at once");
  boundedPreparer.markBound(parseConversationUrl(boundedPreparationBatch[0].conversationUrl).threadId);
  await new Promise(resolve => setImmediate(resolve));
  const fourthPreparation = await boundedPreparationCommands.claim("bounded-preparer", ["threadPreparation"], 1000);
  assert.equal(fourthPreparation.conversationUrl, boundedUrls[3],
    "the next queued preparation starts when a preparation slot is released");
  boundedPreparationCommands.complete({
    commandId: fourthPreparation.id,
    browserId: "bounded-preparer",
    kind: "prepare_thread",
    ok: true,
    result: { status: "prepared", conversationUrl: fourthPreparation.conversationUrl },
  });
  for (const conversationUrl of boundedUrls) boundedPreparer.markBound(parseConversationUrl(conversationUrl).threadId);
  await new Promise(resolve => setImmediate(resolve));
  boundedPreparationCommands.close();
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
  assert.ok(messageReactivatedThread.nextCheckAt >= messageSentAt + 119_900 &&
    messageReactivatedThread.nextCheckAt <= messageSentAt + 120_100,
  "the composer transition starts a fresh check interval from the new message");
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
  assert.deepEqual(await registerThread({ conversationUrl: urlB, agentCreated: true, title: "Task auth refresh - ChatGPT" }), {
    code: 200,
    body: { status: "registered" },
  });
  const agentCreatedThread = (await projectScopedRegistry.threads()).find(thread => thread.conversationUrl === urlB);
  assert.deepEqual(agentCreatedThread && {
    conversationUrl: agentCreatedThread.conversationUrl,
    agentCreated: agentCreatedThread.agentCreated,
    state: agentCreatedThread.state,
    title: agentCreatedThread.title,
  }, { conversationUrl: urlB, agentCreated: true, state: "active", title: "Task auth refresh" },
  "AI-created sub-agents register even when their project is not allowlisted");
  await projectScopedRegistry.setProjects([]);
  assert.equal((await projectScopedRegistry.threads()).length, 2,
    "project allowlist changes retain AI-created sub-agents in RALPH");
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
  const registeredAt = Date.now();
  await timingRegistry.register(urlA);
  const [initiallyScheduledThread] = await timingRegistry.threads();
  assert.ok(initiallyScheduledThread.nextCheckAt >= registeredAt + 179_900 &&
    initiallyScheduledThread.nextCheckAt <= registeredAt + 180_100,
  "a new RALPH thread is scheduled for the default 3-minute repeated check");
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
  assert.deepEqual((await requestRalphSettings(getRalphSettings)).body, { loopIntervalSeconds: 180, minWorkedSeconds: 1800, subagentProjectUrl: undefined });
  assert.equal((await requestRalphSettings(getRalphSettings, undefined, "Bearer wrong")).status, 401);
  const intervalChangedAt = Date.now();
  assert.deepEqual((await requestRalphSettings(putRalphSettings, { loopIntervalSeconds: 120 })).body,
    { loopIntervalSeconds: 120, minWorkedSeconds: 1800, subagentProjectUrl: undefined });
  const [rescheduledThread] = await timingRegistry.threads();
  assert.ok(rescheduledThread.nextCheckAt >= intervalChangedAt + 119_900 &&
    rescheduledThread.nextCheckAt <= intervalChangedAt + 120_100,
    "changing the check interval reschedules active threads from the current time");
  assert.deepEqual((await requestRalphSettings(getRalphSettings)).body, { loopIntervalSeconds: 120, minWorkedSeconds: 1800, subagentProjectUrl: undefined });
  assert.equal((await requestRalphSettings(putRalphSettings, { loopIntervalSeconds: 119 })).status, 400);
  assert.equal((await requestRalphSettings(putRalphSettings, { minWorkedSeconds: -1 })).status, 400);
  assert.equal((await requestRalphSettings(putRalphSettings, { minWorkedSeconds: 86_401 })).status, 400);
  assert.equal((await requestRalphSettings(putRalphSettings, { minWorkedSeconds: 1801 })).body.minWorkedSeconds, 1801);
  assert.equal((await (await RalphRegistry.open(timingRoot)).settings()).minWorkedSeconds, 1801, "the worked-duration setting survives restart independently of the polling interval");
  await requestRalphSettings(putRalphSettings, { minWorkedSeconds: 1800 });
  assert.deepEqual(await (await RalphRegistry.open(timingRoot)).settings(),
    { loopIntervalSeconds: 120, minWorkedSeconds: 1800, subagentProjectUrl: undefined },
    "the RALPH check interval survives a server restart");
  assert.deepEqual((await requestRalphSettings(putRalphSettings, { minWorkedSeconds: 1800, subagentProjectUrl: namedProjectHome })).body,
    { loopIntervalSeconds: 120, minWorkedSeconds: 1800, subagentProjectUrl: namedProjectHome });
  assert.equal((await (await RalphRegistry.open(timingRoot)).settings()).subagentProjectUrl, namedProjectHome,
    "the Sub-agent project is persisted by the server");

  const oldIntervalRoot = path.join(temporaryRoot, "ralph-old-default-interval");
  await mkdir(oldIntervalRoot, { recursive: true });
  const oldIntervalNextCheckAt = Date.now() + 25 * 60 * 1000;
  await writeFile(path.join(oldIntervalRoot, "ralph.json"), JSON.stringify({
    version: 2,
    projects: [projectId],
    threads: [{
      conversationUrl: urlA,
      threadId: parseConversationUrl(urlA).threadId,
      registeredAt: new Date().toISOString(),
      nextCheckAt: oldIntervalNextCheckAt,
      state: "active",
      mode: "normal",
    }],
    loopIntervalMs: 25 * 60 * 1000,
  }));
  const oldIntervalOpenedAt = Date.now();
  const migratedIntervalRegistry = await RalphRegistry.open(oldIntervalRoot);
  assert.deepEqual(await migratedIntervalRegistry.settings(), { loopIntervalSeconds: 180, minWorkedSeconds: 1800, subagentProjectUrl: undefined },
    "the previous 25-minute default migrates to the repeated 3-minute check interval");
  const [migratedIntervalThread] = await migratedIntervalRegistry.threads();
  assert.ok(migratedIntervalThread.nextCheckAt >= oldIntervalOpenedAt + 179_900 &&
    migratedIntervalThread.nextCheckAt <= oldIntervalOpenedAt + 180_100,
    "migration pulls already-active threads forward instead of leaving an old 25-minute wait in place");

  const interimIntervalRoot = path.join(temporaryRoot, "ralph-interim-default-interval");
  await mkdir(interimIntervalRoot, { recursive: true });
  await writeFile(path.join(interimIntervalRoot, "ralph.json"), JSON.stringify({
    version: 2,
    projects: [projectId],
    threads: [{
      conversationUrl: urlA,
      threadId: parseConversationUrl(urlA).threadId,
      registeredAt: new Date().toISOString(),
      nextCheckAt: Date.now() + 10_000,
      state: "active",
      mode: "normal",
    }],
    loopIntervalMs: 10_000,
  }));
  const interimOpenedAt = Date.now();
  const interimIntervalRegistry = await RalphRegistry.open(interimIntervalRoot);
  assert.deepEqual(await interimIntervalRegistry.settings(), { loopIntervalSeconds: 180, minWorkedSeconds: 1800, subagentProjectUrl: undefined },
    "the temporary 10-second default also migrates to the 3-minute check interval");
  const [interimIntervalThread] = await interimIntervalRegistry.threads();
  assert.ok(interimIntervalThread.nextCheckAt >= interimOpenedAt + 179_900 &&
    interimIntervalThread.nextCheckAt <= interimOpenedAt + 180_100);

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
  registerChatGptAgents(server, supportCommands, registry, subagentJobs, threadPreparer, launchSupportBrowser, "mcp-grant");
  client = new Client({ name: "thread-sync-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  const syncDefinition = tools.find(tool => tool.name === "sync_current_thread");
  const getDefinition = tools.find(tool => tool.name === "get_current_thread_url");
  const sendThreadDefinition = tools.find(tool => tool.name === "send_thread_message");
  assert.ok(tools.some(tool => tool.name === "start_thread"));
  assert.equal(tools.some(tool => ["start_task", "list_tasks", "task_done", "start_subagent", "cancel_subagent", "list_subagents", "submit_subagent_result"].includes(tool.name)), false);
  assert.equal(syncDefinition._meta.ui.resourceUri, THREAD_SYNC_WIDGET_URI);
  assert.equal(getDefinition._meta?.ui, undefined);
  assert.match(sendThreadDefinition.description, /deduplicated internally/);
  assert.deepEqual([...sendThreadDefinition.inputSchema.required].sort(), ["message", "targetUrl"]);
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
  const repeatedSync = await syncCall("mcp-A");
  assert.deepEqual(repeatedSync.structuredContent, { status: "synced", conversationUrl: urlA });
  assert.equal(repeatedSync._meta?.["local-codex/thread-binding"], undefined,
    "a synced thread returns its saved URL without issuing another handshake ticket");
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

  const browserPresenceBus = new SupportCommandBus();
  let browserPresenceLaunches = 0;
  assert.equal(await browserPresenceBus.claim("recent-browser", ["threadMessaging"], 0), undefined);
  await browserPresenceBus.ensureBrowser("threadMessaging", async () => { browserPresenceLaunches += 1; });
  assert.equal(browserPresenceLaunches, 0,
    "a recently polling messaging browser counts as online even between long-poll requests");
  const busyResult = browserPresenceBus.execute({
    feature: "threadMessaging",
    kind: "send_message",
    targetUrl: urlA,
    message: "busy browser heartbeat test",
  });
  const busyCommand = await browserPresenceBus.claim("recent-browser", ["threadMessaging"], 0);
  await browserPresenceBus.ensureBrowser("threadMessaging", async () => { browserPresenceLaunches += 1; });
  assert.equal(browserPresenceLaunches, 0,
    "a browser that currently owns a support command counts as online while automation is running");
  browserPresenceBus.complete({
    commandId: busyCommand.id,
    browserId: "recent-browser",
    kind: "send_message",
    ok: true,
    result: { status: "sent", conversationUrl: urlA },
  });
  await busyResult;
  browserPresenceBus.close();

  const sleepingWorkerBus = new SupportCommandBus();
  let sleepingWorkerLaunches = 0;
  const realDateNow = Date.now;
  let presenceNow = realDateNow();
  Date.now = () => presenceNow;
  try {
    assert.equal(await sleepingWorkerBus.claim("sleeping-chrome", ["threadPreparation"], 0), undefined);
    presenceNow += 70_000;
    await sleepingWorkerBus.ensureBrowser("threadPreparation", async () => { sleepingWorkerLaunches += 1; });
    assert.equal(sleepingWorkerLaunches, 0,
      "one MV3 sleep/alarm interval does not cause the backend to launch another Chrome window");
  } finally {
    Date.now = realDateNow;
    sleepingWorkerBus.close();
  }

  const missingExecutorBus = new SupportCommandBus(undefined, undefined, undefined, undefined, undefined, undefined, 25);
  let missingExecutorLaunches = 0;
  const launchWithoutExecutor = async () => { missingExecutorLaunches += 1; };
  await assert.rejects(
    missingExecutorBus.ensureBrowser("threadPreparation", launchWithoutExecutor),
    /did not connect as a threadPreparation executor/,
    "spawning chrome.exe is not treated as proof that the support executor connected");
  await assert.rejects(
    missingExecutorBus.ensureBrowser("threadPreparation", launchWithoutExecutor),
    /did not connect as a threadPreparation executor/,
    "a missing executor fails explicitly during the launch cooldown instead of opening Chrome again");
  assert.equal(missingExecutorLaunches, 1, "a missing executor does not create a Chrome launch loop");
  missingExecutorBus.close();

  const launchDedupBus = new SupportCommandBus();
  let deduplicatedLaunches = 0;
  let releaseLaunch;
  const launchGate = new Promise(resolve => { releaseLaunch = resolve; });
  const launchBrowserOnce = async () => {
    deduplicatedLaunches += 1;
    await launchGate;
    await launchDedupBus.claim("dedup-browser", ["threadMessaging", "threadPreparation"], 0);
  };
  const launchRequests = [
    launchDedupBus.ensureBrowser("threadMessaging", launchBrowserOnce),
    launchDedupBus.ensureBrowser("threadPreparation", launchBrowserOnce),
  ];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deduplicatedLaunches, 1, "concurrent backend Chrome launch requests are deduplicated");
  releaseLaunch();
  await Promise.all(launchRequests);
  launchDedupBus.close();

  const projectMessage = await client.callTool({
    name: "send_thread_message",
    arguments: {
      targetUrl: namedProjectHome,
      message: "must target an existing thread",
    },
  });
  assert.equal(projectMessage.isError, true, "send_thread_message cannot create a thread");


  const launchesBeforeReadyExecutor = automationLaunches;
  const waitingMessageCommand = supportCommands.claim("chrome-browser", ["threadMessaging"], 1000);
  await new Promise(resolve => setImmediate(resolve));
  const messageCall = client.callTool({
    name: "send_thread_message",
    arguments: { targetUrl: urlB, message: "Explicit thread message." },
  });
  const messageCommand = await waitingMessageCommand;
  assert.equal(automationLaunches, launchesBeforeReadyExecutor,
    "an already-waiting messaging executor prevents an unnecessary Chrome launch");
  assert.equal(messageCommand.targetUrl, urlB);
  assert.equal(messageCommand.message, "Explicit thread message.");
  supportCommands.complete({
    commandId: messageCommand.id,
    browserId: "chrome-browser",
    kind: "send_message",
    ok: true,
    result: { status: "sent", conversationUrl: urlB },
  });
  const messageResult = await messageCall;
  assert.notEqual(messageResult.isError, true);
  assert.equal(messageResult.structuredContent.conversationUrl, urlB);

  let firstReplayHandler;
  const firstReplayServer = {
    registerResource() {},
    registerTool(name, _definition, handler) {
      if (name === "send_thread_message") firstReplayHandler = handler;
    },
  };
  registerChatGptAgents(firstReplayServer, supportCommands, registry, subagentJobs, threadPreparer, launchSupportBrowser, "mcp-grant");
  assert.equal(typeof firstReplayHandler, "function");
  const retryArguments = { targetUrl: urlB, message: "Transport retry probe." };
  const retryExtra = { mcpReq: { id: "same-mcp-request", _meta: { "openai/session": "mcp-A" } } };
  const firstRetryCall = firstReplayHandler(retryArguments, retryExtra);
  const retryDeliveryCommand = await supportCommands.claim("chrome-browser", ["threadMessaging"], 1000);
  assert.equal(retryDeliveryCommand.message, retryArguments.message);
  supportCommands.complete({
    commandId: retryDeliveryCommand.id,
    browserId: "chrome-browser",
    kind: "send_message",
    ok: true,
    result: { status: "sent", conversationUrl: urlB },
  });
  const firstRetryResult = await firstRetryCall;
  assert.equal(firstRetryResult.structuredContent.conversationUrl, urlB);

  let secondReplayHandler;
  const secondReplayServer = {
    registerResource() {},
    registerTool(name, _definition, handler) {
      if (name === "send_thread_message") secondReplayHandler = handler;
    },
  };
  registerChatGptAgents(secondReplayServer, supportCommands, registry, subagentJobs, threadPreparer, launchSupportBrowser, "mcp-grant");
  const replayedRetryResult = await secondReplayHandler(retryArguments, retryExtra);
  assert.equal(replayedRetryResult.structuredContent.conversationUrl, urlB);
  assert.equal(await supportCommands.claim("chrome-browser", ["threadMessaging"], 0), undefined,
    "the same MCP request id and payload is deduplicated across stateless server instances");
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

  // The authenticated extension protocol owns the pause, so it must withhold every command kind.
  const pauseRegistry = await RalphRegistry.open(path.join(temporaryRoot, "global-pause"));
  await pauseRegistry.register(urlA, { manual: true, activity: "running", title: "Preserved work" });
  const pauseBus = new SupportCommandBus(0, undefined, undefined, undefined, pauseRegistry);
  const pauseHandler = supportCommandClaimHandler(pauseBus, sync.extensionToken);
  const realNow = Date.now;
  let pauseNow = realNow();
  Date.now = () => pauseNow;
  try {
    const inputs = [
      { feature: "ralph", kind: "inspect_thread", conversationUrl: urlA },
      { feature: "threadPreparation", kind: "prepare_thread", conversationUrl: urlA },
      { feature: "threadLifecycle", kind: "close_thread", conversationUrl: urlA },
      { feature: "threadMessaging", kind: "stop_thread", targetUrl: urlA },
      { feature: "threadMessaging", kind: "send_message", targetUrl: urlA, message: "Queued assignment" },
    ];
    const features = ["ralph", "threadPreparation", "threadLifecycle", "threadMessaging"];
    const promises = inputs.map(input => pauseBus.execute(input, 40));
    for (const promise of promises) promise.catch(() => undefined);
    await new Promise(resolve => setImmediate(resolve));
    const beforePause = await pauseBus.claim("pause-browser", features, 0);
    const preparedBeforePause = await pauseBus.claim("pause-browser", ["threadPreparation"], 0);
    const closedBeforePause = await pauseBus.claim("pause-browser", ["threadLifecycle"], 0);
    const request = makeClaimRequest("notice-browser");
    request.req.body = { browserId: "notice-browser", features: [], statusOnly: true, conversationUnavailable: true };
    const headers = {};
    request.res.setHeader = (name, value) => { headers[name] = value; };
    await pauseHandler(request.req, request.res);
    assert.equal(request.res.statusCode, 204, "the empty-conversation event pauses without claiming or losing a command");
    const until = Number(headers["X-Automation-Paused-Until"]);
    assert.equal(until, pauseNow + 300_000, "the global pause lasts exactly five minutes");
    assert.equal(await pauseBus.claim("pause-browser", features, 0), undefined, "even a resumable inspection cannot bypass the pause");
    assert.equal(await pauseBus.claim("another-browser", features, 0), undefined, "the pause applies to every browser");
    pauseNow += 30_000;
    await pauseHandler(request.req, request.res);
    assert.equal(Number(headers["X-Automation-Paused-Until"]), until, "repeated notices do not extend an active pause");
    const restarted = await RalphRegistry.open(path.join(temporaryRoot, "global-pause"));
    assert.equal(restarted.automationPausedUntil(), until, "a server restart retains the deadline");
    assert.deepEqual(await restarted.threads(), await pauseRegistry.threads(), "the pause does not alter thread state");
    await new Promise(resolve => setTimeout(resolve, 60));
    pauseNow = until;
    for (let index = 0; index < inputs.length; index++) {
      const browserId = index === 2 ? "replacement-browser" : "pause-browser";
      const command = await pauseBus.claim(browserId, features, 0);
      assert.equal(command.kind, inputs[index].kind, "queued and claimed work resumes in order after the deadline");
      if (index === 0) assert.equal(command.id, beforePause.id, "the claimed command retains its identity");
      if (index === 1) assert.equal(command.id, preparedBeforePause.id);
      if (index === 2) assert.equal(command.id, closedBeforePause.id, "a replacement extension reclaims an interrupted close with its original identity");
      const result = command.kind === "inspect_thread" ? { status: "running" }
        : command.kind === "prepare_thread" ? { status: "prepared", conversationUrl: urlA }
        : command.kind === "close_thread" ? { status: "closed", conversationUrl: urlA }
        : command.kind === "stop_thread" ? { status: "idle", conversationUrl: urlA }
        : { status: "sent", conversationUrl: urlA };
      pauseBus.complete({ commandId: command.id, browserId, kind: command.kind, ok: true, result });
      assert.equal((await promises[index]).ok, true, "the pause preserves pending requests beyond their original timeout");
    }
    request.req.body.automationPausedUntil = pauseNow + 180_000;
    await pauseHandler(request.req, request.res);
    assert.equal(Number(headers["X-Automation-Paused-Until"]), pauseNow + 180_000, "an offline extension reconciles its remaining cooldown without restarting the clock");
    pauseNow += 180_001;
    await pauseHandler(request.req, request.res);
    assert.equal(Number(headers["X-Automation-Paused-Until"]), 0, "replaying an expired offline notice cannot start another pause");
    const freshNotice = makeClaimRequest("fresh-notice-browser");
    freshNotice.req.body = { browserId: "fresh-notice-browser", features: [], statusOnly: true,
      conversationUnavailable: true, automationPausedUntil: pauseNow + 300_000 };
    await Promise.all([pauseHandler(request.req, request.res), pauseHandler(freshNotice.req, freshNotice.res)]);
    assert.equal(pauseBus.automationPausedUntil(), pauseNow + 300_000, "a concurrent expired notice cannot suppress a fresh failure");
  } finally {
    Date.now = realNow;
    pauseBus.close();
  }

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

  const reassignedCommandBus = new SupportCommandBus(0);
  const reassignedResult = reassignedCommandBus.execute({
    feature: "ralph",
    kind: "inspect_thread",
    conversationUrl: urlA,
  }, 25);
  const reassignedOutcome = reassignedResult.then(
    result => ({ result }),
    error => ({ error }),
  );
  const abandonedCommand = await reassignedCommandBus.claim("browser-before-restart", ["ralph"], 0);
  const replacementCommand = await reassignedCommandBus.claim("browser-after-restart", ["ralph"], 0);
  let reassignedError;
  if (!replacementCommand) {
    await new Promise(resolve => setTimeout(resolve, 50));
    reassignedError = (await reassignedOutcome).error;
  }
  assert.equal(replacementCommand?.id, abandonedCommand.id,
    `an abandoned RALPH inspection must be reassigned after its claim lease expires: ${reassignedError?.message ?? "no timeout captured"}`);
  reassignedCommandBus.complete({
    commandId: replacementCommand.id,
    browserId: "browser-after-restart",
    kind: "inspect_thread",
    ok: true,
    result: { status: "running" },
  });
  assert.equal((await reassignedResult).result.status, "running");
  reassignedCommandBus.close();

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
    const transcript = JSON.stringify(apiRequest.input);
    const responseText = [
      "Finish this small task.",
      "The current step is done.",
      "Do the task.",
    ].some((text) => transcript.includes(text))
      ? "COMPLETE"
      : "CONTINUE";
    return new Response(JSON.stringify({
      output: [
        { type: "reasoning", encrypted_content: "opaque-test-reasoning" },
        { type: "message", content: [{ type: "output_text", text: responseText }] },
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
    const loadingRalphUrl = `https://chatgpt.com/g/${projectId}/c/10101010-1010-4010-8010-101010101010`;
    await ralphControllerRegistry.register(loadingRalphUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralphController.tick();
    const loadingInspect = await ralphCommands.claim("chrome-browser", ["ralph"], 1000);
    const loadingCheckedAt = Date.now();
    ralphCommands.complete({
      commandId: loadingInspect.id,
      browserId: "chrome-browser",
      kind: "inspect_thread",
      ok: true,
      result: { status: "loading", title: "Hydrating task - ChatGPT" },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const loadingThread = (await ralphControllerRegistry.threads())
      .find(thread => thread.conversationUrl === loadingRalphUrl);
    assert.equal(apiRequestCount, 0, "a loading RALPH thread must never call the completion classifier");
    assert.ok(loadingThread.nextCheckAt >= loadingCheckedAt + 15 && loadingThread.nextCheckAt <= loadingCheckedAt + 120,
      "a loading RALPH thread is rechecked on the short configured interval");
    await ralphControllerRegistry.recordComplete(parseConversationUrl(loadingRalphUrl).threadId);

    const runningRalphUrl = `https://chatgpt.com/g/${projectId}/c/20202020-2020-4020-8020-202020202020`;
    await ralphControllerRegistry.register(runningRalphUrl);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralphController.tick();
    const runningInspect = await ralphCommands.claim("chrome-browser", ["ralph"], 1000);
    const runningCheckedAt = Date.now();
    ralphCommands.complete({
      commandId: runningInspect.id,
      browserId: "chrome-browser",
      kind: "inspect_thread",
      ok: true,
      result: { status: "running", title: "Still working - ChatGPT" },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const runningRalphThread = (await ralphControllerRegistry.threads())
      .find(thread => thread.conversationUrl === runningRalphUrl);
    assert.equal(apiRequestCount, 0, "a running RALPH thread must never call the completion classifier");
    assert.ok(runningRalphThread.nextCheckAt >= runningCheckedAt + 15 && runningRalphThread.nextCheckAt <= runningCheckedAt + 120,
      "a running RALPH thread is rechecked on the short configured interval");
    await ralphControllerRegistry.recordComplete(parseConversationUrl(runningRalphUrl).threadId);

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
        workedSeconds: 30 * 60 + 1,
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
    assert.equal(continueCommand.message, "Continue");
    assert.equal(apiRequest.model, "gpt-5.6-terra");
    assert.deepEqual(apiRequest.reasoning, { effort: "low" });
    assert.equal("max_output_tokens" in apiRequest, false,
      "RALPH must not impose an output-token budget on classification");
    const classifierInstruction = apiRequest.input[0].content[0].text;
    assert.doesNotMatch(classifierInstruction, /tool access expires after 25 minutes/);
    assert.match(classifierInstruction, /working agent is more capable than you/);
    assert.match(classifierInstruction, /reply with exactly CONTINUE/);
    assert.match(classifierInstruction, /Do not explain, add steps, or repeat completed work/);
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
      line.includes("CONTINUE")),
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
    assert.equal(persistedSuccessLogs[1].response_text, "CONTINUE");
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
    assert.equal(apiRequestCount, 1, "a short final response skips the completion classifier");
    assert.equal(await ralphCommands.claim("chrome-browser", ["ralph"], 0), undefined);
    assert.equal(await ralphControllerRegistry.isActive(parseConversationUrl(shortRalphUrl).threadId), false,
      "a short settled turn does not enter the continuation loop");

    const staleObserverRalphUrl = `https://chatgpt.com/g/${projectId}/c/30303030-3030-4030-8030-303030303030`;
    await ralphControllerRegistry.register(staleObserverRalphUrl);
    const apiRequestsBeforeStaleObserver = apiRequestCount;
    await ralphCommands.claim("helium-stale", [], 0, undefined, [staleObserverRalphUrl]);
    await ralphCommands.claim("chrome-live", ["ralph"], 0, undefined, [staleObserverRalphUrl]);
    await new Promise(resolve => setTimeout(resolve, 25));
    await ralphController.tick();
    const staleObserverInspect = await ralphCommands.claim("helium-stale", [], 1000, undefined, [staleObserverRalphUrl]);
    assert.equal(staleObserverInspect.kind, "inspect_thread");
    ralphCommands.complete({
      commandId: staleObserverInspect.id,
      browserId: "helium-stale",
      kind: "inspect_thread",
      ok: true,
      result: {
        status: "idle",
        title: "Stale Helium copy - ChatGPT",
        workedSeconds: 30 * 60 + 1,
        users: [{ id: "u-stale", text: "Finish the task without duplicate wake-ups." }],
        assistant: { synthetic: false, id: "a-stale", text: "Stale Helium says work remains." },
      },
    });
    const preSendSafetyInspect = await ralphCommands.claim("chrome-live", ["ralph"], 1000, undefined, [staleObserverRalphUrl]);
    assert.equal(preSendSafetyInspect.kind, "inspect_thread",
      "before any RALPH send, Chrome must be freshly inspected even when Helium reported the thread idle");
    assert.equal(preSendSafetyInspect.executorOnly, true,
      "the pre-send safety inspection must bypass observer precedence and run in the automation executor");
    ralphCommands.complete({
      commandId: preSendSafetyInspect.id,
      browserId: "chrome-live",
      kind: "inspect_thread",
      ok: true,
      result: { status: "running", title: "Live Chrome copy - ChatGPT" },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(apiRequestCount, apiRequestsBeforeStaleObserver,
      "RALPH must not call the classifier when the fresh Chrome inspection says the thread is running");
    assert.equal(await ralphCommands.claim("chrome-live", ["ralph"], 0, undefined, [staleObserverRalphUrl]), undefined,
      "RALPH must not send when the fresh Chrome inspection says the thread is running");
    await ralphControllerRegistry.recordComplete(parseConversationUrl(staleObserverRalphUrl).threadId);

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
    assert.equal(apiRequestCount, 1, "a final response without duration cannot meet the inspector threshold");
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
        workedSeconds: 30 * 60 + 1,
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
    assert.equal(persistedLogs.at(-2).event, "request_started");
    assert.equal(persistedLogs.at(-1).event, "request_failed");
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
        workedSeconds: 30 * 60 + 1,
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
        workedSeconds: 30 * 60 + 1,
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

  const cleanupRoot = path.join(temporaryRoot, "thread-tab-cleanup");
  const cleanupRegistry = await RalphRegistry.open(cleanupRoot, 20);
  await cleanupRegistry.setProjects([projectId]);
  const cleanupUrl = `https://chatgpt.com/g/${projectId}/c/77777777-7777-4777-8777-777777777777`;
  const cleanupThreadId = parseConversationUrl(cleanupUrl).threadId;
  await cleanupRegistry.register(cleanupUrl, { parentThreadId: "api:cleanup" });
  const cleanupCommands = new SupportCommandBus();
  const cleanupController = new ThreadTabCleanupController({
    commands: cleanupCommands,
    registry: cleanupRegistry,
    checkEveryMs: 60_000,
  });
  try {
    await cleanupController.tick(Date.now() + 60_000);
    assert.equal(await cleanupCommands.claim("cleanup-browser", ["threadLifecycle"], 0), undefined,
      "an active thread is never scheduled for tab cleanup regardless of age");

    await cleanupRegistry.recordComplete(cleanupThreadId);
    const completedThread = (await cleanupRegistry.threads()).find(thread => thread.threadId === cleanupThreadId);
    const completedAt = Date.parse(completedThread.lastCheckedAt);
    await cleanupController.tick(completedAt);
    await new Promise(resolve => setImmediate(resolve));
    const closeCommand = await cleanupCommands.claim("cleanup-browser", ["threadLifecycle"], 1_000);
    assert.equal(closeCommand.kind, "close_thread");
    assert.equal(closeCommand.conversationUrl, cleanupUrl);
    assert.equal(cleanupCommands.hasBrowser("threadLifecycle"), true,
      "cleanup uses the already-connected automation browser instead of launching another Chrome window");
    cleanupCommands.complete({
      commandId: closeCommand.id,
      browserId: "cleanup-browser",
      kind: "close_thread",
      ok: true,
      result: { status: "closed", conversationUrl: cleanupUrl },
    });
    await new Promise(resolve => setImmediate(resolve));
    await cleanupController.tick(completedAt + 60_000);
    assert.equal(await cleanupCommands.claim("cleanup-browser", ["threadLifecycle"], 0), undefined,
      "a completed thread is cleaned once rather than producing repeated close commands");
  } finally {
    cleanupController.close();
    cleanupCommands.close();
  }

  const resource = await client.readResource({ uri: THREAD_SYNC_WIDGET_URI });
  assert.match(resource.contents[0].mimeType, /profile=mcp-app/);
  assert.equal(resource.contents[0]._meta.ui.prefersBorder, true);
  assert.doesNotMatch(resource.contents[0].text, /display:\s*none/);
  assert.match(resource.contents[0].text, /Thread Sync/);
  assert.ok(!resource.contents[0].text.includes(sync.extensionToken));

  await testContentScript(a.ticket.token, b.ticket.token);
  await testWorkerKeepsLongAutomationAlive(sync);
  await testWorkerNeverRedispatchesAfterLostResponse(sync);
  await testWorkerRecoversHungAutomation(sync);
  await testSendWaitsForLoadedConversationAndClicksOnce();
  await testSendWaitsForLoadedConversationAndClicksOnce(false);
  await testNewProjectComposerWithoutDataType();
  await testNewProjectComposerWithoutDataType(true);
  await testNewProjectComposerWithoutDataType(true, "Codex");
  await testNewProjectComposerWithoutDataType(true, "Codex", false);
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

  console.log("Thread sync passed: one-time binding, backend thread preparation, local sub-agent results, browser launch gating, long automation keepalive, single-shot sends, RALPH behavior, persistence, auth, and MCP App routing.");
  console.log("All tests were isolated. No network listener or browser was started.");
} finally {
  supportCommands?.close();
  await subagentJobs?.close();
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

async function testSendWaitsForLoadedConversationAndClicksOnce(acceptSend = true) {
  let automationListener;
  let now = 0;
  const userReadyAt = 65_000;
  const assistantReadyAt = 80_000;
  let userCount = 1;
  let generationStarted = false;
  let insertedAt;
  let insertionCalls = 0;
  const clickTimes = [];
  const editorEvents = [];
  const stopButton = {};
  const location = new URL(urlA);
  const editor = {
    textContent: "",
    focus() {},
    dispatchEvent(event) {
      editorEvents.push(event.type);
      if (event.type === "input") insertedAt = now;
    },
    getAttribute(key) { return key === "contenteditable" ? "true" : null; },
  };
  const sendButton = {
    disabled: false,
    getAttribute() { return null; },
    click() {
      clickTimes.push(now);
      if (acceptSend) {
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
      if (selector === '#composer-submit-button' ||
          selector === 'button[data-testid="send-button"]' ||
          selector === 'button[aria-label="Send prompt"]') return sendButton;
      if (selector === 'button[data-testid="stop-button"]') return null;
      return null;
    },
  };
  const document = {
    readyState: "complete",
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"] [data-message-author-role="user"]') {
        return now >= userReadyAt ? {} : null;
      }
      if (selector === 'section[data-turn="assistant"] [data-message-author-role="assistant"]') {
        return now >= assistantReadyAt ? {} : null;
      }
      if (selector === '#composer-submit-button' || selector === 'button[aria-label="Send prompt"]') return sendButton;
      if (selector === 'form[data-type="unified-composer"] button[data-testid="stop-button"]' ||
          selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'section[data-turn="user"]') return Array.from({ length: userCount }, (_, index) => ({ dataset: { turnId: "u" + index }, textContent: index === 0 ? "original request" : "hello", querySelector() { return null; } }));
      if (selector === "section[data-turn]") {
        const turns = [];
        if (now >= userReadyAt) turns.push({
          dataset: { turn: "user", turnId: "u1" },
          textContent: "Request",
          querySelector: query => query === '[data-message-author-role="user"]' ? {} : null,
        });
        if (now >= assistantReadyAt) turns.push({
          dataset: { turn: "assistant", turnId: "a1" },
          textContent: "Ready",
          querySelector: query => query === '[data-message-author-role="assistant"]' ? {} : null,
          querySelectorAll: () => [],
        });
        return turns;
      }
      return [];
    },
    createRange() { return { selectNodeContents() {} }; },
    execCommand(command, _showUi, value) {
      assert.equal(command, "insertText");
      insertionCalls += 1;
      insertedAt = now;
      editor.textContent = value;
      return true;
    },
  };
  const browser = {
    runtime: {
      sendMessage: async () => ({ status: "bound" }),
      onMessage: { addListener: fn => { automationListener = fn; } },
    },
    storage: {
      local: {
        get: async defaults => typeof defaults === "string" ? {} : ({ ...defaults }),
        set: async () => {},
      },
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

  if (acceptSend) {
    assert.equal(response.ok, true, response.error);
    assert.equal(response.result.status, "sent");
    assert.equal(response.result.conversationUrl, urlA);
  } else {
    assert.equal(response.ok, false);
    assert.match(response.error, /Delivery uncertain after Send/);
    assert.notEqual(response.retryable, true, "an uncertain send must never be replayed automatically");
  }
  assert.equal(insertionCalls, 1, "the prompt is inserted exactly once");
  assert.deepEqual(editorEvents, [], "contenteditable insertion does not perform a second fallback write");
  assert.equal(clickTimes.length, 1, "RALPH must click send exactly once");
  assert.ok(insertedAt >= userReadyAt + 5_000,
    "an existing conversation waits for a loaded user turn and then the fixed page settle");
  assert.ok(insertedAt < assistantReadyAt,
    "thread messaging does not wait for an assistant turn before typing");
  assert.ok(clickTimes[0] >= insertedAt + 5_000,
    "the message is typed once, left to settle for five seconds, then sent once");
}

async function testNewProjectComposerWithoutDataType(modernComposer = false, connectorName, connectorAvailable = true) {
  let automationListener;
  let now = 0;
  let generationStarted = false;
  let userCount = 0;
  let insertedAt;
  let insertionCalls = 0;
  let clickedAt;
  let clickCount = 0;
  let menuOpened = false;
  let connectorAttached = false;
  let submittedText = "start the new project thread";
  const location = new URL(namedProjectHome);
  const stopButton = {};
  const editor = {
    textContent: "",
    focus() {},
    closest(selector) { return selector === (modernComposer ? "[data-composer-body]" : "form") ? composer : null; },
    dispatchEvent(event) {
      if (event.type === "input") {
        insertedAt = now;
        editor.textContent = editor.textContent.replace(/\n\n/g, "  ");
      }
    },
    getAttribute(key) { return key === "contenteditable" ? "true" : null; },
    querySelectorAll() { return connectorAttached ? [{ getAttribute: () => "Codex" }] : []; },
  };
  const sendButton = {
    disabled: false,
    getAttribute(key) { return key === "aria-disabled" ? "false" : null; },
    click() {
      assert.equal(connectorAttached, Boolean(connectorName), "the connector must be attached before Send");
      clickCount += 1;
      clickedAt = now;
      submittedText = editor.textContent;
      editor.textContent = "";
      userCount = 1;
      generationStarted = true;
      location.href = urlA;
    },
  };
  const staleSendButton = {
    disabled: false,
    getAttribute(key) { return key === "aria-disabled" ? "false" : null; },
    click() {},
  };
  const composer = {
    getAttribute() { return null; },
    querySelector(selector) {
      if (selector === 'button[aria-label="Add files and more"]') return {
        disabled: false, getAttribute() { return null; }, click() { menuOpened = true; },
      };
      if (modernComposer) return selector === 'button[aria-label="Send"]' ? sendButton : null;
      if (selector === '#composer-submit-button' ||
          selector === 'button[data-testid="send-button"]' ||
          selector === 'button[aria-label="Send prompt"]') return sendButton;
      if (selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
  };
  const connectorButton = {
    disabled: false, getAttribute() { return null; }, getClientRects() { return [{}]; },
    querySelectorAll() { return [{ textContent: "Codex" }, { textContent: "Helps you control my computer" }]; },
    click() { connectorAttached = true; editor.textContent += " Codex"; },
  };
  const document = {
    readyState: "complete",
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return null;
      if (modernComposer && selector === '[data-composer-markdown][contenteditable="true"]') return editor;
      if (modernComposer) return null;
      if (selector === '#prompt-textarea[contenteditable="true"]' ||
          selector === 'textarea[name="prompt-textarea"]') return editor;
      if (selector === '#composer-submit-button') return staleSendButton;
      if (selector === 'button[data-testid="send-button"]' || selector === 'button[aria-label="Send prompt"]') return sendButton;
      if (selector === 'form[data-type="unified-composer"] button[data-testid="stop-button"]' ||
          selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'section[data-turn="user"]') return Array.from({ length: userCount }, (_, index) => ({ dataset: { turnId: "u" + index }, textContent: submittedText, querySelector() { return null; } }));
      if (selector === 'button[data-list-navigation-item="true"]') return menuOpened && connectorAvailable ? [connectorButton] : [];
      return [];
    },
    createRange() { return { selectNodeContents() {} }; },
    execCommand(_command, _showUi, value) {
      insertionCalls += 1;
      insertedAt = now;
      editor.textContent = value;
      return true;
    },
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
      command: { kind: "send_message", message: "start the new project thread", ...(connectorName ? { connectorName } : {}) },
    }, {}, resolve);
  });
  if (connectorName && !connectorAvailable) {
    assert.equal(response.ok, false);
    assert.match(response.error, /connector "Codex" was not found/);
    assert.equal(clickCount, 0, "a missing connector cannot send a worker without tools");
    return;
  }
  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.conversationUrl, urlA);
  assert.equal(insertionCalls, 1, "a new sub-agent prompt is inserted exactly once");
  assert.equal(clickCount, 1, "a new sub-agent prompt is sent exactly once");
  assert.ok(insertedAt >= 5_000,
    "a new project page gets a fixed five-second settle before typing");
  assert.ok(clickedAt >= insertedAt + 5_000,
    "a new project prompt settles for five seconds before the one send click");
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
  const message = "send the completed task to the parent";
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
      if (selector === '#composer-submit-button' ||
          selector === 'button[data-testid="send-button"]' ||
          selector === 'button[aria-label="Send prompt"]') return sendButton;
      if (selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
  };
  const userTurn = {
    dataset: { turn: "user", turnId: "u1" },
    textContent: "original request",
    querySelector: selector => selector === '[data-message-author-role="user"]' ? {} : null,
  };
  const assistantTurn = {
    dataset: { turn: "assistant", turnId: "a1" },
    textContent: "finished response",
    querySelector: selector => selector === '[data-message-author-role="assistant"]' ? {} : null,
    querySelectorAll: () => [],
  };
  const document = {
    readyState: "complete",
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"] [data-message-author-role="user"]') return userTurn;
      if (selector === 'section[data-turn="assistant"] [data-message-author-role="assistant"]') return assistantTurn;
      if (selector === '#composer-submit-button' || selector === 'button[aria-label="Send prompt"]') return sendButton;
      if (selector === 'form[data-type="unified-composer"] button[data-testid="stop-button"]' ||
          selector === 'button[data-testid="stop-button"]') return generationStarted ? stopButton : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'section[data-turn="user"]') return Array.from({ length: userCount }, (_, index) => ({ dataset: { turnId: "u" + index }, textContent: index === 0 ? "original request" : message, querySelector() { return null; } }));
      if (selector === "section[data-turn]") return [userTurn, assistantTurn];
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

async function testRunningHydrationDetection() {
  let automationListener;
  let now = 0;
  const runningStateReadyAt = 75_000;
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
      if (selector === 'button[data-testid="stop-button"]' && now >= runningStateReadyAt) return stopButton;
      return null;
    },
  };
  const document = {
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"]') return userTurn;
      if (selector === 'button[data-testid="stop-button"]' ||
          selector === 'form[data-type="unified-composer"] button[data-testid="stop-button"]') {
        return now >= runningStateReadyAt ? stopButton : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'section[data-turn="user"]') return [userTurn];
      return selector === "section[data-turn]" ? [userTurn] : [];
    },
  };
  const browser = {
    runtime: {
      sendMessage: async () => ({ status: "bound" }),
      onMessage: { addListener: fn => { automationListener = fn; } },
    },
    storage: {
      local: {
        get: async defaults => typeof defaults === "string" ? {} : ({ ...defaults }),
        set: async () => {},
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
  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.status, "loading",
    "a still-hydrating running thread must not be classified as stopped before the stop button appears");
  assert.ok(now < 30_000, "an inspection returns before the command deadline");
  now = runningStateReadyAt;
  const retry = await new Promise(resolve => automationListener({
    type: "local-codex-support/automation-v1", command: { kind: "inspect_thread" },
  }, {}, resolve));
  assert.equal(retry.result.status, "running", "the next check observes the hydrated running state");
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
    title: "Readable RALPH title - ChatGPT",
    body: { appendChild() {} },
    querySelector(selector) {
      if (selector === 'form[data-type="unified-composer"]') return composer;
      if (selector === 'section[data-turn="user"]') return userTurn;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'section[data-turn="user"]') return [userTurn];
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
        get: async defaults => typeof defaults === "string" ? {} : defaults,
        set: async () => {},
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
  assert.equal(response.result.title, "Readable RALPH title",
    "RALPH inspection captures the readable ChatGPT tab title");
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

  durationButton.textContent = "Worked for 20m";
  const shortResponse = await new Promise(resolve => {
    automationListener({
      type: "local-codex-support/automation-v1",
      command: { kind: "inspect_thread" },
    }, {}, resolve);
  });
  assert.equal(shortResponse.ok, true);
  assert.equal(shortResponse.result.workedSeconds, 20 * 60,
    "the content script reports the raw duration for the server threshold check");

  durationButton.textContent = "Worked for 20m 1s";
  const testModeResponse = await new Promise(resolve => {
    automationListener({
      type: "local-codex-support/automation-v1",
      command: { kind: "inspect_thread" },
    }, {}, resolve);
  });
  assert.equal(testModeResponse.ok, true);
  assert.equal(testModeResponse.result.workedSeconds, 20 * 60 + 1,
    "the worked duration retains seconds");
}


async function testRalphAutoRegistration(sync) {
  const generatedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), generatedConfig);
  const registrationBodies = [];
  const commandResults = [];
  const createdUrls = [];
  const removedTabs = [];
  const tabs = new Map();
  let nextTabId = 11;
  let historyListener;
  let updatedListener;
  const storage = {};
  const reloadedTabs = [];
  let inspectionStatus = "running";
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
        getPlatformInfo: async () => {},
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      tabs: {
        onUpdated: { addListener: fn => { updatedListener = fn; } },
        query: async query => query.windowType ? [{ id: 1, windowId: 1 }, ...tabs.values()] : [...tabs.values()],
        create: async ({ url }) => {
          const tab = { id: nextTabId++, status: "complete", url };
          tabs.set(tab.id, tab);
          createdUrls.push(url);
          return tab;
        },
        get: async tabId => {
          const tab = tabs.get(tabId);
          if (!tab) throw new Error("tab missing");
          return tab;
        },
        sendMessage: async (tabId, payload) => {
          const tab = tabs.get(tabId);
          if (!tab) throw new Error("tab missing");
          if (payload.command.kind === "send_message" && (payload.command.targetUrl === namedProjectHome || payload.command.targetUrl === "https://chatgpt.com/")) {
            tab.url = urlB;
            return { ok: true, result: { status: "sent", conversationUrl: urlB, title: "Persistent child" } };
          }
          if (payload.command.kind === "inspect_thread") {
            return { ok: true, result: { status: inspectionStatus, title: "Persistent child" } };
          }
          throw new Error(`Unexpected automation command: ${payload.command.kind}`);
        },
        reload: async tabId => { reloadedTabs.push(tabId); },
        remove: async tabId => { removedTabs.push(tabId); tabs.delete(tabId); },
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
      if (endpoint === generatedConfig.LOCAL_CODEX_THREAD_SYNC.commandClaimUrl) return new Response(null, { status: 204 });
      if (endpoint === generatedConfig.LOCAL_CODEX_THREAD_SYNC.commandResultUrl) {
        commandResults.push(JSON.parse(options.body));
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected support fetch: ${endpoint}`);
    },
  };

  vm.runInNewContext(await readFile("support-extension/service-worker.js", "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  configureAutomationContext(context);
  assert.equal(typeof historyListener, "function");
  assert.equal(typeof updatedListener, "function");

  historyListener({ frameId: 0, url: urlA });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(registrationBodies, [{ conversationUrl: urlA, checkForCompletion: false }],
    "a ChatGPT SPA navigation into a project conversation registers it without thread sync");

  historyListener({ frameId: 0, url: urlA });
  updatedListener(1, { url: urlA });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registrationBodies.length, 1, "duplicate route observations are deduplicated in the extension");

  historyListener({ frameId: 0, url: "https://chatgpt.com/c/55555555-5555-4555-8555-555555555555" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registrationBodies.length, 2, "ordinary route observations carry the disabled setting without enrolling checks");
  assert.equal(registrationBodies.at(-1).checkForCompletion, false);

  const registrationsBeforeAgentSend = registrationBodies.length;
  await context.executeCommand({
    id: "agent-project-thread",
    feature: "threadMessaging",
    kind: "send_message",
    targetUrl: namedProjectHome,
    message: "spawn the project sub-agent",
  }, "browser-a");
  assert.deepEqual(createdUrls, [namedProjectHome],
    "sub-agent creation opens one new tab in the existing automation browser");
  assert.equal(registrationBodies.length, registrationsBeforeAgentSend,
    "new sub-agent sends leave RALPH registration to the server");
  assert.equal(commandResults.at(-1).ok, true);
  assert.equal(JSON.stringify(storage.automationThreadTabsV1), JSON.stringify({ [urlB]: 11 }),
    "the new child tab becomes the durable automation-owned tab for that conversation");
  assert.deepEqual(removedTabs, [], "a running child tab stays open after creation");

  await context.executeCommand({
    id: "prepare-child-thread",
    feature: "threadPreparation",
    kind: "prepare_thread",
    conversationUrl: urlB,
  }, "browser-a");
  assert.equal(createdUrls.length, 1,
    "thread preparation reuses the child creation tab instead of opening another ChatGPT page");
  assert.equal(commandResults.at(-1).result.status, "prepared");
  assert.deepEqual(removedTabs, [], "thread sync does not close the persistent child tab");

  await context.executeCommand({
    id: "inspect-child-thread",
    feature: "ralph",
    kind: "inspect_thread",
    conversationUrl: urlB,
  }, "browser-a");
  assert.equal(createdUrls.length, 1,
    "RALPH inspection reuses the same persistent tab instead of reloading the thread");
  assert.equal(commandResults.at(-1).result.status, "running");
  assert.deepEqual(removedTabs, [], "a running RALPH thread remains open");

  assert.equal(context.enabledAutomationFeatures({ threadSync: true, automationExecutor: false, ralph: true, threadMessaging: true }).length, 0,
    "Helium cannot claim any automation command even with old per-feature toggles enabled");
  assert.ok(context.enabledAutomationFeatures({ threadSync: true, automationExecutor: true, ralph: true, threadMessaging: true }).includes("threadMessaging"));
  const concurrentResults = commandResults.length;
  const duplicateInspection = { id: "duplicate-inspection", feature: "ralph", kind: "inspect_thread", conversationUrl: urlB };
  await Promise.all([context.executeCommand(duplicateInspection, "browser-a"), context.executeCommand(duplicateInspection, "browser-a")]);
  assert.equal(commandResults.length, concurrentResults + 1, "overlapping pollers execute the same command once");
  const changedInspection = { id: "external-change", feature: "ralph", kind: "inspect_thread", conversationUrl: urlB, refreshRevision: "revision-one" };
  await context.executeCommand(changedInspection, "browser-a");
  assert.equal(commandResults.at(-1).ok, true, "a running tab defers refresh without failing the RALPH check");
  assert.equal(commandResults.at(-1).result.status, "loading");
  assert.equal(reloadedTabs.length, 0);
  inspectionStatus = "idle";
  await context.executeCommand(changedInspection, "browser-a");
  assert.equal(commandResults.at(-1).ok, true);
  assert.deepEqual(reloadedTabs, [11], "external changes refresh the existing tab once");
  await context.executeCommand({ ...changedInspection, id: "next-cycle" }, "browser-a");
  assert.deepEqual(reloadedTabs, [11], "unchanged timer cycles do not reload");
  await context.executeCommand({ ...changedInspection, id: "next-change", refreshRevision: "revision-two" }, "browser-a");
  assert.deepEqual(reloadedTabs, [11, 11]);
  assert.equal(createdUrls.length, 1, "refresh never creates a duplicate tab");

  tabs.set(90, { id: 90, status: "complete", url: urlA });
  await context.executeCommand({
    id: "inspect-user-thread",
    feature: "ralph",
    kind: "inspect_thread",
    conversationUrl: urlA,
  }, "browser-a");
  assert.equal(createdUrls.length, 1, "an already-open user thread is reused rather than duplicated");
  await context.executeCommand({
    id: "close-user-thread",
    feature: "threadLifecycle",
    kind: "close_thread",
    conversationUrl: urlA,
  }, "browser-a");
  assert.equal(commandResults.at(-1).result.status, "not_owned");
  assert.equal(tabs.has(90), true, "cleanup never closes a user-owned ChatGPT tab");

  await context.executeCommand({
    id: "close-child-thread",
    feature: "threadLifecycle",
    kind: "close_thread",
    conversationUrl: urlB,
  }, "browser-a");
  assert.equal(commandResults.at(-1).result.status, "closed");
  assert.deepEqual(removedTabs, [11], "completed automation-owned threads can be closed explicitly");
  assert.equal(JSON.stringify(storage.automationThreadTabsV1), JSON.stringify({}), "closed automation tabs are removed from persistent ownership state");
  await context.executeCommand({ id: "homepage-child", feature: "threadMessaging", kind: "send_message", targetUrl: "https://chatgpt.com/", message: "Child without a project" }, "browser-a");
  assert.equal(commandResults.at(-1).ok, true);
  const homepageTabCount = createdUrls.length;
  await context.executeCommand({ id: "prepare-homepage-child", feature: "threadPreparation", kind: "prepare_thread", conversationUrl: urlB }, "browser-a");
  assert.equal(createdUrls.length, homepageTabCount, "children created outside projects retain their creation tab too");
  assert.equal(tabs.has(storage.automationThreadTabsV1[urlB]), true);

}

async function testRalphWorkerReactivation(sync) {
  const generatedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), generatedConfig);
  const extensionId = "a".repeat(32);
  const storage = { ralph: false };
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
        query: async query => query.windowType ? [{ id: 1, windowId: 1 }] : [],
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
  assert.deepEqual(JSON.parse(registrationRequests()[0].options.body), { conversationUrl: urlA, checkForCompletion: false });

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
    externalUpdate: true,
    checkForCompletion: false,
  });
  updatedListener(7, { title: "RALPH - New chat" }, { url: urlA, title: "RALPH - New chat" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registrationRequests().length, 2,
    "placeholder browser titles are not written back to server-side RALPH state");

  const titleObservation = await new Promise(resolve => {
    runtimeListener({
      type: "local-codex-support/title-observed-v1",
      conversationUrl: urlA,
      title: "RALPH - Persisted late title - ChatGPT",
    }, {
      id: extensionId,
      frameId: 0,
      tab: { id: 7 },
      url: urlA,
    }, resolve);
  });
  assert.equal(titleObservation.ok, true);
  assert.deepEqual(JSON.parse(registrationRequests().at(-1).options.body), {
    conversationUrl: urlA,
    title: "RALPH - Persisted late title",
    checkForCompletion: false,
  }, "a late page title observation is normalized and sent to the server");
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
        query: async query => query.windowType ? [{ id: 1, windowId: 1 }] : [],
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
  configureAutomationContext(context);

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

async function testWorkerNeverRedispatchesAfterLostResponse(sync) {
  const generatedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), generatedConfig);
  let automationDispatches = 0;
  let reloads = 0;
  let injected = 0;
  const postedResults = [];
  const storage = {};
  const context = {
    URL,
    AbortSignal,
    AbortController,
    crypto: globalThis.crypto,
    console,
    Response,
    importScripts() {},
    setTimeout,
    clearTimeout,
    LOCAL_CODEX_THREAD_SYNC: generatedConfig.LOCAL_CODEX_THREAD_SYNC,
    browser: {
      runtime: {
        id: "a".repeat(32),
        getPlatformInfo: async () => {},
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      tabs: {
        onUpdated: { addListener() {} },
        query: async query => query.windowType ? [{ id: 1, windowId: 1 }] : [],
        create: async () => ({ id: 11 }),
        get: async () => ({ id: 11, status: "complete", url: urlA }),
        reload: async () => { reloads += 1; },
        sendMessage: async (_tabId, payload) => {
          assert.equal(payload.type, "local-codex-support/automation-v1");
          automationDispatches += 1;
          // Simulate the dangerous boundary: the page already received and acted on the
          // command, but the extension response channel disappears before the worker sees
          // the acknowledgement. A retry here would duplicate the ChatGPT user message.
          throw new Error("The message port closed after delivery.");
        },
        remove: async () => {},
      },
      webNavigation: {
        onHistoryStateUpdated: { addListener() {} },
        onCommitted: { addListener() {} },
      },
      scripting: { executeScript: async () => { injected += 1; } },
      storage: { local: {
        async get(query) {
          if (typeof query === "string") return { [query]: storage[query] };
          return { ...query, ...storage };
        },
        async set(values) { Object.assign(storage, values); },
      } },
    },
    fetch: async (endpoint, options) => {
      if (endpoint === generatedConfig.LOCAL_CODEX_THREAD_SYNC.commandClaimUrl) return new Response(null, { status: 204 });
      assert.equal(endpoint, generatedConfig.LOCAL_CODEX_THREAD_SYNC.commandResultUrl);
      postedResults.push(JSON.parse(options.body));
      return new Response("", { status: 200 });
    },
  };
  vm.runInNewContext(await readFile("support-extension/service-worker.js", "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  configureAutomationContext(context);

  await context.executeCommand({
    id: "lost-send-response",
    feature: "threadMessaging",
    kind: "send_message",
    targetUrl: urlA,
    message: "must be dispatched once",
  }, "browser-a");

  assert.equal(injected, 2, "the health check and command content script are established before the side-effecting dispatch");
  assert.equal(automationDispatches, 1,
    "a lost tabs.sendMessage response must never cause the same side-effecting command to be dispatched again");
  assert.equal(reloads, 0, "an uncertain send must preserve the running worker and its original error");
  assert.equal(postedResults.length, 1);
  assert.equal(postedResults[0].ok, false,
    "an ambiguous post-delivery failure is surfaced instead of being hidden behind an unsafe retry");
  assert.match(postedResults[0].error, /message port closed after delivery/);
}

async function testWorkerRecoversHungAutomation(sync) {
  const generatedConfig = {};
  vm.runInNewContext(await readFile(path.join(sync.extensionDirectory, "config.js"), "utf8"), generatedConfig);
  let automationTimeoutCallback;
  let removedTab = false;
  let reloads = 0;
  let dispatches = 0;
  const postedResults = [];
  const storage = { automationThreadTabsV1: { [urlA]: 11 } };
  const context = {
    URL,
    AbortSignal,
    AbortController,
    crypto: globalThis.crypto,
    console,
    Response,
    importScripts() {},
    setTimeout(callback, ms) {
      if (ms === 30_000) {
        automationTimeoutCallback = callback;
        return 98;
      }
      if (ms === 20_000) return 99;
      return setTimeout(callback, ms);
    },
    clearTimeout(timer) {
      if (timer !== 98 && timer !== 99) clearTimeout(timer);
    },
    LOCAL_CODEX_THREAD_SYNC: generatedConfig.LOCAL_CODEX_THREAD_SYNC,
    browser: {
      runtime: {
        id: "a".repeat(32),
        getPlatformInfo: async () => {},
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      tabs: {
        onUpdated: { addListener() {} },
        query: async query => query.windowType ? [{ id: 1, windowId: 1 }] : [],
        create: async () => ({ id: 11 }),
        get: async () => ({ id: 11, status: "complete", url: urlA }),
        reload: async () => { reloads += 1; },
        sendMessage: async () => ++dispatches === 1
          ? await new Promise(() => {})
          : { ok: true, result: { status: "running" } },
        remove: async () => { removedTab = true; },
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
      if (endpoint === generatedConfig.LOCAL_CODEX_THREAD_SYNC.commandClaimUrl) return new Response(null, { status: 204 });
      assert.equal(endpoint, generatedConfig.LOCAL_CODEX_THREAD_SYNC.commandResultUrl);
      postedResults.push(JSON.parse(options.body));
      return new Response("", { status: 200 });
    },
  };
  vm.runInNewContext(await readFile("support-extension/service-worker.js", "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  configureAutomationContext(context);

  const command = context.executeCommand({
    id: "hung-inspection",
    feature: "ralph",
    kind: "inspect_thread",
    conversationUrl: urlA,
  }, "browser-a");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof automationTimeoutCallback, "function");
  automationTimeoutCallback();
  await command;

  assert.equal(postedResults.length, 1);
  assert.equal(postedResults[0].ok, true);
  assert.equal(postedResults[0].result.status, "running");
  assert.equal(reloads, 1, "a hung inspection refreshes the same tab once");
  assert.equal(dispatches, 2);
  assert.equal(removedTab, false, "a timed-out RALPH inspection keeps the owned thread tab available for retry and inspection");
  assert.equal(JSON.stringify(storage.automationThreadTabsV1), JSON.stringify({ [urlA]: 11 }));
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
        query: async query => query.windowType ? [{ id: 1, windowId: 1 }] : [],
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
  configureAutomationContext(context);
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
            handler.onResponseStarted?.();
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

function configureAutomationContext(context) {
  // Stop the startup poller. These fixtures invoke commands directly.
  vm.runInNewContext("pollGeneration += 1; pollController?.abort();", context);
  context.restartPolling = () => {};
  context.getSettings = async () => ({ threadSync: true, automationExecutor: true, ralph: false });
  const fetch = context.fetch;
  context.fetch = async (endpoint, options) => endpoint === context.LOCAL_CODEX_THREAD_SYNC.commandClaimUrl &&
    JSON.parse(options.body).recoveryReservation?.action === "acquire"
    ? new Response(JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expiresAt: Date.now() + 540_000 }))
    : fetch(endpoint, options);
  const sendMessage = context.browser.tabs.sendMessage;
  context.browser.tabs.sendMessage = async (tabId, payload) => payload.command.kind === "page_health"
    ? { ok: true, result: { status: "ok" } }
    : sendMessage(tabId, payload);
}
