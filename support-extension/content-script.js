(() => {
  const handlerKey = "__localCodexSupportInstalled";
  const contentScriptVersion = "1.4.3";
  if (globalThis[handlerKey]?.version === contentScriptVersion) return;
  globalThis[handlerKey] = { version: contentScriptVersion };

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi?.runtime?.sendMessage || !extensionApi?.runtime?.onMessage) return;

  const requestType = "local-codex-thread-sync/bind-v1";
  const responseType = "local-codex-thread-sync/result-v1";
  const automationType = "local-codex-support/automation-v1";
  const reactivateRalphType = "local-codex-support/ralph-reactivate-v1";
  const titleObservedType = "local-codex-support/title-observed-v1";
  const sourceRoutes = new WeakMap();
  const pending = new Set();
  let route = location.pathname;
  let generation = 0;

  const SEND_SETTLE_MS = 5_000;
  const SEND_READY_TIMEOUT_MS = 5 * 60_000;
  const SEND_NAVIGATION_TIMEOUT_MS = 60_000;
  const THREAD_ASSISTANT_SETTLE_MS = 5_000;
  const THREAD_UNCERTAIN_SETTLE_MS = 2 * 60_000;
  const THREAD_SETTLE_TIMEOUT_MS = 2.5 * 60_000;
  const RALPH_MIN_WORKED_SECONDS_KEY = "ralphMinWorkedSeconds";
  const LEGACY_RALPH_MIN_WORKED_SECONDS = 19 * 60;
  const DEFAULT_RALPH_MIN_WORKED_SECONDS = 20 * 60;

  function conversationUrl() {
    const match = location.pathname.match(/^(?:\/g\/([A-Za-z0-9_-]+))?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
    if (!match) return null;
    return match[1]
      ? `https://chatgpt.com/g/${match[1]}/c/${match[2].toLowerCase()}`
      : `https://chatgpt.com/c/${match[2].toLowerCase()}`;
  }

  function threadTitle() {
    const value = document.title?.trim();
    if (!value) return undefined;
    const title = value.replace(/\s+-\s+ChatGPT$/i, "").trim();
    if (!title || /^ChatGPT(?:\s+[\u002d\u2013\u2014]\s+.+)?$/i.test(title)) return undefined;
    const parts = title.split(/\s+[\u002d\u2013\u2014]\s+/).map((part) => part.trim());
    if (parts.some((part) => /^New chat$/i.test(part))) return undefined;
    return title.slice(0, 200);
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

  installTitleObserver();
  installRalphComposerObserver();

  extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== automationType || !message.command) return;
    void runAutomation(message.command).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });

  async function runAutomation(command) {
    if (command.kind === "stop_thread") return await stopThread();
    assertNotRateLimited();
    if (command.kind === "inspect_thread") return await inspectThread();
    if (command.kind === "send_message") return await sendMessage(command.message);
    throw new Error("Unsupported ChatGPT support command.");
  }

  async function stopThread() {
    const ready = await waitForCancellationState(30_000);
    if (!ready) throw new Error("ChatGPT child state did not become ready for cancellation.");

    const currentUrl = conversationUrl();
    if (!currentUrl) throw new Error("ChatGPT cancellation is not on a saved conversation.");
    if (!ready.stopButton) return { status: "idle", conversationUrl: currentUrl };

    ready.stopButton.click();
    const stopped = await waitForStableStop(30_000);
    if (!stopped) throw new Error("ChatGPT did not confirm that the child run stopped.");
    return { status: "stopped", conversationUrl: conversationUrl() ?? currentUrl };
  }

  async function waitForCancellationState(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let idleSince = 0;
    while (Date.now() < deadline) {
      const ready = getComposer();
      const hasUserTurn = Boolean(document.querySelector('section[data-turn="user"]'));
      if (!ready || document.readyState === "loading" || !hasUserTurn) {
        idleSince = 0;
        await sleep(100);
        continue;
      }
      const stopButton = ready.composer.querySelector('button[data-testid="stop-button"]');
      if (stopButton) return { ...ready, stopButton };
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince >= 1_500) return { ...ready, stopButton: null };
      await sleep(100);
    }
    return null;
  }

  async function waitForStableStop(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let stoppedSince = 0;
    while (Date.now() < deadline) {
      const ready = getComposer();
      const stopButton = ready?.composer.querySelector('button[data-testid="stop-button"]');
      if (!ready || stopButton) {
        stoppedSince = 0;
      } else {
        if (!stoppedSince) stoppedSince = Date.now();
        if (Date.now() - stoppedSince >= 500) return true;
      }
      await sleep(100);
    }
    return false;
  }

  async function inspectThread() {
    const title = threadTitle();
    const ready = await waitForConversationReady(5 * 60_000);
    if (!ready) return { status: "loading", ...(title ? { title } : {}) };

    const stopButton = ready.composer.querySelector('button[data-testid="stop-button"]');
    if (stopButton) return { status: "running", ...(title ? { title } : {}) };

    const settled = await waitForStableTurns();
    if (!settled) return { status: "loading", ...(title ? { title } : {}) };
    if (isRunning()) return { status: "running", ...(title ? { title } : {}) };
    const workedSeconds = getWorkedDurationSeconds(await getRalphMinWorkedSeconds());
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
      const text = extractText(content);
      if (!text) throw new Error("Could not extract the text of a ChatGPT user message.");
      users.push({
        id: message.getAttribute("data-message-id") ?? turn.dataset.turnId ?? "",
        text,
      });
    }

    if (lastUserIndex < 0) return { status: "loading", ...(title ? { title } : {}) };

    let assistantTurn = null;
    for (let index = lastUserIndex + 1; index < turns.length; index += 1) {
      if (turns[index].dataset.turn === "assistant") assistantTurn = turns[index];
    }

    if (!assistantTurn) {
      if (isRunning()) return { status: "running", ...(title ? { title } : {}) };
      return {
        status: "idle",
        ...(title ? { title } : {}),
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
      if (isRunning()) return { status: "running", ...(title ? { title } : {}) };
      return {
        status: "idle",
        ...(title ? { title } : {}),
        workedSeconds,
        users,
        assistant: {
          synthetic: true,
          text: "[Thread stopped before a final assistant response was produced.]",
        },
      };
    }

    if (isRunning()) return { status: "running", ...(title ? { title } : {}) };
    const text = extractText(finalMessage);
    if (!text) throw new Error("Could not extract the text of the final ChatGPT assistant message.");
    return {
      status: "idle",
      ...(title ? { title } : {}),
      workedSeconds,
      users,
      assistant: {
        synthetic: false,
        id: finalMessage.getAttribute("data-message-id"),
        text,
      },
    };
  }

  async function sendMessage(message) {
    if (typeof message !== "string" || !message.trim()) throw new Error("A non-empty ChatGPT message is required.");

    const existingConversationUrl = conversationUrl();
    if (existingConversationUrl) {
      const loadedUserTurn = await waitFor(
        () => document.querySelector('section[data-turn="user"] [data-message-author-role="user"]'),
        SEND_READY_TIMEOUT_MS,
      );
      if (!loadedUserTurn) throw new Error("The existing ChatGPT thread did not load a user message.");
    }

    await sleep(SEND_SETTLE_MS);

    const ready = await waitForComposer(SEND_READY_TIMEOUT_MS);
    if (!ready) throw new Error("ChatGPT composer did not become available.");
    assertNotRateLimited();
    insertMessage(ready.editor, message);

    await sleep(SEND_SETTLE_MS);

    const current = await waitFor(() => {
      assertNotRateLimited();
      const composer = getComposer();
      if (!composer) return null;
      const button = getSendButton(composer.composer);
      return isActionableButton(button) ? { ...composer, button } : null;
    }, SEND_READY_TIMEOUT_MS);
    if (!current) throw new Error("ChatGPT send button did not become actionable.");

    current.button.click();
    await sleep(SEND_SETTLE_MS);
    assertNotRateLimited();

    const savedUrl = existingConversationUrl ?? await waitFor(() => {
      assertNotRateLimited();
      return conversationUrl();
    }, SEND_NAVIGATION_TIMEOUT_MS);
    if (!savedUrl) throw new Error("ChatGPT did not navigate to the newly created conversation after sending.");

    const title = threadTitle();
    return { status: "sent", conversationUrl: savedUrl, ...(title ? { title } : {}) };
  }

  function assertNotRateLimited() {
    // Read visible provider notices, never conversation content that may quote an error.
    const notices = [...document.querySelectorAll('[role="alert"], [role="dialog"], [data-testid="toast"]')];
    const notice = notices.find((element) => element.getClientRects?.().length &&
      /too many (?:messages|requests)|rate limit|message limit|usage limit|you(?:'ve| have) reached.{0,60}limit/i.test(element.textContent ?? ""));
    if (notice) throw new Error(`CHATGPT_RATE_LIMITED: ${(notice.textContent ?? "").trim().slice(0, 500)}`);
  }

  function insertMessage(editor, message) {
    editor.focus();
    if (typeof editor.value === "string") {
      const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")?.set;
      if (valueSetter) valueSetter.call(editor, message);
      else editor.value = message;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: message,
      }));
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, message);
    if (!inserted) throw new Error("ChatGPT rejected the prompt insertion.");
  }


  function installTitleObserver() {
    if (typeof document === "undefined") return;
    let reportedUrl = null;
    let reportedTitle = null;
    let titleObserver;
    let discoveryObserver;

    const report = () => {
      const currentUrl = conversationUrl();
      const title = threadTitle();
      if (!currentUrl?.startsWith("https://chatgpt.com/g/") || !title ||
          (reportedUrl === currentUrl && reportedTitle === title)) return;
      try {
        const delivery = extensionApi.runtime.sendMessage({
          type: titleObservedType,
          conversationUrl: currentUrl,
          title,
        });
        void Promise.resolve(delivery).then((result) => {
          if (result?.ok) {
            reportedUrl = currentUrl;
            reportedTitle = title;
          }
        }).catch(() => undefined);
      } catch {
        // A stale content script is harmless; reinjection will install a fresh observer.
      }
    };

    const observeTitle = () => {
      const node = document.querySelector("title");
      if (!node || typeof MutationObserver !== "function") return false;
      discoveryObserver?.disconnect();
      titleObserver?.disconnect();
      titleObserver = new MutationObserver(report);
      titleObserver.observe(node, { childList: true, characterData: true, subtree: true });
      report();
      return true;
    };

    if (!observeTitle() && typeof MutationObserver === "function" && document.documentElement) {
      discoveryObserver = new MutationObserver(() => {
        if (observeTitle()) discoveryObserver?.disconnect();
      });
      discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    window.addEventListener("popstate", () => {
      reportedUrl = null;
      reportedTitle = null;
      report();
    });
    report();
    if (typeof setInterval === "function") setInterval(report, 1_000);
  }
  function installRalphComposerObserver() {
    if (typeof document === "undefined" || typeof MutationObserver !== "function") return;
    let observedConversationUrl = null;
    let previousComposerAction = null;

    const observeComposerAction = () => {
      const currentUrl = conversationUrl();
      if (currentUrl !== observedConversationUrl) {
        observedConversationUrl = currentUrl;
        previousComposerAction = null;
      }

      const composer = document.querySelector('form[data-type="unified-composer"]');
      if (!composer) return;
      const action = composer.querySelector('button[data-testid="stop-button"]')
        ? "stop"
        : getSendButton(composer) ? "send" : null;
      if (!action) return;

      if (action === "stop" && previousComposerAction === "send" &&
          currentUrl?.startsWith("https://chatgpt.com/g/")) {
        try {
          const delivery = extensionApi.runtime.sendMessage({
            type: reactivateRalphType,
            conversationUrl: currentUrl,
          });
          void Promise.resolve(delivery).catch(() => undefined);
        } catch {
          // An extension reload invalidates this script while its page observer remains alive.
        }
      }
      previousComposerAction = action;
    };

    const refresh = () => {
      const currentUrl = conversationUrl();
      observeComposerAction();
    };

    const observer = new MutationObserver(refresh);
    const start = () => {
      refresh();
      if (document.documentElement) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-testid", "aria-label", "id"],
        });
      }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }

  function getComposer() {
    const typedComposer = document.querySelector('form[data-type="unified-composer"]');
    const editor = typedComposer?.querySelector('#prompt-textarea[contenteditable="true"]') ??
      typedComposer?.querySelector('textarea[name="prompt-textarea"]') ??
      document.querySelector('#prompt-textarea[contenteditable="true"]') ??
      document.querySelector('textarea[name="prompt-textarea"]');
    const composer = typedComposer ?? editor?.closest?.("form");
    return composer && editor ? { composer, editor } : null;
  }

  function getSendButton(composer) {
    const root = composer ?? document;
    return root.querySelector("#composer-submit-button") ??
      root.querySelector('button[data-testid="send-button"]') ??
      root.querySelector('button[aria-label="Send prompt"]');
  }

  function isActionableButton(button) {
    return Boolean(button && !button.disabled && button.getAttribute?.("aria-disabled") !== "true");
  }


  async function waitForComposer(timeoutMs) {
    return await waitFor(() => getComposer(), timeoutMs);
  }

  async function waitForConversationReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await waitForComposer(Math.min(1_000, deadline - Date.now()));
      if (!ready) continue;
      if (document.readyState === "loading") {
        await sleep(100);
        continue;
      }
      if (ready.composer.querySelector('button[data-testid="stop-button"]')) return ready;
      if (document.querySelector('section[data-turn="user"]')) return ready;
      await sleep(100);
    }
    return null;
  }

  async function waitForStableTurns() {
    const settled = await waitForAllSettled(() => {
      if (isRunning()) return { value: true, signature: "running", quietMs: 0 };

      const turns = [...document.querySelectorAll("section[data-turn]")];
      const lastUserIndex = turns.findLastIndex((turn) => turn.dataset.turn === "user");
      if (lastUserIndex < 0) return null;
      const hasAssistantAfterLastUser = turns.slice(lastUserIndex + 1).some((turn) => turn.dataset.turn === "assistant");
      const signature = turns.map((turn) => [
        turn.dataset.turn,
        turn.dataset.turnId ?? "",
        turn.textContent ?? "",
      ].join(":")).join("|");
      return {
        value: true,
        signature,
        quietMs: hasAssistantAfterLastUser ? THREAD_ASSISTANT_SETTLE_MS : THREAD_UNCERTAIN_SETTLE_MS,
      };
    }, THREAD_SETTLE_TIMEOUT_MS);
    return Boolean(settled);
  }

  async function waitForAllSettled(sample, timeoutMs) {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    let previousSignature = null;
    let stableSince = 0;
    while (Date.now() < deadline) {
      assertNotRateLimited();
      const state = sample();
      if (!state) {
        previousSignature = null;
        stableSince = 0;
      } else if (state.quietMs <= 0) {
        return state.value;
      } else if (state.signature !== previousSignature) {
        previousSignature = state.signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= state.quietMs) {
        return state.value;
      }
      await sleep(100);
    }
    return null;
  }

  function isRunning() {
    return Boolean(document.querySelector('form[data-type="unified-composer"] button[data-testid="stop-button"]'));
  }

  async function getRalphMinWorkedSeconds() {
    if (!extensionApi.storage?.local?.get) return DEFAULT_RALPH_MIN_WORKED_SECONDS;
    const stored = await extensionApi.storage.local.get({
      [RALPH_MIN_WORKED_SECONDS_KEY]: DEFAULT_RALPH_MIN_WORKED_SECONDS,
    });
    const value = stored[RALPH_MIN_WORKED_SECONDS_KEY];
    if (value === LEGACY_RALPH_MIN_WORKED_SECONDS) {
      await extensionApi.storage.local.set?.({ [RALPH_MIN_WORKED_SECONDS_KEY]: DEFAULT_RALPH_MIN_WORKED_SECONDS });
      return DEFAULT_RALPH_MIN_WORKED_SECONDS;
    }
    return Number.isInteger(value) && value >= 0 ? value : DEFAULT_RALPH_MIN_WORKED_SECONDS;
  }

  function getWorkedDurationSeconds(minWorkedSeconds) {
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

    const workedSeconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
    return workedSeconds > minWorkedSeconds ? workedSeconds : null;
  }

  function extractText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll("button, script, style, svg, [role='tooltip']").forEach((node) => node.remove());
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;opacity:0;pointer-events:none;";
    container.setAttribute("aria-hidden", "true");
    container.appendChild(clone);
    document.body.appendChild(container);
    const text = (container.innerText || clone.textContent || "").replace(/\u00a0/g, " ").trim();
    container.remove();
    return text;
  }

  async function waitFor(getElement, timeoutMs) {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertNotRateLimited();
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
