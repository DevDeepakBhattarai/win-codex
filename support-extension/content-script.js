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

  const SEND_ATTEMPT_TIMEOUT_MS = 30_000;
  const SEND_PAGE_SETTLE_MS = 3_000;
  const SEND_BUTTON_SETTLE_MS = 750;
  const THREAD_ASSISTANT_SETTLE_MS = 5_000;
  const THREAD_UNCERTAIN_SETTLE_MS = 15_000;
  const RALF_MIN_WORKED_SECONDS_KEY = "ralfMinWorkedSeconds";
  const DEFAULT_RALF_MIN_WORKED_SECONDS = 19 * 60;

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

    const settled = await waitForStableTurns();
    if (!settled) return { status: "loading" };
    if (isRunning()) return { status: "running" };
    const workedSeconds = getWorkedDurationSeconds(await getRalfMinWorkedSeconds());
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

    const baseline = {
      previousUserCount: document.querySelectorAll('section[data-turn="user"]').length,
      previousConversationUrl: conversationUrl(),
      message,
    };
    let clicked = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptStartedAt = Date.now();
      const remaining = () => Math.max(0, SEND_ATTEMPT_TIMEOUT_MS - (Date.now() - attemptStartedAt));
      const ready = await waitForSendReady(remaining());
      if (!ready) {
        if (attempt === 0) continue;
        throw new Error("ChatGPT composer did not settle after the 30-second retry window.");
      }

      if (!editorMatchesMessage(ready.editor, message)) {
        if (clicked) {
          const acknowledged = await waitForSubmissionAcknowledged(baseline, remaining());
          if (acknowledged) return await sentResult(remaining());
          throw new Error("ChatGPT changed the composer after submission; refusing an unsafe duplicate retry.");
        }
        insertMessage(ready.editor, message);
      }

      const current = await waitForStableSendButton(message, remaining());
      if (!current) {
        if (attempt === 0 && !clicked) continue;
        throw new Error("ChatGPT send button did not become stably available within 30 seconds.");
      }

      current.button.click();
      clicked = true;
      const submitted = await waitForSubmissionAcknowledged(baseline, remaining());
      if (submitted) return await sentResult(remaining());

      // Retry only when the exact submitted text is still present and the conversation
      // has not advanced. That is the case where the first click was genuinely ignored.
      const latest = getComposer();
      const safeToRetry = attempt === 0 && latest &&
        editorMatchesMessage(latest.editor, message) &&
        document.querySelectorAll('section[data-turn="user"]').length === baseline.previousUserCount &&
        !isRunning();
      if (!safeToRetry) {
        throw new Error("ChatGPT did not acknowledge the submitted message; refusing an unsafe duplicate retry.");
      }
    }

    throw new Error("ChatGPT did not acknowledge the submitted message after retrying.");
  }

  async function sentResult(timeoutMs) {
    const existingUrl = conversationUrl();
    const savedUrl = existingUrl ?? await waitFor(() => conversationUrl(), timeoutMs);
    if (!savedUrl) throw new Error("ChatGPT did not expose the saved conversation URL after sending.");
    return { status: "sent", conversationUrl: savedUrl };
  }

  async function waitForSendReady(timeoutMs) {
    return await waitForAllSettled(() => {
      const ready = getComposer();
      if (!ready || document.readyState === "loading" || isRunning()) return null;
      return {
        value: ready,
        signature: composerSettledSignature(ready),
        quietMs: SEND_PAGE_SETTLE_MS,
      };
    }, timeoutMs);
  }

  async function waitForStableSendButton(message, timeoutMs) {
    return await waitForAllSettled(() => {
      const ready = getComposer();
      if (!ready || document.readyState === "loading" || !editorMatchesMessage(ready.editor, message)) return null;
      const button = getSendButton();
      if (!isActionableButton(button)) return null;
      return {
        value: { ...ready, button },
        signature: [composerSettledSignature(ready), readEditorText(ready.editor), "send-ready"].join("|"),
        quietMs: SEND_BUTTON_SETTLE_MS,
      };
    }, timeoutMs);
  }

  async function waitForSubmissionAcknowledged(baseline, timeoutMs) {
    return Boolean(await waitFor(() => {
      const currentUserCount = document.querySelectorAll('section[data-turn="user"]').length;
      if (currentUserCount > baseline.previousUserCount || isRunning()) return true;

      const currentUrl = conversationUrl();
      if (!baseline.previousConversationUrl && currentUrl) return true;

      const current = getComposer();
      if (current && !editorMatchesMessage(current.editor, baseline.message)) return true;
      return null;
    }, timeoutMs));
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

  function getComposer() {
    const composer = document.querySelector('form[data-type="unified-composer"]');
    const editor = composer?.querySelector('#prompt-textarea[contenteditable="true"]') ??
      composer?.querySelector('textarea[name="prompt-textarea"]');
    return composer && editor ? { composer, editor } : null;
  }

  function getSendButton() {
    return document.querySelector("#composer-submit-button") ??
      document.querySelector('button[aria-label="Send prompt"]');
  }

  function isActionableButton(button) {
    return Boolean(button && !button.disabled && button.getAttribute?.("aria-disabled") !== "true");
  }

  function readEditorText(editor) {
    if (!editor) return "";
    const value = typeof editor.value === "string" ? editor.value : editor.textContent ?? "";
    return value.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").trim();
  }

  function editorMatchesMessage(editor, message) {
    return readEditorText(editor) === message.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").trim();
  }

  function composerSettledSignature(ready) {
    const sendButton = getSendButton();
    const stopButton = ready.composer.querySelector('button[data-testid="stop-button"]');
    return [
      location.pathname,
      stopButton ? "stop" : "idle",
      sendButton ? (isActionableButton(sendButton) ? "send-enabled" : "send-disabled") : "send-missing",
      ready.editor.getAttribute?.("contenteditable") ?? "",
      ready.editor.getAttribute?.("aria-busy") ?? "",
      ready.composer.getAttribute?.("aria-busy") ?? "",
    ].join("|");
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
    }, 60_000);
    return Boolean(settled);
  }

  async function waitForAllSettled(sample, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let previousSignature = null;
    let stableSince = 0;
    while (Date.now() < deadline) {
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

  async function getRalfMinWorkedSeconds() {
    if (!extensionApi.storage?.local?.get) return DEFAULT_RALF_MIN_WORKED_SECONDS;
    const stored = await extensionApi.storage.local.get({
      [RALF_MIN_WORKED_SECONDS_KEY]: DEFAULT_RALF_MIN_WORKED_SECONDS,
    });
    const value = stored[RALF_MIN_WORKED_SECONDS_KEY];
    return Number.isInteger(value) && value >= 0 ? value : DEFAULT_RALF_MIN_WORKED_SECONDS;
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
