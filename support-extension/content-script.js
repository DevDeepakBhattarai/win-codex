(() => {
  const handlerKey = "__localCodexSupportInstalledV1";
  if (globalThis[handlerKey]) return;
  globalThis[handlerKey] = true;

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi?.runtime?.sendMessage || !extensionApi?.runtime?.onMessage) return;

  const requestType = "local-codex-thread-sync/bind-v1";
  const responseType = "local-codex-thread-sync/result-v1";
  const automationType = "local-codex-support/automation-v1";
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

  window.addEventListener("message", messageHandler);

  extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== automationType || !message.command) return;
    void runAutomation(message.command).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });

  async function runAutomation(command) {
    if (command.kind === "inspect_thread") return await inspectThread();
    if (command.kind === "send_message") return await sendMessage(command.message);
    throw new Error("Unsupported ChatGPT support command.");
  }

  async function inspectThread() {
    const ready = await waitForConversationReady(5 * 60_000);
    if (!ready) return { status: "loading" };

    const stopButton = ready.composer.querySelector('button[data-testid="stop-button"]');
    if (stopButton) return { status: "running" };

    await waitForStableTurns();
    if (isRunning()) return { status: "running" };
    const workedSeconds = getWorkedDurationSeconds();
    const turns = [...document.querySelectorAll("section[data-turn]")];
    const users = [];
    let lastUserIndex = -1;

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (turn.dataset.turn !== "user") continue;
      lastUserIndex = index;
      const message = turn.querySelector('[data-message-author-role="user"]');
      if (!message) continue;
      const content = message.querySelector('[data-testid="collapsible-user-message-content"]') ?? message;
      users.push({
        id: message.getAttribute("data-message-id") ?? turn.dataset.turnId ?? "",
        text: extractText(content),
      });
    }

    if (lastUserIndex < 0) return { status: "loading" };

    let assistantTurn = null;
    for (let index = lastUserIndex + 1; index < turns.length; index += 1) {
      if (turns[index].dataset.turn === "assistant") assistantTurn = turns[index];
    }

    if (!assistantTurn) {
      if (isRunning()) return { status: "running" };
      return {
        status: "idle",
        workedSeconds,
        users,
        assistant: {
          synthetic: true,
          text: "[Thread stopped before an assistant response was produced.]",
        },
      };
    }

    const assistantMessages = [...assistantTurn.querySelectorAll('[data-message-author-role="assistant"]')];
    const finalMessage = assistantMessages.at(-1) ?? null;
    if (!finalMessage) {
      if (isRunning()) return { status: "running" };
      return {
        status: "idle",
        workedSeconds,
        users,
        assistant: {
          synthetic: true,
          text: "[Thread stopped before a final assistant response was produced.]",
        },
      };
    }

    if (isRunning()) return { status: "running" };
    return {
      status: "idle",
      workedSeconds,
      users,
      assistant: {
        synthetic: false,
        id: finalMessage.getAttribute("data-message-id"),
        text: extractText(finalMessage),
      },
    };
  }

  async function sendMessage(message) {
    if (typeof message !== "string" || !message.trim()) throw new Error("A non-empty ChatGPT message is required.");
    const ready = await waitForComposer(5 * 60_000);
    if (!ready) throw new Error("ChatGPT composer did not finish loading.");

    const previousUserCount = document.querySelectorAll('section[data-turn="user"]').length;
    insertMessage(ready.editor, message);

    const sendButton = await waitFor(() => {
      const button = document.querySelector("#composer-submit-button") ?? document.querySelector('button[aria-label="Send prompt"]');
      return button && !button.disabled ? button : null;
    }, 60_000);
    if (!sendButton) throw new Error("ChatGPT send button did not become available.");

    sendButton.click();
    const submitted = await waitFor(() => {
      const currentUserCount = document.querySelectorAll('section[data-turn="user"]').length;
      return currentUserCount > previousUserCount || document.querySelector('button[data-testid="stop-button"]') ? true : null;
    }, 60_000);
    if (!submitted) throw new Error("ChatGPT did not acknowledge the submitted message.");

    const savedUrl = await waitFor(() => conversationUrl(), 2 * 60_000);
    if (!savedUrl) throw new Error("ChatGPT did not expose the saved conversation URL after sending.");
    return { status: "sent", conversationUrl: savedUrl };
  }

  function insertMessage(editor, message) {
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, message);
    if (!inserted) throw new Error("Could not insert the ChatGPT message.");
  }

  async function waitForComposer(timeoutMs) {
    return await waitFor(() => {
      const composer = document.querySelector('form[data-type="unified-composer"]');
      const editor = composer?.querySelector('#prompt-textarea[contenteditable="true"]') ??
        composer?.querySelector('textarea[name="prompt-textarea"]');
      return composer && editor ? { composer, editor } : null;
    }, timeoutMs);
  }

  async function waitForConversationReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await waitForComposer(Math.min(1_000, deadline - Date.now()));
      if (!ready) continue;
      if (ready.composer.querySelector('button[data-testid="stop-button"]')) return ready;
      if (document.querySelector('section[data-turn="user"]')) return ready;
      await sleep(100);
    }
    return null;
  }

  async function waitForStableTurns() {
    let previousSignature = "";
    let stableSince = Date.now();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (document.querySelector('button[data-testid="stop-button"]')) return;
      const turns = [...document.querySelectorAll("section[data-turn]")];
      const lastUserIndex = turns.findLastIndex((turn) => turn.dataset.turn === "user");
      const hasAssistantAfterLastUser = turns.slice(lastUserIndex + 1).some((turn) => turn.dataset.turn === "assistant");
      const stableForMs = hasAssistantAfterLastUser ? 2_000 : 10_000;
      const signature = turns.map((turn) => [
        turn.dataset.turn,
        turn.dataset.turnId ?? "",
        turn.textContent ?? "",
      ].join(":")).join("|");
      if (signature !== previousSignature) {
        previousSignature = signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableForMs) {
        return;
      }
      await sleep(100);
    }
  }

  function isRunning() {
    return Boolean(document.querySelector('form[data-type="unified-composer"] button[data-testid="stop-button"]'));
  }

  function getWorkedDurationSeconds() {
    const assistantTurns = [...document.querySelectorAll('section[data-turn="assistant"]')];
    const lastAssistantTurn = assistantTurns.at(-1);
    if (!lastAssistantTurn) return null;

    const durationButton = [...lastAssistantTurn.querySelectorAll("button")].find((button) =>
      /^Worked for\s+/i.test(button.textContent?.trim() ?? ""));
    if (!durationButton) return null;

    const match = durationButton.textContent.trim().match(
      /^Worked for\s+(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/i,
    );
    if (!match || (!match[1] && !match[2] && !match[3])) return null;

    return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }

  function extractText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll("button, script, style, svg, [role='tooltip']").forEach((node) => node.remove());
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;visibility:hidden;pointer-events:none;";
    container.appendChild(clone);
    document.body.appendChild(container);
    const text = container.innerText.replace(/\u00a0/g, " ").trim();
    container.remove();
    return text;
  }

  async function waitFor(getElement, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = getElement();
      if (value) return value;
      await sleep(50);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
