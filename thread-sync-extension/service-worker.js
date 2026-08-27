importScripts("config.js");

const extensionApi = globalThis.browser ?? globalThis.chrome;
if (!extensionApi?.runtime || !extensionApi?.tabs || !extensionApi?.scripting) {
  throw new Error("Thread Sync requires standard WebExtension runtime, tabs, and scripting APIs.");
}

const config = globalThis.LOCAL_CODEX_THREAD_SYNC;
const endpoint = new URL(config.bindUrl);
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/thread-sync/bind" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error("Thread Sync must connect only to the configured loopback binding endpoint.");
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

async function bind(message, sender) {
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
    const response = await fetch(endpoint.href, {
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
    return { status: "error", error: `Could not reach ${endpoint.origin}.`, retryable: true };
  }
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "local-codex-thread-sync/bind-v1") return;
  void bind(message, sender).then(sendResponse, () =>
    sendResponse({ status: "error", error: "The source tab is no longer available.", retryable: true }),
  );
  return true;
});

async function injectIntoExistingTabs() {
  const tabs = await extensionApi.tabs.query({ url: "https://chatgpt.com/*" });
  await Promise.allSettled(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) =>
    extensionApi.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] }),
  ));
}

extensionApi.runtime.onInstalled.addListener(() => void injectIntoExistingTabs());
extensionApi.runtime.onStartup.addListener(() => void injectIntoExistingTabs());
void injectIntoExistingTabs();
