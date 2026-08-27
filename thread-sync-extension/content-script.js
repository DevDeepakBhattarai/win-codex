(() => {
  const handlerKey = "__localCodexThreadSyncMessageHandlerV2";
  const previousHandler = globalThis[handlerKey];
  if (typeof previousHandler === "function") {
    window.removeEventListener("message", previousHandler);
  }

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi?.runtime?.sendMessage) return;

  const requestType = "local-codex-thread-sync/bind-v1";
  const responseType = "local-codex-thread-sync/result-v1";
  const sourceRoutes = new WeakMap();
  const pending = new Set();
  let route = location.pathname;
  let generation = 0;

  function conversationUrl() {
    const match = location.pathname.match(/^(?:\/g\/([A-Za-z0-9_-]+))?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
    if (!match) return null;
    return match[1]
      ? `https://chatgpt.com/g/${match[1]}/c/${match[2].toLowerCase()}`
      : `https://chatgpt.com/c/${match[2].toLowerCase()}`;
  }

  function currentRoute() {
    if (route !== location.pathname) {
      route = location.pathname;
      generation += 1;
    }
    return { generation, url: conversationUrl() };
  }

  const messageHandler = async (event) => {
    const message = event.data;
    if (message?.type !== requestType || typeof message.token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(message.token) || event.source === window || !event.source) return;

    const current = currentRoute();
    if (!current.url) return;

    const remembered = sourceRoutes.get(event.source);
    if (remembered && (remembered.generation !== current.generation || remembered.url !== current.url)) {
      event.source.postMessage({
        type: responseType,
        token: message.token,
        status: "error",
        error: "The sync component no longer belongs to this conversation.",
        retryable: false,
      }, event.origin === "null" ? "*" : event.origin);
      return;
    }
    if (!remembered) sourceRoutes.set(event.source, current);
    if (pending.has(message.token)) return;

    const reply = (result) => event.source.postMessage({ type: responseType, token: message.token, ...result },
      event.origin === "null" ? "*" : event.origin);
    pending.add(message.token);
    try {
      const result = await extensionApi.runtime.sendMessage({
        type: requestType,
        token: message.token,
        conversationUrl: current.url,
      });
      const latest = currentRoute();
      const sourceRoute = sourceRoutes.get(event.source);
      if (latest.url === current.url && sourceRoute?.generation === current.generation) reply(result);
    } catch {
      reply({ status: "error", error: "Thread Sync is reconnecting.", retryable: true });
    } finally {
      pending.delete(message.token);
    }
  };

  globalThis[handlerKey] = messageHandler;
  window.addEventListener("message", messageHandler);
})();
