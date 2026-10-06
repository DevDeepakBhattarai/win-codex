(() => {
  const handlerKey = "__localCodexSupportInstalled";
  const contentScriptVersion = "1.12.0";
  if (globalThis[handlerKey]?.version === contentScriptVersion) return;
  globalThis[handlerKey] = { version: contentScriptVersion };

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi?.runtime?.sendMessage || !extensionApi?.runtime?.onMessage) return;

  const requestType = "local-codex-thread-sync/bind-v1";
  const responseType = "local-codex-thread-sync/result-v1";
  const automationType = "local-codex-support/automation-v1";
  const reactivateRalphType = "local-codex-support/ralph-reactivate-v1";
  const conversationUnavailableType = "local-codex-support/conversation-unavailable-v1";
  const titleObservedType = "local-codex-support/title-observed-v1";
  const sourceRoutes = new WeakMap();
  const pending = new Set();
  let route = location.pathname;
  let generation = 0;

  let pauseUntil = 0;
  let pauseStartedAt = 0;
  let pausedTime = 0;
  function updatePause(until) {
    if (!Number.isSafeInteger(until) || until < 0 || until === pauseUntil) return;
    if (pauseStartedAt) pausedTime += Math.max(0, Math.min(Date.now(), pauseUntil) - pauseStartedAt);
    pauseUntil = until;
    pauseStartedAt = until > Date.now() ? Date.now() : 0;
  }
  function automationNow() {
    return Date.now() - pausedTime - (pauseStartedAt ? Math.max(0, Math.min(Date.now(), pauseUntil) - pauseStartedAt) : 0);
  }
  async function waitForAutomationResume() {
    const stored = await extensionApi.storage?.local?.get("automationPausedUntil");
    updatePause(stored?.automationPausedUntil ?? 0);
    while (pauseUntil > Date.now()) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, pauseUntil - Date.now())));
      const latest = await extensionApi.storage?.local?.get("automationPausedUntil");
      updatePause(latest?.automationPausedUntil ?? pauseUntil);
    }
  }
  extensionApi.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.automationPausedUntil) updatePause(changes.automationPausedUntil.newValue ?? 0);
  });

  const SEND_SETTLE_MS = 5_000;
  const SEND_READY_TIMEOUT_MS = 5 * 60_000;
  const SEND_NAVIGATION_TIMEOUT_MS = 60_000;
  const THREAD_ASSISTANT_SETTLE_MS = 5_000;
  const THREAD_UNCERTAIN_SETTLE_MS = 2 * 60_000;
  const THREAD_SETTLE_TIMEOUT_MS = 2.5 * 60_000;
  let inspectionSignature;
  let inspectionStableSince = 0;
  const RALPH_MIN_WORKED_SECONDS_KEY = "ralphMinWorkedSeconds";
  const LEGACY_RALPH_MIN_WORKED_SECONDS = 19 * 60;
  const DEFAULT_RALPH_MIN_WORKED_SECONDS = 20 * 60;

  function conversationUrl(url = location) {
    const match = url.pathname.match(/^(?:\/g\/([A-Za-z0-9_-]+))?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
    if (!match) return null;
    return (match[1]
      ? `https://chatgpt.com/g/${match[1]}/c/${match[2].toLowerCase()}`
      : `https://chatgpt.com/c/${match[2].toLowerCase()}`) + (/[?&]temporary-chat=true(?:&|$)/.test(url.search) ? "?temporary-chat=true" : "");
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
      (error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: error?.retryable === true,
      }),
    );
    return true;
  });

  async function runAutomation(command) {
    if (["voice_status", "voice_start", "voice_stop"].includes(command.kind) && command.feature === "voice") {
      return await controlVoice(command);
    }
    await waitForAutomationResume();
    checkRecoveryDeadline(command.recoveryExpiresAt);
    if (command.recovering && command.targetUrl && conversationUrl() !== conversationUrl(new URL(command.targetUrl))) {
      throw new Error("Recovery stopped because the tab navigated away.");
    }
    if (command.kind === "page_health") return pageHealth();
    if (command.kind === "dismiss_rate_limit") {
      const notice = rateLimitNotice();
      const button = notice && [...notice.querySelectorAll("button")].find(element =>
        /^got it$/i.test((element.textContent ?? "").trim()) && isActionableButton(element));
      if (button) button.click();
      return { status: button ? "dismissed" : "not_found" };
    }
    if (command.kind === "stop_thread") return await stopThread(command.recovering ? command.targetUrl : undefined, command.recoveryExpiresAt);
    if (command.kind === "resume_interrupted") {
      const failed = Boolean(connectionInterruptedNotice() || pageErrorNotice() || inlineAssistantFailureNotice());
      const stopped = await stopThread();
      if (stopped.status === "idle" && !failed) return stopped;
      return await sendMessage(command.message, undefined, false, true);
    }
    if (command.kind === "recover_page") {
      const notice = conversationUnavailableNotice() ?? pageErrorNotice();
      const retry = notice && [...document.querySelectorAll('main button, [role="alert"] button, [role="dialog"] button, body > div button')]
        .find(button => isActionableButton(button) && /^(?:retry|try again|regenerate response|continue generating)$/i.test(button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""));
      if (!retry) return { status: "unavailable" };
      retry.click();
      return { status: "recovery_started" };
    }
    if (command.kind === "send_message") return await sendMessage(command.message, command.connectorName, command.temporary,
      command.recovering === true, command.recoveryContinuation === true, command.recoveryExpiresAt);
    assertNoPageError();
    if (command.kind === "inspect_thread") {
      const url = conversationUrl();
      const result = await inspectThread();
      if (url !== conversationUrl()) throw new Error("The observed thread navigated away during inspection.");
      return result;
    }
    throw new Error("Unsupported ChatGPT support command.");
  }

  function visibleVoiceButton(label) {
    return [...document.querySelectorAll(`button[aria-label="${label}"]`)].find(button =>
      button.getClientRects().length && getComputedStyle(button).visibility !== "hidden");
  }

  function voiceState() {
    const start = visibleVoiceButton("Start Voice");
    const end = visibleVoiceButton("End Voice");
    if (end && !start) return "active";
    if (isActionableButton(start) && !end) return "closed";
    return "unavailable";
  }

  async function controlVoice(command) {
    const targetUrl = command.targetUrl;
    const assertTarget = () => {
      if (!targetUrl || conversationUrl() !== targetUrl || new URL(targetUrl).searchParams.get("temporary-chat") === "true") {
        throw new Error("Voice control is no longer on the configured regular conversation.");
      }
    };
    assertTarget();
    if (command.kind === "voice_status") return { status: voiceState(), conversationUrl: targetUrl };
    const desired = command.kind === "voice_start" ? "active" : "closed";
    const deadline = Date.now() + 30_000;
    let button;
    while (Date.now() < deadline) {
      assertTarget();
      if (voiceState() === desired) return { status: desired, conversationUrl: targetUrl };
      button = visibleVoiceButton(command.kind === "voice_start" ? "Start Voice" : "End Voice");
      if (isActionableButton(button)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!isActionableButton(button)) throw new Error("ChatGPT Voice control is unavailable. Check login, Voice access, and microphone permission.");
    button.click();
    let stableSince = 0;
    while (Date.now() < deadline) {
      assertTarget();
      if (voiceState() === desired) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 500) return { status: desired, conversationUrl: targetUrl };
      } else {
        stableSince = 0;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`ChatGPT did not confirm Voice ${desired}. Check its call controls before retrying.`);
  }

  function checkRecoveryDeadline(expiresAt) {
    if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt)) {
      throw new Error("Recovery reservation expired before delivery.");
    }
  }

  async function stopThread(targetUrl, expiresAt) {
    const ready = await waitForCancellationState(30_000);
    if (!ready) throw new Error("ChatGPT child state did not become ready for cancellation.");

    const currentUrl = conversationUrl();
    if (targetUrl && currentUrl !== conversationUrl(new URL(targetUrl))) throw new Error("Recovery stopped because the tab navigated away.");
    if (!currentUrl) throw new Error("ChatGPT cancellation is not on a saved conversation.");
    if (!ready.stopButton) return { status: "idle", conversationUrl: currentUrl };

    checkRecoveryDeadline(expiresAt);
    ready.stopButton.click();
    const stopped = await waitForStableStop(30_000);
    if (!stopped) throw new Error("ChatGPT did not confirm that the child run stopped.");
    return { status: "stopped", conversationUrl: conversationUrl() ?? currentUrl };
  }

  async function waitForCancellationState(timeoutMs) {
    const deadline = automationNow() + timeoutMs;
    let idleSince = 0;
    while (automationNow() < deadline) {
      assertNoPageError(true, true);
      const ready = getComposer();
      if (!ready || document.readyState === "loading") {
        idleSince = 0;
        await sleep(100);
        continue;
      }
      const stopButton = getStopButton(ready.composer);
      if (stopButton) return { ...ready, stopButton };
      if (!document.querySelector('section[data-turn="user"]') && !userTurns().length) {
        idleSince = 0;
        await sleep(100);
        continue;
      }
      if (!idleSince) idleSince = automationNow();
      if (automationNow() - idleSince >= 1_500) return { ...ready, stopButton: null };
      await sleep(100);
    }
    return null;
  }

  async function waitForStableStop(timeoutMs) {
    const deadline = automationNow() + timeoutMs;
    let stoppedSince = 0;
    while (automationNow() < deadline) {
      assertNoPageError(true, true);
      const ready = getComposer();
      const stopButton = ready && getStopButton(ready.composer);
      if (!ready || stopButton) {
        stoppedSince = 0;
      } else {
        if (!stoppedSince) stoppedSince = automationNow();
        if (automationNow() - stoppedSince >= 500) return true;
      }
      await sleep(100);
    }
    return false;
  }

  async function inspectThread() {
    const title = threadTitle();
    const ready = await waitForConversationReady(5_000);
    if (!ready) return { status: "loading", ...(title ? { title } : {}) };
    assertNoPageError();

    const stopButton = getStopButton(ready.composer);
    if (stopButton) return { status: "running", ...(title ? { title } : {}) };

    const settled = await waitForStableTurns(20_000);
    if (!settled) return { status: "loading", ...(title ? { title } : {}) };
    if (isRunning()) return { status: "running", ...(title ? { title } : {}) };
    const workedSeconds = getWorkedDurationSeconds(await getRalphMinWorkedSeconds());
    const turns = [...document.querySelectorAll("section[data-turn]")];
    if (!turns.length) {
      const users = userTurns().map(turn => ({ id: userTurnId(turn), text: extractText(userContent(turn)) }));
      const lastTurn = userTurns().at(-1)?.closest("[data-turn-key]") ??
        [...document.querySelectorAll("[data-turn-key]")].at(-1);
      const finalMessage = [...(lastTurn?.querySelectorAll('[data-markdown-text-tone="primary"]') ?? [])].at(-1);
      if (isRunning()) return { status: "running", ...(title ? { title } : {}) };
      return {
        status: "idle", ...(title ? { title } : {}), workedSeconds, users,
        assistant: {
          synthetic: !finalMessage,
          text: finalMessage ? extractText(finalMessage) : "[Thread stopped before an assistant response was produced.]",
        },
      };
    }
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
      const failure = assistantTurn.textContent?.trim() ?? "";
      if (isPageFailure(failure)) throw new Error(`CHATGPT_PAGE_ERROR: ${failure.slice(0, 500)}`);
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
    if (isPageFailure(text)) throw new Error(`CHATGPT_PAGE_ERROR: ${text.slice(0, 500)}`);
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

  async function sendMessage(message, connectorName, temporary = false, recovering = false, preserveDraft = false, expiresAt) {
    let sendClicked = false;
    const recoveryUrl = recovering ? conversationUrl() : undefined;
    const checkPage = () => {
      if (!sendClicked) checkRecoveryDeadline(expiresAt);
      if (recovering && conversationUrl() !== recoveryUrl) throw new Error("Recovery stopped because the tab navigated away.");
      assertNoPageError(false, recovering);
    };
    try {
      checkPage();
      if (typeof message !== "string" || !message.trim()) throw new Error("A non-empty ChatGPT message is required.");

      const existingConversationUrl = conversationUrl();
      if (temporary && !existingConversationUrl) {
        await waitForComposer(SEND_READY_TIMEOUT_MS);
        const deadline = automationNow() + SEND_READY_TIMEOUT_MS;
        while (!document.querySelector('button[aria-label="Turn off temporary chat"]')) {
          checkPage();
          if (automationNow() >= deadline) throw new Error("Temporary chat did not become active. The task was not sent.");
          // An early click can precede page hydration. Recheck the current control before retrying.
          document.querySelector('button[aria-label="Temporary chat"]')?.click();
          await sleep(SEND_SETTLE_MS);
        }
      }
      if (existingConversationUrl) {
        const loadedUserTurn = await waitFor(
          () => document.querySelector('section[data-turn="user"] [data-message-author-role="user"]') ??
            document.querySelector('[data-chatgpt-search-unit-key$=":user"] [data-markdown-text-tone="user-message"]'),
          SEND_READY_TIMEOUT_MS, recovering,
        );
        if (!loadedUserTurn) throw new Error("The existing ChatGPT thread did not load a user message.");
      }

      await sleep(SEND_SETTLE_MS);

      const ready = await waitForComposer(SEND_READY_TIMEOUT_MS, recovering);
      if (!ready) throw new Error("ChatGPT composer did not become available.");
      checkPage();
      if (preserveDraft && (ready.editor.value ?? ready.editor.textContent ?? "").trim()) {
        return { status: "idle", conversationUrl: existingConversationUrl };
      }
      insertMessage(ready.editor, message);

      if (connectorName) await attachConnector(ready, connectorName);
      const submittedMessage = (ready.editor.textContent ?? ready.editor.value ?? message).replace(/\s+/g, " ").trim();

      await sleep(SEND_SETTLE_MS);

      const current = await waitFor(() => {
        checkPage();
        const composer = getComposer();
        if (!composer) return null;
        const button = getSendButton(composer.composer);
        return isActionableButton(button) ? { ...composer, button } : null;
      }, SEND_READY_TIMEOUT_MS, recovering);
      if (!current) throw new Error("ChatGPT send button did not become actionable.");
      if (preserveDraft && (current.editor.value ?? current.editor.textContent ?? "").replace(/\s+/g, " ").trim() !== message.replace(/\s+/g, " ").trim()) {
        return { status: "idle", conversationUrl: existingConversationUrl };
      }

      const previousTurns = new Set(userTurns().map(userTurnId));
      checkRecoveryDeadline(expiresAt);
      sendClicked = true;
      current.button.click();
      await sleep(SEND_SETTLE_MS);
      checkPage();

      const savedUrl = existingConversationUrl ?? await waitFor(() => {
        checkPage();
        return conversationUrl();
      }, SEND_NAVIGATION_TIMEOUT_MS, recovering);
      if (!savedUrl) throw new Error("ChatGPT did not navigate to the newly created conversation after sending.");

      const normalizedMessage = message.replace(/\s+/g, " ").trim();
      const accepted = await waitFor(() => {
        checkPage();
        // ChatGPT can hide the user message while a new worker runs.
        const composer = getComposer();
        if (!existingConversationUrl && conversationUrl() === savedUrl && isRunning() && composer &&
            !(composer.editor.value ?? composer.editor.textContent ?? "").trim()) return true;
        return userTurns().some(turn => {
          if (previousTurns.has(userTurnId(turn))) return false;
          const content = userContent(turn);
          const text = (turn.hasAttribute?.("data-chatgpt-search-unit-key") ? extractText(content) : content.textContent)
            ?.replace(/\s+/g, " ").trim();
          return text === normalizedMessage || (connectorName && text === submittedMessage);
        });
      }, SEND_NAVIGATION_TIMEOUT_MS, recovering);
      if (!accepted) throw new Error("Delivery uncertain after Send: the submitted message was not confirmed as a new user turn. Inspect the conversation before retrying.");

      const title = threadTitle();
      return { status: "sent", conversationUrl: savedUrl, ...(title ? { title } : {}) };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("CHATGPT_RATE_LIMITED:")) {
        const detail = error.message.slice("CHATGPT_RATE_LIMITED:".length).trim();
        if (!sendClicked) throw Object.assign(new Error(`CHATGPT_RATE_LIMITED_RETRYABLE: ${detail}`), { retryable: true });
        throw new Error(`CHATGPT_RATE_LIMITED: Delivery is uncertain after Send was clicked. ${detail}`);
      }
      if (!sendClicked && typeof message === "string" && message.trim() && error instanceof Error) {
        error.retryable = true;
      }
      if (sendClicked && error instanceof Error && !error.message.startsWith("Delivery uncertain after Send:")) {
        throw new Error(`Delivery uncertain after Send: ${error.message}. Inspect the conversation before retrying.`);
      }
      throw error;
    }
  }

  async function attachConnector({ composer }, name) {
    const add = await waitFor(() => {
      const button = composer.querySelector('button[aria-label="Add files and more"]');
      return isActionableButton(button) ? button : null;
    }, 30_000);
    if (!add) throw new Error("ChatGPT connector menu did not become available.");
    add.click();
    const button = await waitFor(() => {
      const matches = [...document.querySelectorAll('button[data-list-navigation-item="true"]')].filter(button =>
        button.getClientRects().length && [...button.querySelectorAll("span")].some(span => span.textContent?.trim() === name));
      return matches.length === 1 && isActionableButton(matches[0]) ? matches[0] : null;
    }, 30_000);
    if (!button) throw new Error(`ChatGPT connector ${JSON.stringify(name)} was not found in the composer menu.`);
    button.click();
    const mention = await waitFor(() => [...(getComposer()?.editor.querySelectorAll("[app-mention-display-name]") ?? [])]
      .find(mention => mention.getAttribute("app-mention-display-name") === name), 10_000);
    if (!mention) throw new Error(`ChatGPT did not attach connector ${JSON.stringify(name)}. The task was not sent.`);
  }

  function rateLimitNotice() {
    // Read visible provider notices, never conversation content that may quote an error.
    const notices = [...document.querySelectorAll('[role="alert"], [role="dialog"], [data-testid="toast"]')];
    return notices.find((element) => element.getClientRects?.().length &&
      /too many (?:messages|requests)|rate limit|message limit|usage limit|usage cap|message cap|you(?:'ve| have) (?:reached|hit).{0,60}limit|limit reached|quota exceeded/i.test(element.textContent ?? ""));
  }

  function conversationUnavailableNotice() {
    if (userTurns().length || document.querySelector('section[data-turn], [data-message-author-role="assistant"], [data-markdown-text-tone="primary"]')) return null;
    return [...document.querySelectorAll('h1, h2, h3, [role="heading"], main div, body > div div')].find(element =>
      element.getClientRects?.().length && /^Could not load this ChatGPT conversation$/i.test(element.textContent?.trim() ?? ""));
  }

  function pageHealth() {
    if (conversationUnavailableNotice()) return { status: "conversation_unavailable" };
    if (rateLimitNotice()) return { status: "rate_limited" };
    if (connectionInterruptedNotice()) return { status: "connection_interrupted" };
    if (pageErrorNotice() || inlineAssistantFailureNotice()) return { status: "recoverable_error" };
    return { status: "ok" };
  }

  function connectionInterruptedNotice() {
    return [...document.querySelectorAll('[role="status"] .text-chatgpt-recovery')].find(element =>
      element.getClientRects?.().length && /^Connection interrupted\. Waiting for the complete answer$/i.test(element.textContent?.trim() ?? ""));
  }

  function pageErrorNotice() {
    const notices = [...document.querySelectorAll('[role="alert"], [role="dialog"], [data-testid="toast"]')];
    return notices.find(element => element.getClientRects?.().length &&
      /something went wrong|(?:error (?:generating|processing)|failure to (?:generate|process)) (?:a |the )?(?:response|message)|network error|stream (?:interrupted|disconnected|failed)|connection (?:lost|interrupted)|(?:request|response) timed out|message delivery failed/i.test(element.textContent ?? ""));
  }

  function inlineAssistantFailureNotice() {
    const turns = [...document.querySelectorAll("section[data-turn]")];
    if (turns.length) {
      const lastUserIndex = turns.findLastIndex(turn => turn.dataset.turn === "user");
      if (lastUserIndex < 0) return null;
      const assistantTurn = turns.slice(lastUserIndex + 1).filter(turn => turn.dataset.turn === "assistant").at(-1);
      if (!assistantTurn) return null;
      const finalMessage = [...assistantTurn.querySelectorAll('[data-message-author-role="assistant"]')].at(-1) ??
        [...assistantTurn.querySelectorAll('[data-markdown-text-tone="primary"]')].at(-1);
      const failureText = finalMessage?.textContent ?? assistantTurn.textContent ?? "";
      return isPageFailure(failureText) ? (finalMessage ?? assistantTurn) : null;
    }

    const lastUserTurn = userTurns().at(-1);
    const lastTurn = lastUserTurn?.closest?.("[data-turn-key]") ?? [...document.querySelectorAll("[data-turn-key]")].at(-1);
    const finalMessage = lastTurn && [...lastTurn.querySelectorAll('[data-markdown-text-tone="primary"]')].at(-1);
    return finalMessage && isPageFailure(finalMessage.textContent ?? "") ? finalMessage : null;
  }

  function isPageFailure(text) {
    return /^(?:message delivery failed|something went wrong|there was an error (?:generating|processing) (?:a |the )?(?:response|message)|network error|stream (?:interrupted|disconnected|failed)|connection (?:lost|interrupted))(?:[.!]|\s+please try again\.?)*$/i.test(text.trim());
  }

  function assertNotRateLimited() {
    const notice = rateLimitNotice();
    if (notice) throw new Error(`CHATGPT_RATE_LIMITED: ${(notice.textContent ?? "").trim().slice(0, 500)}`);
  }

  function assertNoPageError(allowRateLimit = false, allowInterrupted = false) {
    if (conversationUnavailableNotice()) throw new Error("CHATGPT_CONVERSATION_UNAVAILABLE: Could not load this ChatGPT conversation.");
    if (allowRateLimit && rateLimitNotice()) return;
    assertNotRateLimited();
    if (allowInterrupted) return;
    if (!allowInterrupted && connectionInterruptedNotice()) throw new Error("CHATGPT_CONNECTION_INTERRUPTED: Waiting for the complete answer.");
    const notice = pageErrorNotice();
    if (notice) throw new Error(`CHATGPT_PAGE_ERROR: ${(notice.textContent ?? "").trim().slice(0, 500)}`);
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
      if (!currentUrl || !title ||
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
    let reporting = false;
    let reportedUnavailable = false;
    let reportingUnavailable = false;

    const observeComposerAction = () => {
      const currentUrl = conversationUrl();
      if (currentUrl !== observedConversationUrl) {
        observedConversationUrl = currentUrl;
        previousComposerAction = null;
        reportedUnavailable = false;
      }

      const unavailable = Boolean(conversationUnavailableNotice());
      if (!unavailable) reportedUnavailable = false;
      if (currentUrl && unavailable && !reportedUnavailable && !reportingUnavailable) {
        reportingUnavailable = true;
        void Promise.resolve(extensionApi.runtime.sendMessage({ type: conversationUnavailableType, conversationUrl: currentUrl }))
          .then(result => { if (result?.ok) reportedUnavailable = true; })
          .catch(() => undefined).finally(() => { reportingUnavailable = false; });
      }
      if (pauseUntil > Date.now()) return;
      const composer = getComposer()?.composer;
      if (!composer) return;
      const health = pageHealth().status;
      const interrupted = health === "connection_interrupted";
      const action = health !== "ok" ? "blocked"
        : isRunning() ? "running" : getSendButton(composer) && userTurns().length ? "idle" : null;
      if (!action) return;
      const signature = `${action}:${health}`;

      if (currentUrl && signature !== previousComposerAction && !reporting) {
        reporting = true;
        try {
          const delivery = extensionApi.runtime.sendMessage({
            type: reactivateRalphType,
            conversationUrl: currentUrl,
            activity: action,
            title: threadTitle(),
            completed: action !== "running",
            interrupted,
            pageHealth: health,
          });
          void Promise.resolve(delivery).then((result) => {
            if (result?.ok && observedConversationUrl === currentUrl) previousComposerAction = signature;
          }).catch(() => undefined).finally(() => { reporting = false; });
        } catch {
          reporting = false;
        }
      }
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
    if (typeof setInterval === "function") setInterval(refresh, 1_000);
  }

  function getComposer() {
    const typedComposer = document.querySelector('form[data-type="unified-composer"]');
    const editor = typedComposer?.querySelector('#prompt-textarea[contenteditable="true"]') ??
      typedComposer?.querySelector('textarea[name="prompt-textarea"]') ??
      document.querySelector('[data-composer-markdown][contenteditable="true"]') ??
      document.querySelector('#prompt-textarea[contenteditable="true"]') ??
      document.querySelector('textarea[name="prompt-textarea"]');
    const composer = typedComposer ?? editor?.closest?.("[data-composer-body]") ?? editor?.closest?.("form");
    return composer && editor ? { composer, editor } : null;
  }

  function getSendButton(composer) {
    const root = composer ?? document;
    return root.querySelector("#composer-submit-button") ??
      root.querySelector('button[data-testid="send-button"]') ??
      root.querySelector('button[aria-label="Send prompt"]') ??
      root.querySelector('button[aria-label="Send"]');
  }

  function isActionableButton(button) {
    return Boolean(button && !button.disabled && button.getAttribute?.("aria-disabled") !== "true");
  }


  async function waitForComposer(timeoutMs, recovering = false) {
    return await waitFor(() => getComposer(), timeoutMs, recovering);
  }

  async function waitForConversationReady(timeoutMs) {
    const deadline = automationNow() + timeoutMs;
    while (automationNow() < deadline) {
      const ready = await waitForComposer(Math.min(1_000, deadline - automationNow()));
      if (!ready) continue;
      if (document.readyState === "loading") {
        await sleep(100);
        continue;
      }
      if (getStopButton(ready.composer)) return ready;
      if (userTurns().length) return ready;
      if (document.querySelector("[data-turn-key]")) return ready;
      await sleep(100);
    }
    return null;
  }

  async function waitForStableTurns(timeoutMs = THREAD_SETTLE_TIMEOUT_MS) {
    const settled = await waitForAllSettled(() => {
      if (isRunning()) return { value: true, signature: "running", quietMs: 0 };

      const turns = [...document.querySelectorAll("section[data-turn]")];
      if (!turns.length) {
        const users = userTurns();
        const lastTurn = users.at(-1)?.closest("[data-turn-key]") ??
          [...document.querySelectorAll("[data-turn-key]")].at(-1);
        if (!lastTurn) return null;
        const hasAssistant = Boolean(lastTurn.querySelector('[data-markdown-text-tone="primary"]'));
        const signature = location.href + lastTurn.textContent;
        if (signature !== inspectionSignature) {
          inspectionSignature = signature;
          inspectionStableSince = automationNow();
        }
        const quietMs = hasAssistant ? THREAD_ASSISTANT_SETTLE_MS : THREAD_UNCERTAIN_SETTLE_MS;
        return { value: true, signature, quietMs: automationNow() - inspectionStableSince >= quietMs ? 0 : quietMs };
      }
      const lastUserIndex = turns.findLastIndex((turn) => turn.dataset.turn === "user");
      if (lastUserIndex < 0) return null;
      const hasAssistantAfterLastUser = turns.slice(lastUserIndex + 1).some((turn) => turn.dataset.turn === "assistant");
      const signature = location.href + turns.map((turn) => [
        turn.dataset.turn,
        turn.dataset.turnId ?? "",
        turn.textContent ?? "",
      ].join(":")).join("|");
      if (signature !== inspectionSignature) {
        inspectionSignature = signature;
        inspectionStableSince = automationNow();
      }
      const quietMs = hasAssistantAfterLastUser ? THREAD_ASSISTANT_SETTLE_MS : THREAD_UNCERTAIN_SETTLE_MS;
      return {
        value: true,
        signature,
        quietMs: automationNow() - inspectionStableSince >= quietMs ? 0 : quietMs,
      };
    }, timeoutMs);
    return Boolean(settled);
  }

  async function waitForAllSettled(sample, timeoutMs) {
    const deadline = timeoutMs === undefined ? Infinity : automationNow() + timeoutMs;
    let previousSignature = null;
    let stableSince = 0;
    while (automationNow() < deadline) {
      assertNoPageError();
      const state = sample();
      if (!state) {
        previousSignature = null;
        stableSince = 0;
      } else if (state.quietMs <= 0) {
        return state.value;
      } else if (state.signature !== previousSignature) {
        previousSignature = state.signature;
        stableSince = automationNow();
      } else if (automationNow() - stableSince >= state.quietMs) {
        return state.value;
      }
      await sleep(100);
    }
    return null;
  }

  function isRunning() {
    return Boolean(document.querySelector('form[data-type="unified-composer"] button[data-testid="stop-button"]') ??
      document.querySelector('[data-composer-body] button[data-testid="stop-button"]') ??
      document.querySelector('[data-composer-body] button[aria-label="Stop"]'));
  }

  function getStopButton(composer) {
    return composer.querySelector('button[data-testid="stop-button"]') ?? composer.querySelector('button[aria-label="Stop"]');
  }

  function userTurns() {
    const legacy = [...document.querySelectorAll('section[data-turn="user"]')];
    return legacy.length ? legacy : [...document.querySelectorAll('[data-chatgpt-search-unit-key$=":user"]')];
  }

  function userTurnId(turn) {
    return turn.getAttribute?.("data-chatgpt-search-message-ids") ?? turn.dataset?.turnId ?? turn;
  }

  function userContent(turn) {
    const user = turn.querySelector('[data-message-author-role="user"]') ?? turn;
    return user.querySelector('[data-markdown-text-tone="user-message"]') ??
      user.querySelector('[data-testid="collapsible-user-message-content"]') ?? user;
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
    clone.querySelectorAll("button, script, style, svg, [role='tooltip'], a[href^='/plugins/']").forEach((node) => node.remove());
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;opacity:0;pointer-events:none;";
    container.setAttribute("aria-hidden", "true");
    container.appendChild(clone);
    document.body.appendChild(container);
    const text = (container.innerText || clone.textContent || "").replace(/\u00a0/g, " ").trim();
    container.remove();
    return text;
  }

  async function waitFor(getElement, timeoutMs, recovering = false) {
    const deadline = timeoutMs === undefined ? Infinity : automationNow() + timeoutMs;
    while (automationNow() < deadline) {
      assertNoPageError(false, recovering);
      const value = getElement();
      if (value) return value;
      await sleep(50);
    }
    return null;
  }

  async function sleep(ms) {
    await waitForAutomationResume();
    await new Promise((resolve) => setTimeout(resolve, ms));
    await waitForAutomationResume();
  }
})();
