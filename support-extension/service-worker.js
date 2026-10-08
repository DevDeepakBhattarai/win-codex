const extensionApi = globalThis.browser ?? globalThis.chrome;
if (!extensionApi?.runtime || !extensionApi?.tabs || !extensionApi?.scripting || !extensionApi?.storage) {
  throw new Error("Local Codex Support requires standard WebExtension runtime, tabs, scripting, and storage APIs.");
}

function configureSidePanel() {
  void extensionApi.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}
configureSidePanel();
extensionApi.runtime.onInstalled.addListener(configureSidePanel);
extensionApi.runtime.onStartup.addListener(configureSidePanel);

importScripts("config.js");
const config = globalThis.LOCAL_CODEX_THREAD_SYNC;
const bindEndpoint = validateLoopbackEndpoint(config?.bindUrl, "/thread-sync/bind");
const claimEndpoint = validateLoopbackEndpoint(config?.commandClaimUrl, "/chatgpt-support/commands/claim");
const resultEndpoint = validateLoopbackEndpoint(config?.commandResultUrl, "/chatgpt-support/commands/result");
const threadObserveEndpoint = validateLoopbackEndpoint(config?.threadObserveUrl, "/chatgpt-support/threads/observe");
const ralphRegisterEndpoint = validateLoopbackEndpoint(config?.ralphRegisterUrl, "/chatgpt-support/ralph/register");
if (typeof config?.extensionToken !== "string" || config.extensionToken.length < 32) {
  throw new Error("Local Codex Support extension token is missing or invalid.");
}

const DEFAULT_SETTINGS = Object.freeze({
  threadSync: true,
  automationExecutor: false,
  errorRecovery: true,
  ralph: true,
  threadMessaging: false,
});
const AUTOMATION_MESSAGE = "local-codex-support/automation-v1";
const REACTIVATE_RALPH_MESSAGE = "local-codex-support/ralph-reactivate-v1";
const TITLE_OBSERVED_MESSAGE = "local-codex-support/title-observed-v1";
const SYNC_MESSAGE = "local-codex-thread-sync/bind-v1";
const WORKER_KEEPALIVE_INTERVAL_MS = 20_000;
const AUTOMATION_RESPONSE_TIMEOUT_MS = 8 * 60_000;
const SUPPORT_POLL_ALARM = "local-codex-support/poll";
const SUPPORT_POLL_PERIOD_MINUTES = 1;
const PAGE_HEALTH_CHECK_INTERVAL_MS = 3 * 60_000;
let pollGeneration = 0;
let pollController = null;
let voicePollController = null;
const reportedRalphConversations = new Set();
const observingConversations = new Map();
const observedAt = new Map();
const AUTOMATION_THREAD_TABS_KEY = "automationThreadTabsV1";
const RATE_LIMIT_WAIT_MS = 10 * 60_000;
const AUTOMATION_PAUSE_MS = 5 * 60_000;
const CONVERSATION_UNAVAILABLE_MESSAGE = "local-codex-support/conversation-unavailable-v1";
let pauseSync;
let pauseSyncedAt = 0;

async function syncAutomationPause(unavailable = false, recoveryConversationUrl) {
  if (pauseSync) {
    await pauseSync;
    if (!unavailable && !recoveryConversationUrl) return;
  }
  const operation = (async () => {
    const stored = await extensionApi.storage.local.get("automationPausedUntil");
    let until = stored.automationPausedUntil ?? 0;
    if (unavailable && !(stored.automationPausedUntil > Date.now())) {
      until = Date.now() + AUTOMATION_PAUSE_MS;
      await extensionApi.storage.local.set({ automationPausedUntil: until, automationPausePending: true });
    }
    const pending = await extensionApi.storage.local.get("automationPausePending");
    const response = await fetch(claimEndpoint.href, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
      body: JSON.stringify({ browserId: await getBrowserId(), features: [], statusOnly: true,
        conversationUnavailable: unavailable || pending.automationPausePending === true, automationPausedUntil: until,
        ...(recoveryConversationUrl ? { recoveryConversationUrl } : {}) }),
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Automation pause synchronization returned ${response.status}.`);
    const voiceUrl = response.headers.get("X-Voice-Conversation-Url");
    if (voiceUrl !== null) await extensionApi.storage.local.set({ serverVoiceConversationUrl: conversationUrl(voiceUrl) });
    const header = response.headers.get("X-Automation-Paused-Until");
    if (header !== null) {
      const until = Number(header);
      if (Number.isSafeInteger(until) && until >= 0) {
        await extensionApi.storage.local.set({ automationPausedUntil: until, automationPausePending: false });
      }
    }
    pauseSyncedAt = Date.now();
    return response.headers.get("X-Recovery-Message-Pending") === "true";
  })();
  pauseSync = operation;
  try { return await operation; } finally { if (pauseSync === operation) pauseSync = null; }
}

async function waitForAutomationResume() {
  while (true) {
    if (Date.now() - pauseSyncedAt >= 5000) await syncAutomationPause().catch(() => undefined);
    const { automationPausedUntil = 0 } = await extensionApi.storage.local.get("automationPausedUntil");
    if (automationPausedUntil <= Date.now()) return;
    await sleep(Math.min(1000, automationPausedUntil - Date.now()));
  }
}

async function conversationUnavailable(message, sender) {
  if (sender.id !== extensionApi.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return { ok: false };
  const tab = await extensionApi.tabs.get(sender.tab.id);
  const url = conversationUrl(tab.url);
  if (await isVoiceConversation(url)) return { ok: true };
  if (!url || url !== conversationUrl(message.conversationUrl) || new URL(sender.url).origin !== "https://chatgpt.com") return { ok: false };
  const key = `pageRecovery:${tab.id}`;
  const saved = await extensionApi.storage.local.get(key);
  if (!saved[key]?.conversationUnavailableAt || saved[key]?.conversationUnavailableUrl !== url) {
    await extensionApi.storage.local.set({ [key]: { ...saved[key], conversationUnavailableAt: Date.now(), conversationUnavailableUrl: url } });
    await syncAutomationPause(true).catch(() => undefined);
  }
  return { ok: true };
}
const trackedThreadTabs = new Map();
const trackingThreadTabs = new Map();
const registeringConversations = new Set();

async function settleViewedThread(value) {
  const url = conversationUrl(value);
  if (!url || !(await extensionApi.storage.local.get(`viewedCompletion:${url}`))[`viewedCompletion:${url}`]) return;
  const tabs = await extensionApi.tabs.query({});
  if (tabs.some(tab => tab.active && automationTargetMatches(tab.url, url))) return;
  const response = await fetch(ralphRegisterEndpoint.href, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
    body: JSON.stringify({ conversationUrl: url, settled: true }),
    signal: AbortSignal.timeout(5000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Thread settlement returned ${response.status}.`);
  await extensionApi.storage.local.remove(`viewedCompletion:${url}`);
}

async function trackViewedThread(tab) {
  if (!Number.isInteger(tab?.windowId) || !tab.active) return;
  const key = `viewedThreadWindow:${tab.windowId}`;
  const previous = (await extensionApi.storage.local.get(key))[key];
  const current = conversationUrl(tab.url);
  await extensionApi.storage.local.set({ [key]: current });
  if (current && (await extensionApi.storage.local.get(`threadActivity:${current}`))[`threadActivity:${current}`] === "idle") {
    await extensionApi.storage.local.set({ [`viewedCompletion:${current}`]: true });
  }
  if (previous && previous !== current) await settleViewedThread(previous);
}

function trackThreadTab(tabId, value) {
  const url = conversationUrl(value);
  if (!Number.isInteger(tabId)) return;
  const previous = trackedThreadTabs.get(tabId);
  if (url) trackedThreadTabs.set(tabId, url);
  else trackedThreadTabs.delete(tabId);
  const tracking = (trackingThreadTabs.get(tabId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await extensionApi.storage.local.set({
        [`ralphTab:${tabId}`]: url,
        ...(url ? { [`closedThread:${url}`]: false } : {}),
      });
      if (previous && previous !== url) await settleViewedThread(previous);
    })
    .finally(() => {
      if (trackingThreadTabs.get(tabId) === tracking) trackingThreadTabs.delete(tabId);
    });
  trackingThreadTabs.set(tabId, tracking);
  return tracking;
}

async function reportClosedThreadTabs() {
  const stored = await extensionApi.storage.local.get(null);
  for (const [key, url] of Object.entries(stored)) {
    if (key.startsWith("viewedCompletion:") && url) {
      await settleViewedThread(key.slice("viewedCompletion:".length));
    }
    if (!key.startsWith("closedRalphTab:") || !url) continue;
    const response = await fetch(ralphRegisterEndpoint.href, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
      body: JSON.stringify({ conversationUrl: url, settled: true }),
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!response.ok) throw new Error(`RALPH tab removal returned ${response.status}.`);
    await extensionApi.storage.local.remove(key);
  }
}

async function threadTabRemoved(tabId, removeInfo) {
  const key = `ralphTab:${tabId}`;
  const trackedUrl = trackedThreadTabs.get(tabId);
  trackedThreadTabs.delete(tabId);
  await trackingThreadTabs.get(tabId)?.catch(() => undefined);
  const stored = await extensionApi.storage.local.get(key);
  const url = trackedUrl ?? stored[key];
  const otherTabs = url ? await extensionApi.tabs.query({}) : [];
  if (url && !otherTabs.some(tab => tab.id !== tabId && automationTargetMatches(tab.url, url))) {
    await extensionApi.storage.local.set({ [`closedRalphTab:${tabId}`]: url, [`closedThread:${url}`]: true });
    await forgetOwnedThreadTab(url, tabId);
    await Promise.allSettled([...registeringConversations]
      .filter(entry => automationTargetMatches(entry.url, url)).map(entry => entry.promise));
    reportedRalphConversations.delete(url);
  }
  await extensionApi.storage.local.remove([key, `pageRecovery:${tabId}`]);
  await reportClosedThreadTabs();
}

function validateLoopbackEndpoint(value, pathname) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== pathname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`Local Codex Support endpoint must be ${pathname} on configured IPv4 loopback.`);
  }
  return endpoint;
}

function canonicalProjectId(value) {
  const known = value.match(/^(g-p-[0-9a-f]{32})(?:-[A-Za-z0-9_-]+)?$/i);
  return known ? known[1].toLowerCase() : value;
}

function conversationUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^(?:\/g\/([A-Za-z0-9_-]+))?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password || !match) return null;
    return (match[1]
      ? `https://chatgpt.com/g/${canonicalProjectId(match[1])}/c/${match[2].toLowerCase()}`
      : `https://chatgpt.com/c/${match[2].toLowerCase()}`) + (url.searchParams.get("temporary-chat") === "true" ? "?temporary-chat=true" : "");
  } catch {
    return null;
  }
}

function normalizeThreadTitle(value) {
  if (typeof value !== "string") return undefined;
  const title = value.trim().replace(/\s+-\s+ChatGPT$/i, "").trim();
  if (!title || /^ChatGPT(?:\s+[\u002d\u2013\u2014]\s+.+)?$/i.test(title)) return undefined;
  const parts = title.split(/\s+[\u002d\u2013\u2014]\s+/).map(part => part.trim());
  if (parts.some(part => /^New chat$/i.test(part))) return undefined;
  return title.slice(0, 200);
}
function projectHomeId(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password) return null;
    const match = url.pathname.match(/^\/g\/([^/]+)\/project\/?$/i);
    if (!match) return null;
    const canonical = match[1].match(/^(g-p-[0-9a-f]{32})(?:-[A-Za-z0-9_-]+)?$/i);
    return canonical ? canonical[1].toLowerCase() : match[1];
  } catch {
    return null;
  }
}

function automationTargetMatches(currentValue, targetValue) {
  try {
    const targetConversation = conversationUrl(targetValue);
    if (targetConversation) return conversationUrl(currentValue)?.split("/c/")[1] === targetConversation.split("/c/")[1];

    const targetProject = projectHomeId(targetValue);
    if (targetProject) return projectHomeId(currentValue) === targetProject;

    const current = new URL(currentValue);
    const target = new URL(targetValue);
    if (current.origin !== "https://chatgpt.com" || target.origin !== "https://chatgpt.com") return false;
    const normalizePath = (value) => value.length > 1 ? value.replace(/\/$/, "") : value;
    return normalizePath(current.pathname) === normalizePath(target.pathname);
  } catch {
    return false;
  }
}

async function getSettings() {
  const stored = await extensionApi.storage.local.get(DEFAULT_SETTINGS);
  return {
    threadSync: stored.threadSync !== false,
    automationExecutor: stored.automationExecutor === true,
    errorRecovery: stored.errorRecovery !== false,
    ralph: stored.ralph === true,
    threadMessaging: stored.threadMessaging === true,
  };
}

function observeConversation(value) {
  const currentUrl = conversationUrl(value);
  if (!currentUrl) return Promise.resolve();
  const existing = observingConversations.get(currentUrl);
  if (existing) return existing;

  const observation = (async () => {
    const settings = await getSettings();
    if (!settings.threadSync) return;
    const now = Date.now();
    if (now - (observedAt.get(currentUrl) ?? 0) < 60_000) return;
    const response = await fetch(threadObserveEndpoint.href, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
      body: JSON.stringify({
        conversationUrl: currentUrl,
        canPrepare: settings.automationExecutor,
      }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Thread observation returned ${response.status}.`);
    observedAt.set(currentUrl, now);
    for (const [url, timestamp] of observedAt) {
      if (now - timestamp >= 60_000) observedAt.delete(url);
    }
  })().finally(() => observingConversations.delete(currentUrl));
  observingConversations.set(currentUrl, observation);
  return observation;
}
function registerRalphConversation(value, options = {}) {
  const entry = { url: value, promise: registerRalphConversationOnce(value, options) };
  registeringConversations.add(entry);
  return entry.promise.finally(() => registeringConversations.delete(entry));
}

async function registerRalphConversationOnce(value, { reactivate = false, externalUpdate = false, agentCreated = false, title, activity } = {}) {
  const currentUrl = conversationUrl(value);
  if (await isVoiceConversation(currentUrl)) return;
  const settings = await getSettings();
  const currentTitle = normalizeThreadTitle(title);
  if (!currentUrl ||
      (!activity && !reactivate && !externalUpdate && !agentCreated && !currentTitle && reportedRalphConversations.has(currentUrl))) return;
  const response = await fetch(ralphRegisterEndpoint.href, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
    body: JSON.stringify({
      conversationUrl: currentUrl,
      ...(reactivate ? { reactivate: true } : {}),
      ...(externalUpdate ? { externalUpdate: true } : {}),
      ...(agentCreated ? { agentCreated: true } : {}),
      ...(currentTitle ? { title: currentTitle } : {}),
      ...(activity ? { activity } : {}),
      checkForCompletion: settings.ralph,
    }),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`RALPH registration returned ${response.status}.`);
  const data = await response.json();
  if (data.status === "registered" || data.status === "ignored") reportedRalphConversations.add(currentUrl);
}

async function getBrowserId() {
  const stored = await extensionApi.storage.local.get("browserId");
  if (typeof stored.browserId === "string" && stored.browserId) return stored.browserId;
  const browserId = crypto.randomUUID();
  await extensionApi.storage.local.set({ browserId });
  return browserId;
}

async function getOwnedThreadTabs() {
  const stored = await extensionApi.storage.local.get(AUTOMATION_THREAD_TABS_KEY);
  const value = stored[AUTOMATION_THREAD_TABS_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

async function rememberOwnedThreadTab(value, tabId) {
  const currentUrl = conversationUrl(value);
  if (!currentUrl || !Number.isInteger(tabId)) return;
  const owned = await getOwnedThreadTabs();
  owned[currentUrl] = tabId;
  await extensionApi.storage.local.set({ [AUTOMATION_THREAD_TABS_KEY]: owned });
}

async function forgetOwnedThreadTab(value, expectedTabId) {
  const currentUrl = conversationUrl(value);
  if (!currentUrl) return;
  const owned = await getOwnedThreadTabs();
  if (!(currentUrl in owned) || (expectedTabId !== undefined && owned[currentUrl] !== expectedTabId)) return;
  delete owned[currentUrl];
  await extensionApi.storage.local.set({ [AUTOMATION_THREAD_TABS_KEY]: owned });
}

async function findConversationTab(value) {
  const currentUrl = conversationUrl(value);
  if (!currentUrl) return null;
  const owned = await getOwnedThreadTabs();
  const ownedTabId = owned[currentUrl];
  if (Number.isInteger(ownedTabId)) {
    try {
      const tab = await extensionApi.tabs.get(ownedTabId);
      if (typeof tab.url === "string" && automationTargetMatches(tab.url, currentUrl)) {
        return { tab, owned: true };
      }
    } catch {
      // The user may have closed the automation tab manually.
    }
    await forgetOwnedThreadTab(currentUrl, ownedTabId);
  }

  const tabs = await extensionApi.tabs.query({ url: "https://chatgpt.com/*" });
  const tab = tabs.find(candidate => Number.isInteger(candidate.id) &&
    typeof candidate.url === "string" && automationTargetMatches(candidate.url, currentUrl));
  return tab ? { tab, owned: false } : null;
}

async function acquireAutomationTab(targetUrl, createsNewThread) {
  if (!createsNewThread) {
    const existing = await findConversationTab(targetUrl);
    if (existing) return { ...existing, created: false };
    if (new URL(targetUrl).searchParams.get("temporary-chat") === "true") {
      throw new Error("CHATGPT_TAB_UNAVAILABLE: The temporary task tab is closed. It cannot be reopened.");
    }
  }
  const windows = await extensionApi.tabs.query({ windowType: "normal" });
  const windowId = windows.find(tab => Number.isInteger(tab.windowId) && !tab.incognito)?.windowId;
  if (!Number.isInteger(windowId)) throw new Error("Open a Chrome window before starting ChatGPT automation.");
  await waitForAutomationResume();
  const tab = await extensionApi.tabs.create({ windowId, url: targetUrl, active: false });
  if (!Number.isInteger(tab.id)) throw new Error("ChatGPT automation tab did not receive an id.");
  await trackThreadTab(tab.id, targetUrl);
  return { tab, owned: true, created: true };
}

async function closeOwnedThreadTab(value) {
  const currentUrl = conversationUrl(value);
  if (!currentUrl) throw new Error("Thread cleanup requires a saved ChatGPT conversation URL.");
  if (await isVoiceConversation(currentUrl)) return { status: "not_owned", conversationUrl: currentUrl };
  const owned = await getOwnedThreadTabs();
  const tabId = owned[currentUrl];
  if (!Number.isInteger(tabId)) return { status: "not_owned", conversationUrl: currentUrl };

  let tab;
  try {
    tab = await extensionApi.tabs.get(tabId);
  } catch {
    await forgetOwnedThreadTab(currentUrl, tabId);
    return { status: "closed", conversationUrl: currentUrl };
  }
  if (typeof tab.url !== "string" || !automationTargetMatches(tab.url, currentUrl)) {
    await forgetOwnedThreadTab(currentUrl, tabId);
    return { status: "not_owned", conversationUrl: currentUrl };
  }

  // Keep ownership recorded until removal succeeds so a transient browser error can be retried.
  await waitForAutomationResume();
  await extensionApi.tabs.remove(tabId);
  await forgetOwnedThreadTab(currentUrl, tabId);
  return { status: "closed", conversationUrl: currentUrl };
}

async function bind(message, sender) {
  const settings = await getSettings();
  if (!settings.threadSync) {
    return { status: "error", error: "Thread sync is disabled in this browser.", retryable: false };
  }
  if (sender.id !== extensionApi.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) ||
      typeof message.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(message.token)) {
    return { status: "error", error: "Invalid extension message source.", retryable: false };
  }
  let senderOrigin;
  try {
    senderOrigin = new URL(sender.url).origin;
  } catch {
    return { status: "error", error: "Invalid ChatGPT message source.", retryable: false };
  }
  const requestedUrl = conversationUrl(message.conversationUrl);
  const currentUrl = conversationUrl((await extensionApi.tabs.get(sender.tab.id)).url);
  if (senderOrigin !== "https://chatgpt.com" || !requestedUrl || requestedUrl !== currentUrl) {
    return { status: "error", error: "Thread Sync no longer matches the current conversation.", retryable: false };
  }
  try {
    const response = await fetch(bindEndpoint.href, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
      body: JSON.stringify({ token: message.token, conversationUrl: currentUrl }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    const data = await response.json();
    return response.ok
      ? data
      : { status: "error", error: data.error || `Thread Sync returned ${response.status}.`, retryable: response.status === 429 || response.status >= 500 };
  } catch {
    return { status: "error", error: `Could not reach ${bindEndpoint.origin}.`, retryable: true };
  }
}

async function reactivateRalphConversation(message, sender) {
  if (sender.id !== extensionApi.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) {
    return { ok: false, error: "Invalid extension message source." };
  }
  const requestedUrl = conversationUrl(message.conversationUrl);
  const currentUrl = conversationUrl((await extensionApi.tabs.get(sender.tab.id)).url);
  if (!requestedUrl || requestedUrl !== currentUrl) {
    return { ok: false, error: "RALPH no longer matches the current conversation." };
  }
  const settings = await getSettings();
  const activity = ["running", "idle", "blocked"].includes(message.activity) ? message.activity : undefined;
  if (settings.errorRecovery && (message.interrupted === true ||
      ["connection_interrupted", "recoverable_error", "rate_limited"].includes(message.pageHealth))) {
    void keepWorkerAliveUntil(recoverPage(sender.tab.id)).catch(error => console.warn("ChatGPT error recovery:", error));
  }
  await registerRalphConversation(currentUrl, { reactivate: activity ? activity === "running" : message.completed !== true,
    externalUpdate: !settings.automationExecutor, activity, title: message.title });
  const tab = await extensionApi.tabs.get(sender.tab.id);
  if (activity) await extensionApi.storage.local.set({ [`threadActivity:${currentUrl}`]: activity });
  if (activity === "idle" && tab.active) {
    await extensionApi.storage.local.set({ [`viewedCompletion:${currentUrl}`]: true });
  } else if (activity === "running") {
    await extensionApi.storage.local.remove(`viewedCompletion:${currentUrl}`);
  }
  return { ok: true };
}

async function reportRalphTitle(message, sender) {
  if (sender.id !== extensionApi.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) {
    return { ok: false, error: "Invalid extension message source." };
  }
  const requestedUrl = conversationUrl(message.conversationUrl);
  const currentTab = await extensionApi.tabs.get(sender.tab.id);
  const currentUrl = conversationUrl(currentTab.url);
  const title = normalizeThreadTitle(message.title);
  if (!requestedUrl || requestedUrl !== currentUrl || !title) {
    return { ok: false, error: "RALPH title no longer matches the current conversation." };
  }
  await registerRalphConversation(currentUrl, { title });
  return { ok: true };
}

async function postResult(payload) {
  const response = await fetch(resultEndpoint.href, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Support result endpoint returned ${response.status}.`);
  }
}

async function waitForTabComplete(tabId, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await extensionApi.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(100);
  }
  throw new Error("Timed out waiting for ChatGPT tab to load.");
}

async function sendAutomationMessage(tabId, command) {
  const recovery = command.recovering ? recoveringPages.get(tabId) : undefined;
  if (command.feature !== "voice") {
    if (command.recovering && command.targetUrl && await syncAutomationPause(false, command.targetUrl)) {
      const recovery = recoveringPages.get(tabId);
      if (recovery) recovery.resume = false;
      if (command.recoveryContinuation) return { ok: true, result: { status: "idle" } };
    }
    await waitForAutomationResume();
    const currentUrl = (await extensionApi.tabs.get(tabId)).url;
    if (await isVoiceConversation(currentUrl)) {
      throw new Error("The dedicated Voice conversation is protected from page automation.");
    }
    if (command.recovering && command.targetUrl && !automationTargetMatches(currentUrl, command.targetUrl)) {
      throw new Error("Recovery stopped because the tab navigated away.");
    }
    if (recovery && !recovery.reservation) {
      recovery.reservation = await recoveryReservation(recovery, { action: "acquire", ...(recovery.commandId ? { commandId: recovery.commandId } : {}) });
    }
  }
  // Establish the receiver before dispatching a side-effecting command. A lost response
  // does not prove that the page failed to send the message.
  try {
    if (command.feature === "voice") await extensionApi.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["voice-audio.js"] });
    await extensionApi.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
  } catch (error) {
    if (command.kind === "send_message" && error instanceof Error) error.retryable = true;
    throw error;
  }
  if (command.recoveryContinuation) {
    const recovery = recoveringPages.get(tabId);
    if (recovery?.targetUrl && !automationTargetMatches((await extensionApi.tabs.get(tabId)).url, recovery.targetUrl)) {
      throw new Error("Recovery stopped because the tab navigated away.");
    }
    if (!recovery?.resume || [...pendingMessages.values()].some(url => automationTargetMatches(url, recovery.targetUrl))) {
      return { ok: true, result: { status: "idle" } };
    }
    // No await between claiming this delivery and dispatch. A later queued message
    // cannot supersede a continuation that may already have clicked Send.
    recovery.continuationStarted = true;
  }
  if (recovery?.reservation && Date.now() >= recovery.reservation.expiresAt) throw new Error("Recovery reservation expired before delivery.");
  if (recovery) recovery.deliveryUncertain = true;
  const response = await extensionApi.tabs.sendMessage(tabId, { type: AUTOMATION_MESSAGE,
    command: recovery?.reservation ? { ...command, recoveryExpiresAt: recovery.reservation.expiresAt } : command });
  if (recovery) recovery.deliveryUncertain = false;
  return response;
}

async function sendAutomationMessageWithTimeout(tabId, command) {
  if (command.feature !== "voice") await waitForAutomationResume();
  let timeout;
  try {
    return await Promise.race([
      sendAutomationMessage(tabId, command),
      new Promise((_, reject) => {
        const timeoutMs = command.feature === "voice" ? (command.kind === "voice_status" ? 2000 : 45_000) : command.kind === "inspect_thread" ? 30_000 : command.kind === "page_health" ? 15_000 : AUTOMATION_RESPONSE_TIMEOUT_MS;
        const expire = async () => {
          const { automationPausedUntil = 0 } = await extensionApi.storage.local.get("automationPausedUntil");
          if (command.feature !== "voice" && automationPausedUntil > Date.now()) timeout = setTimeout(expire, automationPausedUntil - Date.now() + timeoutMs);
          else reject(new Error("Timed out waiting for ChatGPT page automation."));
        };
        timeout = setTimeout(expire, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function keepWorkerAliveUntil(operation) {
  // A long page automation can outlive Chrome's 30-second extension-worker idle window.
  let stopped = false;
  let timer;
  const pulse = async () => {
    try {
      await extensionApi.runtime.getPlatformInfo?.();
      await syncAutomationPause();
    } catch {
      // The command still has its own bounded error path if a keepalive pulse fails.
    }
    if (!stopped) timer = setTimeout(pulse, WORKER_KEEPALIVE_INTERVAL_MS);
  };
  timer = setTimeout(pulse, WORKER_KEEPALIVE_INTERVAL_MS);
  try {
    return await operation;
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
}

async function commandTargetUrl(command) {
  if (command.kind === "inspect_thread" || command.kind === "prepare_thread" || command.kind === "close_thread") return command.conversationUrl;
  if (typeof command.targetUrl === "string" && command.targetUrl) return command.targetUrl;
  throw new Error("ChatGPT support command is missing its server-resolved target URL.");
}

const executingCommands = new Map();
const pendingMessages = new Map();
let executionTail = Promise.resolve();

function executeCommand(command, browserId) {
  const existing = executingCommands.get(command.id);
  if (existing) return existing;
  if (command.feature === "voice") {
    const operation = keepWorkerAliveUntil(executeVoiceCommand(command, browserId))
      .finally(() => executingCommands.delete(command.id));
    executingCommands.set(command.id, operation);
    return operation;
  }
  let recoveryConflict = false;
  if (command.kind === "send_message" && typeof command.targetUrl === "string") {
    pendingMessages.set(command.id, command.targetUrl);
    for (const recovery of recoveringPages.values()) {
      if (!recovery.targetUrl || !automationTargetMatches(command.targetUrl, recovery.targetUrl)) continue;
      recoveryConflict ||= recovery.continuationStarted;
      recovery.resume = false;
    }
  }
  const operation = executionTail.catch(() => undefined)
    .then(() => recoveryConflict
      ? postResult({ commandId: command.id, browserId, kind: command.kind, ok: false, deliveryUncertain: false,
        error: "CHATGPT_RECOVERY_FAILED: A recovery continuation is already being delivered. The queued message was not sent. Retry after the current turn stops." })
      : keepWorkerAliveUntil(executeCommandOnce(command, browserId)))
    .finally(() => { executingCommands.delete(command.id); pendingMessages.delete(command.id); });
  executingCommands.set(command.id, operation);
  executionTail = operation;
  return operation;
}

async function isVoiceConversation(value) {
  const stored = await extensionApi.storage.local.get(["voiceConversationUrl", "serverVoiceConversationUrl", "voiceTabId", "voiceTabUrl"]);
  if (!value) return false;
  const current = conversationUrl(value);
  if (Number.isInteger(stored.voiceTabId)) {
    const tab = await extensionApi.tabs.get(stored.voiceTabId).catch(() => null);
    const tracked = tab && voicePageUrl(tab.url);
    if (tracked && (tracked === stored.voiceTabUrl || stored.voiceTabUrl === "https://chatgpt.com/" ||
        (stored.voiceTabUrl?.startsWith("https://chatgpt.com/c/local-chatgpt%3A") && tracked === conversationUrl(tab.url))) && voicePageUrl(value) === tracked) return true;
  }
  return Boolean(current && [stored.voiceConversationUrl, stored.serverVoiceConversationUrl].some(configured =>
    configured && current.split("/c/")[1]?.split("?")[0] === configured.split("/c/")[1]?.split("?")[0]));
}

function voicePageUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== "https://chatgpt.com" || parsed.username || parsed.password || parsed.searchParams.get("temporary-chat") === "true") return null;
    if (parsed.pathname === "/") return "https://chatgpt.com/";
    const local = parsed.pathname.match(/^\/c\/local-chatgpt(?:%3A|:)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
    if (local) return `https://chatgpt.com/c/local-chatgpt%3A${local[1].toLowerCase()}`;
    const saved = conversationUrl(value);
    return saved && !saved.includes("/g/") ? saved : null;
  } catch { return null; }
}

async function executeVoiceCommand(command, browserId) {
  try {
    let targetUrl = voicePageUrl(command.targetUrl);
    if (!targetUrl) {
      throw new Error("Voice requires a regular ChatGPT conversation.");
    }
    const tabs = await extensionApi.tabs.query({ url: "https://chatgpt.com/*" });
    let selected;
    if (command.discover) {
      const stored = await extensionApi.storage.local.get(["voiceTabId", "voiceTabUrl", "voiceConversationUrl", "serverVoiceConversationUrl", "automationThreadTabsV1"]);
      const eligible = tabs.filter(tab => voicePageUrl(tab.url) && !tab.incognito &&
        !Object.values(stored.automationThreadTabsV1 ?? {}).includes(tab.id));
      const remembered = eligible.find(tab => tab.id === stored.voiceTabId &&
        (voicePageUrl(tab.url) === stored.voiceTabUrl || stored.voiceTabUrl === "https://chatgpt.com/" ||
          (stored.voiceTabUrl?.startsWith("https://chatgpt.com/c/local-chatgpt%3A") && voicePageUrl(tab.url) === conversationUrl(tab.url)))) ??
        eligible.find(tab => [stored.voiceConversationUrl, stored.serverVoiceConversationUrl].includes(voicePageUrl(tab.url)));
      const observed = command.kind === "voice_status" && remembered ? [] : await Promise.allSettled(eligible.filter(tab => tab.status === "complete").map(async tab => {
        const response = await sendAutomationMessageWithTimeout(tab.id, { feature: "voice", kind: "voice_status", targetUrl: voicePageUrl(tab.url) });
        return response?.ok && response.result.status === "active" ? tab : null;
      }));
      const active = observed.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
      if (active.length > 1) throw new Error("Multiple Voice calls are open. End the extra call before waking Voice.");
      selected = active[0] ?? remembered;
      targetUrl = selected ? voicePageUrl(selected.url) : "https://chatgpt.com/";
    } else {
      const matches = tabs.filter(tab => voicePageUrl(tab.url) === targetUrl);
      if (matches.length > 1) throw new Error("The Voice conversation is open in multiple tabs. Close the duplicate before controlling its call.");
      selected = matches[0];
    }
    let acquired = selected ? { tab: selected } : null;
    if (!acquired && command.kind === "voice_start") {
      const tabs = await extensionApi.tabs.query({ windowType: "normal" });
      const windowId = tabs.find(tab => Number.isInteger(tab.windowId) && !tab.incognito)?.windowId;
      if (!Number.isInteger(windowId)) throw new Error("Open a Chrome window before starting Voice.");
      acquired = { tab: await extensionApi.tabs.create({ windowId, url: targetUrl, active: true }) };
    }
    let result;
    if (!acquired) {
      if (command.kind === "voice_mute" || command.kind === "voice_unmute") throw new Error("No active Voice call to mute or unmute.");
      result = { status: "closed", conversationUrl: targetUrl };
    } else {
      const tab = command.kind === "voice_status" ? await extensionApi.tabs.get(acquired.tab.id) : await waitForTabComplete(acquired.tab.id, 30_000);
      if (voicePageUrl(tab.url) !== targetUrl) throw new Error("Voice tab navigated away from the selected conversation.");
      const recovery = recoveringPages.get(tab.id);
      if (recovery?.continuationStarted || [...pendingMessages.values()].some(url => automationTargetMatches(url, targetUrl))) {
        throw new Error("Wait for the current message delivery before configuring or controlling Voice.");
      }
      if (recovery) recovery.resume = false;
      await extensionApi.storage.local.set({ voiceTabId: tab.id, voiceTabUrl: targetUrl, voiceConversationUrl: targetUrl });
      if (command.kind === "voice_start") await extensionApi.tabs.update(tab.id, { active: true });
      let response = command.kind === "voice_status" && tab.status !== "complete"
        ? { ok: true, result: { status: "loading", conversationUrl: targetUrl, microphone: "unavailable" } }
        : await sendAutomationMessageWithTimeout(tab.id, { ...command, targetUrl });
      if (command.kind === "voice_start" && !response?.ok && response?.error?.startsWith("VOICE_LOADING_STUCK:")) {
        if (voicePageUrl((await extensionApi.tabs.get(tab.id)).url) !== targetUrl) throw new Error("Voice tab navigated away before loading recovery.");
        await extensionApi.tabs.reload(tab.id);
        const refreshed = await waitForTabComplete(tab.id, 30_000);
        if (voicePageUrl(refreshed.url) !== targetUrl) throw new Error("Voice tab navigated away during loading recovery.");
        response = await sendAutomationMessageWithTimeout(tab.id, { ...command, targetUrl });
      }
      if (!response?.ok) throw new Error(response?.error || "ChatGPT Voice control failed.");
      result = { ...response.result, tabId: tab.id };
      const finalUrl = voicePageUrl((await extensionApi.tabs.get(tab.id)).url);
      const promoted = targetUrl.startsWith("https://chatgpt.com/c/local-chatgpt%3A") && finalUrl === conversationUrl((await extensionApi.tabs.get(tab.id)).url);
      if (!finalUrl || result?.conversationUrl !== finalUrl || (targetUrl !== "https://chatgpt.com/" && finalUrl !== targetUrl && !promoted)) throw new Error("Voice command returned a different conversation.");
      await extensionApi.storage.local.set({ voiceTabUrl: finalUrl, voiceConversationUrl: finalUrl });
    }
    await postResult({ commandId: command.id, browserId, kind: command.kind, ok: true, result });
  } catch (error) {
    await postResult({ commandId: command.id, browserId, kind: command.kind, ok: false,
      error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  }
}

async function executeCommandOnce(command, browserId) {
  await waitForAutomationResume();
  let targetUrl;
  try {
    targetUrl = await commandTargetUrl(command);
    if (await isVoiceConversation(targetUrl)) throw new Error("The dedicated Voice conversation is protected from thread automation.");
  } catch (error) {
    await postResult({
      commandId: command.id,
      browserId,
      kind: command.kind,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    return;
  }

  if (command.kind === "close_thread") {
    try {
      const result = await closeOwnedThreadTab(targetUrl);
      await postResult({ commandId: command.id, browserId, kind: command.kind, ok: true, result });
    } catch (error) {
      await postResult({
        commandId: command.id,
        browserId,
        kind: command.kind,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    return;
  }

  const createsNewThread = command.kind === "send_message" && conversationUrl(targetUrl) === null;
  let tabId;
  let created = false;
  let keepCreatedTab = false;
  let deliveryUncertain = false;
  let refreshed = false;

  try {
    const settings = await getSettings();
    const temporary = command.temporary === true || new URL(targetUrl).searchParams.get("temporary-chat") === "true";
    const observing = !settings.automationExecutor;
    if (observing && command.kind !== "inspect_thread") {
      throw new Error("This browser is only available for thread observation.");
    }
    const closedKey = `closedThread:${conversationUrl(targetUrl)}`;
    const closed = await extensionApi.storage.local.get(closedKey);
    const acquired = observing || (closed[closedKey] && (command.kind === "inspect_thread" || command.kind === "prepare_thread"))
      ? await findConversationTab(targetUrl)
      : await acquireAutomationTab(targetUrl, createsNewThread);
    if (!acquired) throw new Error("CHATGPT_TAB_UNAVAILABLE: The thread tab has closed or navigated away.");
    tabId = acquired.tab.id;
    created = acquired.created === true;
    const existingConversation = conversationUrl(targetUrl);
    if (created && existingConversation) {
      await rememberOwnedThreadTab(existingConversation, tabId);
      keepCreatedTab = true;
    }
    let loadedTab;
    try {
      loadedTab = await waitForTabComplete(tabId, command.kind === "inspect_thread" ? 5_000 : undefined);
    } catch (error) {
      if (temporary || observing) throw error;
      loadedTab = await reloadPageAfterFailure(tabId, targetUrl);
      refreshed = true;
    }
    if (typeof loadedTab.url !== "string" || !automationTargetMatches(loadedTab.url, targetUrl)) {
      if (created && existingConversation) {
        await forgetOwnedThreadTab(existingConversation, tabId);
        keepCreatedTab = false;
      }
      throw new Error("ChatGPT automation was redirected away from the requested target.");
    }

    if (!observing && !temporary && command.refreshRevision && existingConversation && command.kind !== "stop_thread") {
      const revisionKey = `threadRevision:${tabId}`;
      const saved = await extensionApi.storage.local.get(revisionKey);
      if (!created && saved[revisionKey] !== command.refreshRevision) {
        const inspection = await sendAutomationMessageWithTimeout(tabId, { kind: "inspect_thread" });
        if (!inspection?.ok || inspection.result?.status !== "idle") {
          throw new Error("External conversation update is pending. Refresh deferred until the automation tab is idle.");
        }
        await waitForAutomationResume();
        await extensionApi.tabs.reload(tabId);
        loadedTab = await waitForTabComplete(tabId);
        refreshed = true;
      }
      await extensionApi.storage.local.set({ [revisionKey]: command.refreshRevision });
    }

    if (!observing && command.kind !== "stop_thread") {
      try {
        refreshed = await recoverPage(tabId, command.kind !== "send_message", command.kind === "send_message" ? command.id : undefined) || refreshed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (temporary || refreshed || /^CHATGPT_(?:RATE_LIMITED(?:_RETRYABLE)?|RECOVERY_FAILED):/.test(message)) throw error;
        await reloadPageAfterFailure(tabId, targetUrl);
        refreshed = true;
        await recoverPage(tabId, command.kind !== "send_message", command.kind === "send_message" ? command.id : undefined);
      }
    }

    if (command.kind === "prepare_thread") {
      await postResult({
        commandId: command.id,
        browserId,
        kind: command.kind,
        ok: true,
        result: { status: "prepared", conversationUrl: targetUrl },
      });
      return;
    }

    const runPageCommand = async () => {
      deliveryUncertain = true;
      const response = await sendAutomationMessageWithTimeout(tabId, { ...command, recovering: refreshed });
      if (response?.ok) return response;
      deliveryUncertain = response?.retryable !== true;
      const error = new Error(response?.error || "ChatGPT page automation failed.");
      error.retryable = response?.retryable === true;
      throw error;
    };
    let response;
    try {
      response = await runPageCommand();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (observing || temporary || refreshed || /^CHATGPT_RATE_LIMITED(?:_RETRYABLE)?:/.test(message)) throw error;
      if (command.kind === "send_message" && error?.retryable !== true) throw error;
      await reloadPageAfterFailure(tabId, targetUrl);
      refreshed = true;
      if (command.kind !== "stop_thread") await recoverPage(tabId, command.kind !== "send_message", command.kind === "send_message" ? command.id : undefined);
      response = await runPageCommand();
    }

    if (command.kind === "send_message") {
      const savedUrl = conversationUrl(response.result?.conversationUrl);
      if (createsNewThread && savedUrl) {
        await trackThreadTab(tabId, savedUrl);
        await rememberOwnedThreadTab(savedUrl, tabId);
        keepCreatedTab = true;
      } else if (!createsNewThread) {
        await registerRalphConversation(response.result?.conversationUrl, {
          title: response.result?.title,
        }).catch(() => undefined);
      }
    }

    if (command.kind === "stop_thread") {
      await closeOwnedThreadTab(targetUrl);
      keepCreatedTab = false;
    }

    await postResult({
      commandId: command.id,
      browserId,
      kind: command.kind,
      ok: true,
      result: response.result,
    });
  } catch (error) {
    let errorMessage = error instanceof Error ? error.message : String(error);
    if (command.kind === "inspect_thread" && !/^CHATGPT_RATE_LIMITED/.test(errorMessage)) {
      await postResult({ commandId: command.id, browserId, kind: command.kind, ok: true,
        result: { status: "loading" } }).catch(() => undefined);
      return;
    }
    if (command.kind === "send_message" && !deliveryUncertain && errorMessage.startsWith("CHATGPT_RATE_LIMITED:")) {
      errorMessage = errorMessage.replace("CHATGPT_RATE_LIMITED:", "CHATGPT_RATE_LIMITED_RETRYABLE:");
    }
    if (Number.isInteger(tabId) && /^CHATGPT_RATE_LIMITED(?:_RETRYABLE)?:/.test(errorMessage)) {
      const key = `pageRecovery:${tabId}`;
      const saved = await extensionApi.storage.local.get(key);
      const rateLimitedUrl = (await extensionApi.tabs.get(tabId)).url;
      if (!saved[key]?.rateLimitedAt || (saved[key].rateLimitedUrl && !automationTargetMatches(rateLimitedUrl, saved[key].rateLimitedUrl))) {
        await extensionApi.storage.local.set({ [key]: { ...saved[key], rateLimitedAt: Date.now(), rateLimitedUrl } });
      }
    }
    if (created && Number.isInteger(tabId) && createsNewThread) {
      try {
        const current = await extensionApi.tabs.get(tabId);
        const savedUrl = conversationUrl(current.url);
        if (savedUrl) {
          await trackThreadTab(tabId, savedUrl);
          await rememberOwnedThreadTab(savedUrl, tabId);
          keepCreatedTab = true;
        }
      } catch {
        // If the tab disappeared, there is nothing left to preserve for inspection.
      }
    }
    await postResult({
      commandId: command.id,
      browserId,
      kind: command.kind,
      ok: false,
      error: errorMessage,
      ...(command.kind === "send_message" ? { deliveryUncertain: deliveryUncertain && error?.retryable !== true } : {}),
    }).catch(() => undefined);
  } finally {
    if (created && Number.isInteger(tabId) && !keepCreatedTab) {
      await waitForAutomationResume();
      await extensionApi.tabs.remove(tabId).catch(() => undefined);
    }
  }
}

const recoveringPages = new Map();
async function reloadPageAfterFailure(tabId, targetUrl) {
  await waitForAutomationResume();
  const key = `pageRecovery:${tabId}`;
  const stored = await extensionApi.storage.local.get(key);
  const state = stored[key] ?? {};
  const now = Date.now();
  if (state.rateLimitedAt && now - state.rateLimitedAt < RATE_LIMIT_WAIT_MS) {
    throw new Error("CHATGPT_RATE_LIMITED: Waiting ten minutes before dismissing the provider notice.");
  }
  if (state.rateLimitedAt) await extensionApi.storage.local.set({ [key]: {} });
  const current = await extensionApi.tabs.get(tabId);
  if (targetUrl && (typeof current.url !== "string" || !automationTargetMatches(current.url, targetUrl))) {
    throw new Error("ChatGPT automation navigated away from the requested target before refresh.");
  }
  await extensionApi.tabs.reload(tabId);
  const tab = await waitForTabComplete(tabId, 30_000);
  if (targetUrl && (typeof tab.url !== "string" || !automationTargetMatches(tab.url, targetUrl))) {
    throw new Error("ChatGPT automation was redirected away from the requested target after refresh.");
  }
  return tab;
}

async function recoveryReservation(recovery, reservation) {
  const response = await fetch(claimEndpoint.href, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
    body: JSON.stringify({ browserId: await getBrowserId(), features: [], statusOnly: true,
      recoveryConversationUrl: conversationUrl(recovery.targetUrl), recoveryReservation: reservation }),
    signal: AbortSignal.timeout(5000), redirect: "error",
  });
  if (!response.ok) throw new Error("CHATGPT_RECOVERY_FAILED: Recovery reservation was unavailable. The chat was not resumed.");
  if (reservation.action === "release") return;
  const result = await response.json();
  if (typeof result.id !== "string" || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) {
    throw new Error("CHATGPT_RECOVERY_FAILED: Invalid recovery reservation.");
  }
  return result;
}

async function recoverPage(tabId, resume = true, commandId) {
  const currentUrl = (await extensionApi.tabs.get(tabId)).url;
  if (await syncAutomationPause(false, conversationUrl(currentUrl))) resume = false;
  if (await isVoiceConversation(currentUrl)) return false;
  const existing = recoveringPages.get(tabId);
  if (existing) {
    if (!resume) {
      if (existing.continuationStarted) throw new Error("CHATGPT_RECOVERY_FAILED: A recovery continuation is already being delivered. The queued message was not sent.");
      existing.resume = false;
    }
    return existing.promise;
  }
  const recovery = { resume, commandId, continuationStarted: false, deliveryUncertain: false,
    targetUrl: undefined, promise: undefined, reservation: undefined };
  recovery.promise = recoverPageOnce(tabId, recovery).finally(async () => {
    if (recovery.reservation && !recovery.deliveryUncertain) {
      await recoveryReservation(recovery, { action: "release", id: recovery.reservation.id }).catch(() => undefined);
    }
    recoveringPages.delete(tabId);
  });
  recoveringPages.set(tabId, recovery);
  return recovery.promise;
}

async function recoverPageOnce(tabId, recovery) {
  await waitForAutomationResume();
  const targetUrl = (await extensionApi.tabs.get(tabId)).url;
  recovery.targetUrl = targetUrl;
  const key = `pageRecovery:${tabId}`;
  const stored = await extensionApi.storage.local.get(key);
  let state = stored[key] ?? {};
  if (state.rateLimitedAt && (!state.rateLimitedUrl || !automationTargetMatches(targetUrl, state.rateLimitedUrl))) {
    state = {};
    await extensionApi.storage.local.set({ [key]: state });
  }
  const now = Date.now();
  if (state.rateLimitedAt && now - state.rateLimitedAt < RATE_LIMIT_WAIT_MS) {
    throw new Error("CHATGPT_RATE_LIMITED: Waiting ten minutes before dismissing the provider notice.");
  }
  let health = await sendAutomationMessageWithTimeout(tabId, { kind: "page_health" });
  if (!health?.ok) throw new Error(health?.error || "Could not inspect ChatGPT page health.");
  let rateLimitDismissed = false;
  if (health.result?.status === "rate_limited") {
    if (!state.rateLimitedAt) {
      await extensionApi.storage.local.set({ [key]: { ...state, rateLimitedAt: now, rateLimitedUrl: targetUrl } });
      throw new Error("CHATGPT_RATE_LIMITED: Waiting ten minutes before dismissing the provider notice.");
    }
    const dismissal = await sendAutomationMessageWithTimeout(tabId, { kind: "dismiss_rate_limit", recovering: true, targetUrl });
    await extensionApi.storage.local.set({ [key]: { ...state, rateLimitedAt: now, rateLimitedUrl: targetUrl } });
    if (!dismissal?.ok || dismissal.result?.status !== "dismissed") {
      throw new Error("CHATGPT_RATE_LIMITED: The provider notice could not be dismissed.");
    }
    await sleep(250);
    health = await sendAutomationMessageWithTimeout(tabId, { kind: "page_health" });
    if (!health?.ok || !["ok", "connection_interrupted", "recoverable_error"].includes(health.result?.status)) {
      throw new Error("CHATGPT_RATE_LIMITED: The provider notice is still blocking the page.");
    }
    await extensionApi.storage.local.set({ [key]: {} });
    rateLimitDismissed = true;
  }
  if (health.result?.status === "conversation_unavailable") {
    const currentUrl = conversationUrl((await extensionApi.tabs.get(tabId)).url);
    if (!state.conversationUnavailableAt || state.conversationUnavailableUrl !== currentUrl) {
      await extensionApi.storage.local.set({ [key]: { ...state, conversationUnavailableAt: now, conversationUnavailableUrl: currentUrl } });
      await syncAutomationPause(true).catch(() => undefined);
      await waitForAutomationResume();
    }
    // The empty page gets one visible Retry after the shared cooldown, never a reload of a temporary chat.
    const retry = await sendAutomationMessageWithTimeout(tabId, { kind: "recover_page", recovering: true, targetUrl });
    await extensionApi.storage.local.set({ [key]: { ...state, conversationUnavailableAt: undefined, conversationUnavailableUrl: undefined } });
    if (!retry?.ok || retry.result?.status !== "recovery_started") throw new Error("The conversation is still unavailable after the automation pause.");
    return false;
  }
  if (rateLimitDismissed || ["connection_interrupted", "recoverable_error"].includes(health.result?.status)) {
    if (!conversationUrl(targetUrl)) throw new Error("Interrupted conversation is unavailable.");
    const current = await extensionApi.tabs.get(tabId);
    if (!automationTargetMatches(current.url, targetUrl)) throw new Error("Recovery stopped because the tab navigated away.");
    recovery.targetUrl = targetUrl;
    const stopped = await sendAutomationMessageWithTimeout(tabId, { kind: "stop_thread", recovering: true, targetUrl,
      requireFailure: !rateLimitDismissed }).catch(error => {
        throw new Error(`CHATGPT_RECOVERY_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      });
    if (stopped?.ok && stopped.result?.status === "error_cleared") return false;
    if (!stopped?.ok || !["stopped", "idle"].includes(stopped.result?.status)) throw new Error(`CHATGPT_RECOVERY_FAILED: ${stopped?.error || "The interrupted turn could not stop."}`);
    if (recovery.resume) {
      const resumed = await sendAutomationMessageWithTimeout(tabId, { kind: "send_message", recovering: true, targetUrl,
        recoveryContinuation: true, message: "Continue" })
        .catch(error => { throw new Error(`CHATGPT_RECOVERY_FAILED: ${error instanceof Error ? error.message : String(error)}`); });
      if (!resumed?.ok || !["sent", "idle"].includes(resumed.result?.status)) throw new Error(`CHATGPT_RECOVERY_FAILED: ${resumed?.error || "The interrupted turn could not resume."}`);
    }
    return true;
  }
  if (state.rateLimitedAt || state.conversationUnavailableAt) await extensionApi.storage.local.set({ [key]: {} });
  return false;
}

function enabledAutomationFeatures(settings) {
  if (!settings.automationExecutor) return [];
  const features = [];
  if (settings.threadSync && settings.automationExecutor) features.push("threadPreparation");
  if (settings.ralph) features.push("ralph");
  if (settings.threadMessaging) features.push("threadMessaging");
  if (settings.automationExecutor || settings.ralph || settings.threadMessaging) features.push("threadLifecycle");
  return features;
}

async function syncPollingAlarm() {
  if (!extensionApi.alarms) return;
  const settings = await getSettings();
  if (enabledAutomationFeatures(settings).length === 0 && !settings.errorRecovery) {
    await extensionApi.alarms.clear(SUPPORT_POLL_ALARM);
    return;
  }
  if (await extensionApi.alarms.get(SUPPORT_POLL_ALARM)) return;
  extensionApi.alarms.create(SUPPORT_POLL_ALARM, { periodInMinutes: SUPPORT_POLL_PERIOD_MINUTES });
}

async function pollCommands(generation, voiceOnly = false) {
  const browserId = (await getBrowserId()) + (voiceOnly ? ":voice" : "");
  while (generation === pollGeneration) {
    if (!voiceOnly) await waitForAutomationResume();
    if (generation !== pollGeneration) return;
    try {
      if (!voiceOnly) await reportClosedThreadTabs();
    } catch {
      await sleep(1000);
      continue;
    }
    const settings = await getSettings();
    const features = voiceOnly ? (settings.automationExecutor && settings.threadMessaging ? ["voice"] : []) : enabledAutomationFeatures(settings);
    if (voiceOnly && features.length === 0) return;
    const tabs = !voiceOnly && (settings.threadSync || settings.errorRecovery) ? await extensionApi.tabs.query({ url: "https://chatgpt.com/*" }) : [];
    const openThreads = settings.threadSync ? [...new Set(tabs.map(tab => conversationUrl(tab.url)).filter(Boolean))] : [];
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id) || !conversationUrl(tab.url)) continue;
      const key = `pageRecovery:${tab.id}`;
      const saved = await extensionApi.storage.local.get(key);
      const healthCheckKey = `pageHealthCheckedAt:${tab.id}`;
      const checked = await extensionApi.storage.local.get(healthCheckKey);
      if (settings.errorRecovery && (saved[key]?.conversationUnavailableAt ||
          (saved[key]?.rateLimitedAt && Date.now() - saved[key].rateLimitedAt >= RATE_LIMIT_WAIT_MS) ||
          Date.now() - (checked[healthCheckKey] ?? 0) >= PAGE_HEALTH_CHECK_INTERVAL_MS)) {
        await extensionApi.storage.local.set({ [healthCheckKey]: Date.now() });
        await keepWorkerAliveUntil(recoverPage(tab.id)).catch(() => undefined);
      }
    }
    const idleObserver = features.length === 0 && openThreads.length === 0;

    const controller = new AbortController();
    if (voiceOnly) voicePollController = controller;
    else pollController = controller;
    try {
      const response = await fetch(claimEndpoint.href, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
        body: JSON.stringify({ browserId, features, openThreads }),
        signal: controller.signal,
        redirect: "error",
      });
      if (generation !== pollGeneration) return;
      const voiceUrl = response.headers.get("X-Voice-Conversation-Url");
      if (voiceUrl !== null) await extensionApi.storage.local.set({ serverVoiceConversationUrl: conversationUrl(voiceUrl) });
      const pausedUntil = Number(response.headers.get("X-Automation-Paused-Until"));
      if (Number.isSafeInteger(pausedUntil) && pausedUntil > Date.now()) {
        await extensionApi.storage.local.set({ automationPausedUntil: pausedUntil });
      }
      if (idleObserver) return;
      if (response.status === 204) continue;
      if (!response.ok) {
        await sleep(1000);
        continue;
      }
      const command = await response.json();
      if (command?.id) await executeCommand(command, browserId);
    } catch (error) {
      if (controller.signal.aborted || generation !== pollGeneration || idleObserver) return;
      await sleep(1000);
    } finally {
      if (pollController === controller) pollController = null;
      if (voicePollController === controller) voicePollController = null;
    }
  }
}

function restartPolling() {
  pollGeneration += 1;
  pollController?.abort();
  voicePollController?.abort();
  const generation = pollGeneration;
  void pollCommands(generation);
  void pollCommands(generation, true);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === CONVERSATION_UNAVAILABLE_MESSAGE) {
    void conversationUnavailable(message, sender).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === SYNC_MESSAGE) {
    void bind(message, sender).then(sendResponse, () =>
      sendResponse({ status: "error", error: "The source tab is no longer available.", retryable: true }),
    );
    return true;
  }
  if (message?.type === REACTIVATE_RALPH_MESSAGE) {
    void reactivateRalphConversation(message, sender).then(sendResponse, () =>
      sendResponse({ ok: false, error: "Could not reactivate the RALPH thread." }),
    );
    return true;
  }
  if (message?.type === TITLE_OBSERVED_MESSAGE) {
    void reportRalphTitle(message, sender).then(sendResponse, () =>
      sendResponse({ ok: false, error: "Could not persist the RALPH thread title." }),
    );
    return true;
  }
  if (message?.type === "local-codex-support/settings-changed") {
    reportedRalphConversations.clear();
    restartPolling();
    void syncPollingAlarm();
    void scanExistingTabs();
    sendResponse({ ok: true });
  }
});

async function scanExistingTabs() {
  const tabs = await extensionApi.tabs.query({ url: "https://chatgpt.com/*" });
  await Promise.allSettled(tabs.flatMap((tab) => {
    const tasks = [];
    if (Number.isInteger(tab.id)) {
      tasks.push(trackThreadTab(tab.id, tab.url));
      tasks.push(extensionApi.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] }));
      tasks.push(registerRalphConversation(tab.url, { title: tab.title }));
    }
    if (tab.active && typeof tab.url === "string") {
      tasks.push(trackViewedThread(tab));
      tasks.push(observeConversation(tab.url));
    }
    return tasks;
  }));
}


extensionApi.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  void trackViewedThread(tab).catch(() => undefined);
  if (typeof changeInfo.url === "string" || typeof tab?.url === "string") {
    void trackThreadTab(tabId, changeInfo.url ?? tab.url);
  }
  if (typeof changeInfo.url === "string") restartPolling();
  const observedUrl = typeof changeInfo.url === "string" ? changeInfo.url : tab?.url;
  if (typeof observedUrl !== "string" ||
      (typeof changeInfo.url !== "string" && typeof changeInfo.title !== "string")) return;
  const observedTitle = typeof changeInfo.title === "string" ? changeInfo.title : undefined;
  void observeConversation(observedUrl).catch(() => undefined);
  void registerRalphConversation(observedUrl, { title: observedTitle }).catch(() => undefined);
});
extensionApi.tabs.onActivated?.addListener(({ tabId }) => {
  void extensionApi.tabs.get(tabId).then(trackViewedThread).catch(() => undefined);
});
extensionApi.tabs.onRemoved?.addListener((tabId, removeInfo) => {
  void threadTabRemoved(tabId, removeInfo).catch(() => undefined).finally(restartPolling);
});
extensionApi.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId === 0) {
    void trackThreadTab(details.tabId, details.url);
    void observeConversation(details.url).catch(() => undefined);
    void registerRalphConversation(details.url).catch(() => undefined);
  }
});
extensionApi.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) {
    void trackThreadTab(details.tabId, details.url);
    void observeConversation(details.url).catch(() => undefined);
    void registerRalphConversation(details.url).catch(() => undefined);
  }
});

extensionApi.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === SUPPORT_POLL_ALARM) restartPolling();
});
extensionApi.runtime.onInstalled.addListener(() => {
  void syncPollingAlarm();
  void scanExistingTabs();
  restartPolling();
});
extensionApi.runtime.onStartup.addListener(() => {
  void syncPollingAlarm();
  void scanExistingTabs();
  restartPolling();
});
void syncPollingAlarm();
void scanExistingTabs();
restartPolling();
