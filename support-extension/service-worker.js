importScripts("config.js");

const extensionApi = globalThis.browser ?? globalThis.chrome;
if (!extensionApi?.runtime || !extensionApi?.tabs || !extensionApi?.scripting || !extensionApi?.storage) {
  throw new Error("Local Codex Support requires standard WebExtension runtime, tabs, scripting, and storage APIs.");
}

const config = globalThis.LOCAL_CODEX_THREAD_SYNC;
const bindEndpoint = validateLoopbackEndpoint(config?.bindUrl, "/thread-sync/bind");
const claimEndpoint = validateLoopbackEndpoint(config?.commandClaimUrl, "/chatgpt-support/commands/claim");
const resultEndpoint = validateLoopbackEndpoint(config?.commandResultUrl, "/chatgpt-support/commands/result");
const ralfRegisterEndpoint = validateLoopbackEndpoint(config?.ralfRegisterUrl, "/chatgpt-support/ralf/register");
if (typeof config?.extensionToken !== "string" || config.extensionToken.length < 32) {
  throw new Error("Local Codex Support extension token is missing or invalid.");
}

const DEFAULT_SETTINGS = Object.freeze({
  threadSync: true,
  ralf: false,
  threadMessaging: false,
  subagentProjectUrl: "",
});
const AUTOMATION_MESSAGE = "local-codex-support/automation-v1";
const SYNC_MESSAGE = "local-codex-thread-sync/bind-v1";
let pollGeneration = 0;
let pollController = null;
const reportedRalfConversations = new Set();

function validateLoopbackEndpoint(value, pathname) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== pathname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`Local Codex Support endpoint must be ${pathname} on configured IPv4 loopback.`);
  }
  return endpoint;
}

function conversationUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^(?:\/g\/([A-Za-z0-9_-]+))?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password || !match) return null;
    return match[1]
      ? `https://chatgpt.com/g/${match[1]}/c/${match[2].toLowerCase()}`
      : `https://chatgpt.com/c/${match[2].toLowerCase()}`;
  } catch {
    return null;
  }
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

function normalizedProjectHomeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.origin !== "https://chatgpt.com" || url.username || url.password || !projectHomeId(url.href)) return null;
    return `https://chatgpt.com${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function automationTargetMatches(currentValue, targetValue) {
  try {
    const targetConversation = conversationUrl(targetValue);
    if (targetConversation) return conversationUrl(currentValue) === targetConversation;

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
    ralf: stored.ralf === true,
    threadMessaging: stored.threadMessaging === true,
    subagentProjectUrl: typeof stored.subagentProjectUrl === "string" ? stored.subagentProjectUrl : "",
  };
}

async function registerRalfConversation(value) {
  const currentUrl = conversationUrl(value);
  if (!currentUrl || !currentUrl.startsWith("https://chatgpt.com/g/") || reportedRalfConversations.has(currentUrl)) return;
  const response = await fetch(ralfRegisterEndpoint.href, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
    body: JSON.stringify({ conversationUrl: currentUrl }),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) return;
  const data = await response.json();
  if (data.status === "registered" || data.status === "ignored") reportedRalfConversations.add(currentUrl);
}

async function getBrowserId() {
  const stored = await extensionApi.storage.local.get("browserId");
  if (typeof stored.browserId === "string" && stored.browserId) return stored.browserId;
  const browserId = crypto.randomUUID();
  await extensionApi.storage.local.set({ browserId });
  return browserId;
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
  try {
    return await extensionApi.tabs.sendMessage(tabId, { type: AUTOMATION_MESSAGE, command });
  } catch {
    await extensionApi.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    return await extensionApi.tabs.sendMessage(tabId, { type: AUTOMATION_MESSAGE, command });
  }
}

async function commandTargetUrl(command) {
  if (command.kind === "inspect_thread") return command.conversationUrl;
  if (typeof command.targetUrl === "string" && command.targetUrl) return command.targetUrl;
  if (command.feature !== "threadMessaging") throw new Error("ChatGPT support command is missing its target URL.");

  const settings = await getSettings();
  const projectUrl = normalizedProjectHomeUrl(settings.subagentProjectUrl);
  if (!projectUrl) {
    throw new Error("Set a Sub-agent project URL in the Local Codex Support extension popup before starting a new agent thread.");
  }
  return projectUrl;
}

async function executeCommand(command, browserId) {
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

  const tab = await extensionApi.tabs.create({ url: targetUrl, active: false });
  if (!Number.isInteger(tab.id)) throw new Error("ChatGPT automation tab did not receive an id.");

  try {
    const loadedTab = await waitForTabComplete(tab.id);
    if (typeof loadedTab.url !== "string" || !automationTargetMatches(loadedTab.url, targetUrl)) {
      throw new Error("ChatGPT automation was redirected away from the requested target.");
    }
    const response = await sendAutomationMessage(tab.id, command);
    if (!response?.ok) throw new Error(response?.error || "ChatGPT page automation failed.");
    if (command.kind === "send_message") {
      await registerRalfConversation(response.result?.conversationUrl).catch(() => undefined);
    }
    await postResult({
      commandId: command.id,
      browserId,
      kind: command.kind,
      ok: true,
      result: response.result,
    });
  } catch (error) {
    await postResult({
      commandId: command.id,
      browserId,
      kind: command.kind,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  } finally {
    await extensionApi.tabs.remove(tab.id).catch(() => undefined);
  }
}

function enabledAutomationFeatures(settings) {
  const features = [];
  if (settings.ralf) features.push("ralf");
  if (settings.threadMessaging) features.push("threadMessaging");
  return features;
}

async function pollCommands(generation) {
  const browserId = await getBrowserId();
  while (generation === pollGeneration) {
    const settings = await getSettings();
    const features = enabledAutomationFeatures(settings);
    if (features.length === 0) return;

    const controller = new AbortController();
    pollController = controller;
    try {
      const response = await fetch(claimEndpoint.href, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.extensionToken}` },
        body: JSON.stringify({ browserId, features }),
        signal: controller.signal,
        redirect: "error",
      });
      if (generation !== pollGeneration) return;
      if (response.status === 204) continue;
      if (!response.ok) {
        await sleep(1000);
        continue;
      }
      const command = await response.json();
      if (command?.id) await executeCommand(command, browserId);
    } catch (error) {
      if (controller.signal.aborted || generation !== pollGeneration) return;
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
  if (message?.type === "local-codex-support/settings-changed") {
    reportedRalfConversations.clear();
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
    if (typeof tab.url === "string") tasks.push(registerRalfConversation(tab.url));
    return tasks;
  }));
}

extensionApi.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
  if (typeof changeInfo.url === "string") void registerRalfConversation(changeInfo.url).catch(() => undefined);
});
extensionApi.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId === 0) void registerRalfConversation(details.url).catch(() => undefined);
});
extensionApi.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) void registerRalfConversation(details.url).catch(() => undefined);
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
