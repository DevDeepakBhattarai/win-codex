importScripts("config.js");

const extensionApi = globalThis.browser ?? globalThis.chrome;
if (!extensionApi?.runtime || !extensionApi?.tabs || !extensionApi?.scripting || !extensionApi?.storage) {
  throw new Error("Local Codex Support requires standard WebExtension runtime, tabs, scripting, and storage APIs.");
}

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
  ralph: false,
  threadMessaging: false,
});
const AUTOMATION_MESSAGE = "local-codex-support/automation-v1";
const REACTIVATE_RALPH_MESSAGE = "local-codex-support/ralph-reactivate-v1";
const TITLE_OBSERVED_MESSAGE = "local-codex-support/title-observed-v1";
const SYNC_MESSAGE = "local-codex-thread-sync/bind-v1";
const WORKER_KEEPALIVE_INTERVAL_MS = 20_000;
const AUTOMATION_RESPONSE_TIMEOUT_MS = 8 * 60_000;
let pollGeneration = 0;
let pollController = null;
const reportedRalphConversations = new Set();
const observingConversations = new Map();
const AUTOMATION_THREAD_TABS_KEY = "automationThreadTabsV1";
const RATE_LIMIT_WAIT_MS = 10 * 60_000;
const ERROR_RELOAD_INTERVAL_MS = 10 * 60_000;

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
    return match[1]
      ? `https://chatgpt.com/g/${canonicalProjectId(match[1])}/c/${match[2].toLowerCase()}`
      : `https://chatgpt.com/c/${match[2].toLowerCase()}`;
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
  })().finally(() => observingConversations.delete(currentUrl));
  observingConversations.set(currentUrl, observation);
  return observation;
}
async function registerRalphConversation(value, { reactivate = false, agentCreated = false, title } = {}) {
  const currentUrl = conversationUrl(value);
  const currentTitle = normalizeThreadTitle(title);
  if (!currentUrl || !currentUrl.startsWith("https://chatgpt.com/g/") ||
      (!reactivate && !agentCreated && !currentTitle && reportedRalphConversations.has(currentUrl))) return;
  const response = await fetch(ralphRegisterEndpoint.href, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
    body: JSON.stringify({
      conversationUrl: currentUrl,
      ...(reactivate ? { reactivate: true } : {}),
      ...(agentCreated ? { agentCreated: true } : {}),
      ...(currentTitle ? { title: currentTitle } : {}),
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
  }
  const tab = await extensionApi.tabs.create({ url: targetUrl, active: false });
  if (!Number.isInteger(tab.id)) throw new Error("ChatGPT automation tab did not receive an id.");
  return { tab, owned: true, created: true };
}

async function closeOwnedThreadTab(value) {
  const currentUrl = conversationUrl(value);
  if (!currentUrl) throw new Error("Thread cleanup requires a saved ChatGPT conversation URL.");
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
  if (!requestedUrl || requestedUrl !== currentUrl || !requestedUrl.startsWith("https://chatgpt.com/g/")) {
    return { ok: false, error: "RALPH no longer matches the current conversation." };
  }
  await registerRalphConversation(currentUrl, { reactivate: true });
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
  if (!requestedUrl || requestedUrl !== currentUrl || !requestedUrl.startsWith("https://chatgpt.com/g/") || !title) {
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
  // Establish the receiver before dispatching a side-effecting command. A lost response
  // does not prove that the page failed to send the message.
  await extensionApi.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
  return await extensionApi.tabs.sendMessage(tabId, { type: AUTOMATION_MESSAGE, command });
}

async function sendAutomationMessageWithTimeout(tabId, command) {
  let timeout;
  try {
    return await Promise.race([
      sendAutomationMessage(tabId, command),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for ChatGPT page automation.")),
          AUTOMATION_RESPONSE_TIMEOUT_MS);
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

function executeCommand(command, browserId) {
  return keepWorkerAliveUntil(executeCommandOnce(command, browserId));
}

async function executeCommandOnce(command, browserId) {
  let targetUrl;
  try {
    targetUrl = await commandTargetUrl(command);
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

  const createsNewThread = command.kind === "send_message" && projectHomeId(targetUrl) !== null;
  let tabId;
  let created = false;
  let keepCreatedTab = false;
  let automationStarted = false;
  let refreshed = false;

  try {
    const settings = await getSettings();
    const observing = !settings.automationExecutor;
    if (observing && command.kind !== "inspect_thread") {
      throw new Error("This browser is only available for thread observation.");
    }
    const acquired = observing
      ? await findConversationTab(targetUrl)
      : await acquireAutomationTab(targetUrl, createsNewThread);
    if (!acquired) throw new Error("The observed thread tab has closed or navigated away.");
    tabId = acquired.tab.id;
    created = acquired.created === true;
    let loadedTab;
    try {
      loadedTab = await waitForTabComplete(tabId);
    } catch {
      loadedTab = await reloadPageAfterFailure(tabId, targetUrl);
      refreshed = true;
    }
    if (typeof loadedTab.url !== "string" || !automationTargetMatches(loadedTab.url, targetUrl)) {
      throw new Error("ChatGPT automation was redirected away from the requested target.");
    }

    const existingConversation = conversationUrl(targetUrl);
    if (created && existingConversation) {
      await rememberOwnedThreadTab(existingConversation, tabId);
      keepCreatedTab = true;
    }

    if (command.kind !== "stop_thread") {
      try {
        refreshed = await recoverPage(tabId) || refreshed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (refreshed || /^CHATGPT_RATE_LIMITED(?:_RETRYABLE)?:/.test(message)) throw error;
        await reloadPageAfterFailure(tabId, targetUrl);
        refreshed = true;
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
      const response = await sendAutomationMessageWithTimeout(tabId, command);
      if (response?.ok) return response;
      const error = new Error(response?.error || "ChatGPT page automation failed.");
      error.retryable = response?.retryable === true;
      throw error;
    };
    automationStarted = true;
    let response;
    try {
      response = await runPageCommand();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (refreshed || /^CHATGPT_RATE_LIMITED(?:_RETRYABLE)?:/.test(message)) throw error;
      await reloadPageAfterFailure(tabId, targetUrl);
      refreshed = true;
      if (command.kind !== "inspect_thread" && !(command.kind === "send_message" && error?.retryable === true)) {
        throw error;
      }
      response = await runPageCommand();
    }

    if (command.kind === "send_message") {
      const savedUrl = conversationUrl(response.result?.conversationUrl);
      if (createsNewThread && savedUrl) {
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
    if (command.kind === "send_message" && !automationStarted && errorMessage.startsWith("CHATGPT_RATE_LIMITED:")) {
      errorMessage = errorMessage.replace("CHATGPT_RATE_LIMITED:", "CHATGPT_RATE_LIMITED_RETRYABLE:");
    }
    if (Number.isInteger(tabId) && /^CHATGPT_RATE_LIMITED(?:_RETRYABLE)?:/.test(errorMessage)) {
      const key = `pageRecovery:${tabId}`;
      const saved = await extensionApi.storage.local.get(key);
      if (!saved[key]?.rateLimitedAt) {
        await extensionApi.storage.local.set({ [key]: { ...saved[key], rateLimitedAt: Date.now() } });
      }
    }
    if (created && Number.isInteger(tabId) && createsNewThread) {
      try {
        const current = await extensionApi.tabs.get(tabId);
        const savedUrl = conversationUrl(current.url);
        if (savedUrl) {
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
    }).catch(() => undefined);
  } finally {
    if (created && Number.isInteger(tabId) && !keepCreatedTab) {
      await extensionApi.tabs.remove(tabId).catch(() => undefined);
    }
  }
}

const recoveringPages = new Map();
async function reloadPageAfterFailure(tabId, targetUrl) {
  const key = `pageRecovery:${tabId}`;
  const stored = await extensionApi.storage.local.get(key);
  const state = stored[key] ?? {};
  const now = Date.now();
  if (state.rateLimitedAt && now - state.rateLimitedAt < RATE_LIMIT_WAIT_MS) {
    throw new Error("CHATGPT_RATE_LIMITED: Waiting ten minutes before dismissing the provider notice.");
  }
  if (state.reloadedAt && now - state.reloadedAt < ERROR_RELOAD_INTERVAL_MS) {
    throw new Error("ChatGPT recovery is waiting before another reload.");
  }
  await extensionApi.storage.local.set({ [key]: { ...state, reloadedAt: now } });
  await extensionApi.tabs.reload(tabId);
  const tab = await waitForTabComplete(tabId);
  if (targetUrl && (typeof tab.url !== "string" || !automationTargetMatches(tab.url, targetUrl))) {
    throw new Error("ChatGPT automation was redirected away from the requested target after refresh.");
  }
  return tab;
}

function recoverPage(tabId) {
  const existing = recoveringPages.get(tabId);
  if (existing) return existing;
  const recovery = recoverPageOnce(tabId).finally(() => recoveringPages.delete(tabId));
  recoveringPages.set(tabId, recovery);
  return recovery;
}

async function recoverPageOnce(tabId) {
  const key = `pageRecovery:${tabId}`;
  const stored = await extensionApi.storage.local.get(key);
  const state = stored[key] ?? {};
  const now = Date.now();
  if (state.rateLimitedAt && now - state.rateLimitedAt < RATE_LIMIT_WAIT_MS) {
    throw new Error("CHATGPT_RATE_LIMITED: Waiting ten minutes before dismissing the provider notice.");
  }
  const health = await sendAutomationMessageWithTimeout(tabId, { kind: "page_health" });
  if (!health?.ok) throw new Error(health?.error || "Could not inspect ChatGPT page health.");
  if (health.result?.status === "rate_limited") {
    if (!state.rateLimitedAt) {
      await extensionApi.storage.local.set({ [key]: { ...state, rateLimitedAt: now } });
      throw new Error("CHATGPT_RATE_LIMITED: Waiting ten minutes before dismissing the provider notice.");
    }
    const dismissal = await sendAutomationMessageWithTimeout(tabId, { kind: "dismiss_rate_limit" });
    await extensionApi.storage.local.set({ [key]: { ...state, rateLimitedAt: now } });
    if (!dismissal?.ok || dismissal.result?.status !== "dismissed") {
      throw new Error("CHATGPT_RATE_LIMITED: The provider notice could not be dismissed.");
    }
    await sleep(250);
    const after = await sendAutomationMessageWithTimeout(tabId, { kind: "page_health" });
    if (!after?.ok || after.result?.status !== "ok") {
      throw new Error("CHATGPT_RATE_LIMITED: The provider notice is still blocking the page.");
    }
  } else if (health.result?.status === "recoverable_error") {
    await reloadPageAfterFailure(tabId);
    return true;
  }
  if (state.rateLimitedAt) await extensionApi.storage.local.set({ [key]: { reloadedAt: state.reloadedAt } });
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

async function pollCommands(generation) {
  const browserId = await getBrowserId();
  while (generation === pollGeneration) {
    const settings = await getSettings();
    const features = enabledAutomationFeatures(settings);
    const tabs = settings.threadSync ? await extensionApi.tabs.query({ url: "https://chatgpt.com/*" }) : [];
    const openThreads = [...new Set(tabs.map(tab => conversationUrl(tab.url)).filter(Boolean))];
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id) || !conversationUrl(tab.url)) continue;
      const key = `pageRecovery:${tab.id}`;
      const saved = await extensionApi.storage.local.get(key);
      if (saved[key]?.rateLimitedAt && Date.now() - saved[key].rateLimitedAt >= RATE_LIMIT_WAIT_MS) {
        await recoverPage(tab.id).catch(() => undefined);
      }
    }
    const idleObserver = features.length === 0 && openThreads.length === 0;

    const controller = new AbortController();
    pollController = controller;
    try {
      const response = await fetch(claimEndpoint.href, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
        body: JSON.stringify({ browserId, features, openThreads }),
        signal: controller.signal,
        redirect: "error",
      });
      if (generation !== pollGeneration) return;
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
    }
  }
}

function restartPolling() {
  pollGeneration += 1;
  pollController?.abort();
  const generation = pollGeneration;
  void pollCommands(generation);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    void scanExistingTabs();
    sendResponse({ ok: true });
  }
});

async function scanExistingTabs() {
  const tabs = await extensionApi.tabs.query({ url: "https://chatgpt.com/*" });
  await Promise.allSettled(tabs.flatMap((tab) => {
    const tasks = [];
    if (Number.isInteger(tab.id)) {
      tasks.push(extensionApi.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] }));
    }
    if (tab.active && typeof tab.url === "string") {
      tasks.push(observeConversation(tab.url));
      tasks.push(registerRalphConversation(tab.url, { title: tab.title }));
    }
    return tasks;
  }));
}


extensionApi.tabs.onUpdated?.addListener((_tabId, changeInfo, tab) => {
  if (typeof changeInfo.url === "string") restartPolling();
  const observedUrl = typeof changeInfo.url === "string" ? changeInfo.url : tab?.url;
  if (typeof observedUrl !== "string" ||
      (typeof changeInfo.url !== "string" && typeof changeInfo.title !== "string")) return;
  const observedTitle = typeof changeInfo.title === "string" ? changeInfo.title : undefined;
  void observeConversation(observedUrl).catch(() => undefined);
  void registerRalphConversation(observedUrl, { title: observedTitle }).catch(() => undefined);
});
extensionApi.tabs.onRemoved?.addListener(tabId => {
  void extensionApi.storage.local.remove?.([`pageRecovery:${tabId}`]);
  restartPolling();
});
extensionApi.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId === 0) {
    void observeConversation(details.url).catch(() => undefined);
    void registerRalphConversation(details.url).catch(() => undefined);
  }
});
extensionApi.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) {
    void observeConversation(details.url).catch(() => undefined);
    void registerRalphConversation(details.url).catch(() => undefined);
  }
});

extensionApi.runtime.onInstalled.addListener(() => {
  void scanExistingTabs();
  restartPolling();
});
extensionApi.runtime.onStartup.addListener(() => {
  void scanExistingTabs();
  restartPolling();
});
void scanExistingTabs();
restartPolling();
