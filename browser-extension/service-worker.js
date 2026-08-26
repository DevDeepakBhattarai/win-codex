importScripts("config.js");

const config = globalThis.LOCAL_CODEX_BROWSER_CONFIG;
if (!config || typeof config.bridgeUrl !== "string" || typeof config.token !== "string") {
  throw new Error("Local Codex browser bridge config is missing or invalid.");
}

const PROTOCOL_VERSION = 1;
const KEEPALIVE_MS = 20_000;
const MAX_RECONNECT_MS = 10_000;
const RECONNECT_ALARM = "browser-bridge-reconnect";
const OFFSCREEN_DOCUMENT = "offscreen.html";
const OVERLAY_MESSAGE_TARGET = "local-codex-control-overlay";

let socket = null;
let keepaliveTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
const attachedTabs = new Set();
const controlledTabs = new Set();

function bridgeUrl() {
  const url = new URL(config.bridgeUrl);
  url.searchParams.set("token", config.token);
  return url.toString();
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function setBadge(connected) {
  void chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  if (connected) {
    void chrome.action.setBadgeBackgroundColor({ color: "#188038" });
  }
}

function startKeepalive() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => {
    send({ type: "keepalive", at: Date.now() });
  }, KEEPALIVE_MS);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(MAX_RECONNECT_MS, 250 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  void chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const next = new WebSocket(bridgeUrl());
  socket = next;

  next.onopen = () => {
    reconnectAttempt = 0;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    void chrome.alarms.clear(RECONNECT_ALARM);
    setBadge(true);
    startKeepalive();
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      extensionId: chrome.runtime.id,
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
    });
  };

  next.onmessage = (event) => {
    void handleMessage(event.data);
  };

  next.onerror = () => {
    next.close();
  };

  next.onclose = () => {
    if (socket === next) socket = null;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    setBadge(false);
    scheduleReconnect();
  };
}

async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }

  if (message?.type !== "request" || typeof message.id !== "string" || typeof message.method !== "string") {
    return;
  }

  try {
    const result = await dispatchRequest(message.method, message.params ?? {});
    send({ type: "response", id: message.id, ok: true, result });
  } catch (error) {
    send({
      type: "response",
      id: message.id,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function tabSummary(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    highlighted: tab.highlighted,
    openerTabId: tab.openerTabId,
    groupId: tab.groupId,
    lastAccessed: tab.lastAccessed,
    discarded: tab.discarded,
    autoDiscardable: tab.autoDiscardable,
    status: tab.status,
    title: tab.title,
    url: tab.url,
  };
}

function downloadSummary(download) {
  return {
    id: download.id,
    tabId: download.tabId,
    url: download.url,
    finalUrl: download.finalUrl,
    filename: download.filename,
    mime: download.mime,
    state: download.state,
    paused: download.paused,
    canResume: download.canResume,
    bytesReceived: download.bytesReceived,
    totalBytes: download.totalBytes,
    fileSize: download.fileSize,
    error: download.error,
    exists: download.exists,
    startTime: download.startTime,
    endTime: download.endTime,
  };
}

function requireTabId(params) {
  if (!Number.isInteger(params.tabId) || params.tabId < 0) {
    throw new Error("A valid tabId is required.");
  }
  return params.tabId;
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
}

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT,
    reasons: ["CLIPBOARD"],
    justification: "Read and write the browser clipboard for an explicit MCP browser tool call.",
  });
}

async function callOffscreen(method, params) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", method, params });
  if (!response?.ok) throw new Error(response?.error ?? "Offscreen clipboard request failed.");
  return response.result;
}

async function sendOverlayCommand(tabId, command, params = {}) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      target: OVERLAY_MESSAGE_TARGET,
      command,
      ...params,
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function dispatchRequest(method, params) {
  switch (method) {
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((tab) => Number.isInteger(tab.id)).map(tabSummary);
    }
    case "tabs.get": {
      const tab = await chrome.tabs.get(requireTabId(params));
      return tabSummary(tab);
    }
    case "tabs.active": {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs.find((candidate) => Number.isInteger(candidate.id));
      return tab ? tabSummary(tab) : null;
    }
    case "tabs.open": {
      const createProperties = {
        ...(typeof params.url === "string" && params.url ? { url: params.url } : {}),
        focused: params.active !== false,
      };
      const tab = params.newWindow === true
        ? (await chrome.windows.create(createProperties)).tabs?.[0]
        : await chrome.tabs.create({
            ...(typeof params.url === "string" && params.url ? { url: params.url } : {}),
            active: params.active !== false,
          });
      if (!tab) throw new Error("Chrome did not return the created tab.");
      return tabSummary(tab);
    }
    case "tabs.activate": {
      const tabId = requireTabId(params);
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (Number.isInteger(tab.windowId)) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return tabSummary(tab);
    }
    case "tabs.navigate": {
      const tabId = requireTabId(params);
      if (typeof params.url !== "string" || !params.url) throw new Error("A URL is required.");
      const tab = await chrome.tabs.update(tabId, { url: params.url });
      return tabSummary(tab);
    }
    case "tabs.back": {
      const tabId = requireTabId(params);
      await chrome.tabs.goBack(tabId);
      return tabSummary(await chrome.tabs.get(tabId));
    }
    case "tabs.forward": {
      const tabId = requireTabId(params);
      await chrome.tabs.goForward(tabId);
      return tabSummary(await chrome.tabs.get(tabId));
    }
    case "tabs.reload": {
      const tabId = requireTabId(params);
      await chrome.tabs.reload(tabId, { bypassCache: params.bypassCache === true });
      return tabSummary(await chrome.tabs.get(tabId));
    }
    case "tabs.close": {
      const tabId = requireTabId(params);
      if (attachedTabs.has(tabId)) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch {
          // The tab may already be gone.
        }
        attachedTabs.delete(tabId);
      }
      await chrome.tabs.remove(tabId);
      return {};
    }
    case "debugger.attach": {
      const tabId = requireTabId(params);
      await ensureAttached(tabId);
      return {};
    }
    case "debugger.detach": {
      const tabId = requireTabId(params);
      if (attachedTabs.has(tabId)) {
        await chrome.debugger.detach({ tabId });
        attachedTabs.delete(tabId);
      }
      return {};
    }
    case "debugger.command": {
      const tabId = requireTabId(params);
      if (typeof params.method !== "string" || !params.method) {
        throw new Error("A CDP method is required.");
      }
      await ensureAttached(tabId);
      const debuggee = typeof params.sessionId === "string"
        ? { tabId, sessionId: params.sessionId }
        : { tabId };
      return await chrome.debugger.sendCommand(debuggee, params.method, params.commandParams ?? {});
    }
    case "overlay.show": {
      const tabId = requireTabId(params);
      controlledTabs.add(tabId);
      return { delivered: await sendOverlayCommand(tabId, "show") };
    }
    case "overlay.hide": {
      const tabId = requireTabId(params);
      controlledTabs.delete(tabId);
      return { delivered: await sendOverlayCommand(tabId, "hide") };
    }
    case "overlay.move": {
      const tabId = requireTabId(params);
      return {
        delivered: await sendOverlayCommand(tabId, "move", { x: params.x, y: params.y }),
      };
    }
    case "overlay.click": {
      const tabId = requireTabId(params);
      return { delivered: await sendOverlayCommand(tabId, "click") };
    }
    case "downloads.list": {
      const query = {};
      if (Number.isInteger(params.id)) query.id = params.id;
      if (typeof params.state === "string") query.state = params.state;
      const downloads = await chrome.downloads.search(query);
      return downloads.map(downloadSummary);
    }
    case "downloads.cancel": {
      if (!Number.isInteger(params.id)) throw new Error("A valid download id is required.");
      await chrome.downloads.cancel(params.id);
      const downloads = await chrome.downloads.search({ id: params.id });
      return downloads[0] ? downloadSummary(downloads[0]) : null;
    }
    case "clipboard.readText":
    case "clipboard.writeText":
      return await callOffscreen(method, params);
    default:
      throw new Error(`Unsupported browser bridge method: ${method}`);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!Number.isInteger(source.tabId)) return;
  send({
    type: "event",
    event: "debugger",
    tabId: source.tabId,
    sessionId: source.sessionId,
    method,
    params,
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  send({
    type: "event",
    event: "tabCreated",
    tabId: tab.id,
    tab: tabSummary(tab),
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!Number.isInteger(source.tabId)) return;
  attachedTabs.delete(source.tabId);
  controlledTabs.delete(source.tabId);
  void sendOverlayCommand(source.tabId, "hide");
  send({
    type: "event",
    event: "debuggerDetached",
    tabId: source.tabId,
    sessionId: source.sessionId,
    reason,
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (controlledTabs.has(tabId) && changeInfo.status === "complete") {
    void sendOverlayCommand(tabId, "show");
  }
  send({
    type: "event",
    event: "tabUpdated",
    tabId,
    changeInfo,
    tab: tabSummary(tab),
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  attachedTabs.delete(tabId);
  controlledTabs.delete(tabId);
  send({
    type: "event",
    event: "tabRemoved",
    tabId,
    removeInfo,
  });
});

chrome.downloads.onCreated.addListener((download) => {
  send({ type: "event", event: "downloadCreated", download: downloadSummary(download) });
});

chrome.downloads.onChanged.addListener(async (delta) => {
  const downloads = await chrome.downloads.search({ id: delta.id });
  send({
    type: "event",
    event: "downloadChanged",
    download: downloads[0] ? downloadSummary(downloads[0]) : { id: delta.id },
  });
});

chrome.downloads.onErased.addListener((downloadId) => {
  send({ type: "event", event: "downloadErased", downloadId });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
