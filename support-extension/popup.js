const extensionApi = globalThis.browser ?? globalThis.chrome;
const config = globalThis.LOCAL_CODEX_THREAD_SYNC;
const DEFAULT_SETTINGS = {
  threadSync: true,
  automationExecutor: false,
  ralph: false,
  threadMessaging: false,
};
const SUBAGENT_PROJECT_KEY = "subagentProjectUrl";
const RALPH_MIN_WORKED_SECONDS_KEY = "ralphMinWorkedSeconds";
const LEGACY_RALPH_MIN_WORKED_SECONDS = 19 * 60;
const DEFAULT_RALPH_MIN_WORKED_SECONDS = 20 * 60;
const DEFAULT_RALPH_LOOP_INTERVAL_SECONDS = 3 * 60;

function validateLoopbackEndpoint(value, pathname) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== pathname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`Local Codex Support endpoint must be ${pathname} on configured IPv4 loopback.`);
  }
  return endpoint;
}

const ralphProjectsEndpoint = validateLoopbackEndpoint(config?.ralphProjectsUrl, "/chatgpt-support/ralph/projects");
const ralphRegisterEndpoint = validateLoopbackEndpoint(config?.ralphRegisterUrl, "/chatgpt-support/ralph/register");
const ralphSettingsEndpoint = validateLoopbackEndpoint(config?.ralphSettingsUrl, "/chatgpt-support/ralph/settings");
const ralphThreadsEndpoint = validateLoopbackEndpoint(config?.ralphThreadsUrl, "/chatgpt-support/ralph/threads");

function element(id) {
  return document.getElementById(id);
}

function setNote(node, message, tone) {
  node.textContent = message;
  if (tone === "error") node.dataset.tone = "error";
  else delete node.dataset.tone;
}

function errorMessage(error, fallback) {
  return error instanceof Error ? error.message : fallback;
}

async function callServer(endpoint, init) {
  const response = await fetch(endpoint.href, {
    ...init,
    headers: { authorization: `Bearer ${config.extensionToken}`, ...init?.headers },
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  // Express answers unknown routes with an HTML error page, so only trust a JSON content type.
  const data = response.headers.get("content-type")?.startsWith("application/json")
    ? await response.json()
    : undefined;
  if (response.status === 404) throw new Error("Local Codex is running an older build. Restart it to enable this view.");
  if (!response.ok) throw new Error(data?.error || `Local Codex returned ${response.status}.`);
  if (!data) throw new Error("Local Codex returned an unexpected response.");
  return data;
}

function setConnection(state, label) {
  element("connection").dataset.state = state;
  element("connectionLabel").textContent = label;
}

/* Tabs */

function selectTab(tab) {
  for (const other of document.querySelectorAll(".tab")) {
    const selected = other === tab;
    other.setAttribute("aria-selected", String(selected));
    other.tabIndex = selected ? 0 : -1;
    element(other.dataset.panel).hidden = !selected;
  }
  tab.focus();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll(".tab")];
    selectTab(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]);
  });
}

/* RALPH threads */

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const TIME_UNITS = [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]];
let threadFilter = "active";
let loadedThreads = [];
let currentConversationUrl;

function canonicalProjectId(value) {
  const known = value.match(/^(g-p-[0-9a-f]{32})(?:-[A-Za-z0-9_-]+)?$/i);
  return known ? known[1].toLowerCase() : value;
}

function conversationUrl(value) {
  if (typeof value !== "string") return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const match = url.pathname.match(/^(?:\/g\/([A-Za-z0-9_-]+))?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password || !match) return undefined;
  const threadId = match[2].toLowerCase();
  return match[1]
    ? `https://chatgpt.com/g/${canonicalProjectId(match[1])}/c/${threadId}`
    : `https://chatgpt.com/c/${threadId}`;
}

async function loadCurrentThread() {
  const button = element("markCurrentThread");
  const status = element("currentThreadStatus");
  const [tab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
  currentConversationUrl = conversationUrl(tab?.url);
  button.disabled = !currentConversationUrl;
  setNote(status, currentConversationUrl
    ? currentConversationUrl
    : "Open a saved ChatGPT thread in this tab.");
}

async function markCurrentThread() {
  const button = element("markCurrentThread");
  const status = element("currentThreadStatus");
  button.disabled = true;
  button.textContent = "Marking...";
  try {
    await loadCurrentThread();
    if (!currentConversationUrl) return;
    await callServer(ralphRegisterEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationUrl: currentConversationUrl, manual: true }),
    });
    setNote(status, "Marked for RALPH. The project filter will not remove this thread.");
    await loadThreads();
  } catch (error) {
    setNote(status, errorMessage(error, "Could not mark the current thread for RALPH."), "error");
  } finally {
    button.textContent = "Mark for RALPH";
    button.disabled = !currentConversationUrl;
  }
}

function formatRelative(timestamp) {
  const deltaSeconds = (timestamp - Date.now()) / 1000;
  const [unit, size] = TIME_UNITS.find(([, seconds]) => Math.abs(deltaSeconds) >= seconds) ?? TIME_UNITS.at(-1);
  return relativeTime.format(Math.round(deltaSeconds / size), unit);
}

async function openConversation(conversation) {
  const tabs = await extensionApi.tabs.query({});
  const existing = tabs.find((tab) => Number.isInteger(tab.id) && conversationUrl(tab.url) === conversation);
  if (existing) {
    await extensionApi.tabs.update(existing.id, { active: true });
    if (Number.isInteger(existing.windowId) && extensionApi.windows?.update) {
      await extensionApi.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await extensionApi.tabs.create({ url: conversation, active: true });
  }
  globalThis.close();
}
function threadState(thread) {
  if (thread.state === "complete") return "complete";
  return thread.lastError ? "retrying" : "active";
}

function metaEntry(label, value) {
  const entry = document.createElement("span");
  entry.append(`${label} `, Object.assign(document.createElement("b"), { textContent: value }));
  return entry;
}

function renderThread(thread) {
  const item = document.createElement("li");
  const card = document.createElement("div");
  card.className = "thread";
  const link = document.createElement("a");
  link.className = "thread-link";
  link.target = "_blank";
  link.rel = "noreferrer";
  if (thread.conversationUrl.startsWith("https://chatgpt.com/")) {
    link.href = thread.conversationUrl;
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void openConversation(thread.conversationUrl);
    });
  }

  const state = threadState(thread);
  const head = document.createElement("div");
  head.className = "thread-head";
  const title = Object.assign(document.createElement("span"), {
    className: "thread-id",
    textContent: thread.title || "Waiting for title…",
  });
  if (!thread.title) title.dataset.placeholder = "true";
  head.append(title);
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.dataset.state = state;
  const pillLabel = state === "retrying"
    ? state
    : thread.mode === "continuous" && thread.state === "active" ? "continuous" : state;
  pill.append(document.createElement("i"), pillLabel);
  head.append(pill);

  const meta = document.createElement("p");
  meta.className = "thread-meta";
  meta.append(metaEntry("Registered", formatRelative(Date.parse(thread.registeredAt))));
  if (thread.lastContinuationAt) {
    meta.append(metaEntry("Continued", formatRelative(Date.parse(thread.lastContinuationAt))));
  } else if (thread.lastCheckedAt) {
    meta.append(metaEntry("Checked", formatRelative(Date.parse(thread.lastCheckedAt))));
  }
  if (thread.parentThreadId) meta.append(metaEntry("Parent", thread.parentThreadId.slice(0, 8)));
  if (thread.state === "active") meta.append(metaEntry("Next check", formatRelative(thread.nextCheckAt)));

  link.append(head, Object.assign(document.createElement("p"), {
    className: "thread-url",
    textContent: thread.conversationUrl,
  }), meta);

  if (thread.lastError) {
    link.append(Object.assign(document.createElement("p"), {
      className: "thread-error",
      textContent: thread.lastError,
    }));
  }

  card.append(link);
  const actions = document.createElement("div");
  actions.className = "thread-actions";
  if (thread.state === "active") {
    const checkButton = document.createElement("button");
    checkButton.className = "button";
    checkButton.type = "button";
    checkButton.textContent = "Check now";
    checkButton.title = "Run the next RALPH check immediately";
    checkButton.addEventListener("click", () => void checkThreadNow(thread, checkButton));
    actions.append(checkButton);
  }
  const modeButton = document.createElement("button");
  modeButton.className = "button button-ghost";
  modeButton.type = "button";
  modeButton.textContent = thread.mode === "continuous" ? "Stop continuous" : "Run continuously";
  modeButton.title = thread.mode === "continuous"
    ? "Return this thread to normal RALPH completion behavior"
    : "Keep giving this thread new turns until you stop continuous mode";
  modeButton.addEventListener("click", () => void setThreadMode(thread, modeButton));
  actions.append(modeButton);

  const stateButton = document.createElement("button");
  stateButton.className = "button button-ghost";
  stateButton.type = "button";
  stateButton.textContent = thread.state === "active" ? "Mark complete" : "Mark active";
  stateButton.addEventListener("click", () => void setThreadState(thread, stateButton));
  actions.append(stateButton);
  card.append(actions);

  item.append(card);
  return item;
}

function threadStateEndpoint(threadId, state) {
  const endpoint = new URL(ralphThreadsEndpoint.href);
  endpoint.pathname = `${endpoint.pathname}/${encodeURIComponent(threadId)}/${state}`;
  return endpoint;
}

async function checkThreadNow(thread, button) {
  button.disabled = true;
  button.textContent = "Starting...";
  try {
    await callServer(threadStateEndpoint(thread.threadId, "check"), { method: "PUT" });
    await loadThreads();
    setNote(element("threadsStatus"), `Started the next RALPH check for ${thread.threadId.slice(0, 8)}.`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Check now";
    setNote(element("threadsStatus"), errorMessage(error, "Could not start the RALPH check."), "error");
  }
}

async function setThreadMode(thread, button) {
  const nextMode = thread.mode === "continuous" ? "normal" : "continuous";
  button.disabled = true;
  button.textContent = nextMode === "continuous" ? "Starting..." : "Stopping...";
  try {
    const endpoint = threadStateEndpoint(thread.threadId, "mode");
    await callServer(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: nextMode }),
    });
    await loadThreads();
  } catch (error) {
    button.disabled = false;
    button.textContent = thread.mode === "continuous" ? "Stop continuous" : "Run continuously";
    setNote(element("threadsStatus"), errorMessage(error, "Could not change the RALPH mode."), "error");
  }
}

async function setThreadState(thread, button) {
  const nextState = thread.state === "active" ? "complete" : "active";
  if (nextState === "complete" &&
      !globalThis.confirm(`Mark RALPH thread ${thread.threadId.slice(0, 8)} as complete? Local Codex will stop checking it.`)) return;
  button.disabled = true;
  button.textContent = nextState === "active" ? "Activating..." : "Marking...";
  try {
    await callServer(threadStateEndpoint(thread.threadId, nextState), { method: "PUT" });
    await loadThreads();
  } catch (error) {
    button.disabled = false;
    button.textContent = nextState === "active" ? "Mark active" : "Mark complete";
    setNote(element("threadsStatus"), errorMessage(error, `Could not mark the RALPH thread ${nextState}.`), "error");
  }
}

function renderEmptyState(kind) {
  const item = document.createElement("li");
  const empty = document.createElement("div");
  empty.className = "empty";
  if (kind === "subagent") {
    empty.append(
      Object.assign(document.createElement("strong"), { textContent: threadFilter === "active" ? "No active sub-agents" : "No completed sub-agents" }),
      threadFilter === "active"
        ? "Automatically registered sub-agent threads appear here while they are running."
        : "Completed sub-agent threads remain separated from your normal RALPH list.",
    );
  } else if (threadFilter === "active") {
    empty.append(
      Object.assign(document.createElement("strong"), { textContent: "No active threads" }),
      "Completed threads remain available under Completed and can be marked active again.",
    );
  } else {
    empty.append(
      Object.assign(document.createElement("strong"), { textContent: "No completed threads" }),
      "Threads you stop manually or RALPH finishes will appear here.",
    );
  }
  item.append(empty);
  return item;
}

function renderThreadList(list, threads, kind) {
  list.replaceChildren();
  if (threads.length === 0) {
    list.append(renderEmptyState(kind));
    return;
  }
  const ordered = [...threads].sort((left, right) => Date.parse(right.registeredAt) - Date.parse(left.registeredAt));
  list.append(...ordered.map(renderThread));
}

function renderThreads() {
  const regular = loadedThreads.filter((thread) => !thread.agentCreated && thread.state === threadFilter);
  const subagents = loadedThreads.filter((thread) => thread.agentCreated && thread.state === threadFilter);
  renderThreadList(element("threadList"), regular, "regular");

  const allSubagents = loadedThreads.filter((thread) => thread.agentCreated);
  const section = element("subagentThreadsSection");
  section.hidden = allSubagents.length === 0;
  element("subagentCount").textContent = String(subagents.length);
  if (!section.hidden) renderThreadList(element("subagentThreadList"), subagents, "subagent");
}

function selectThreadFilter(filter) {
  threadFilter = filter;
  for (const button of document.querySelectorAll("[data-thread-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.threadFilter === filter));
  }
  renderThreads();
}

async function loadThreads() {
  const button = element("refreshThreads");
  const status = element("threadsStatus");
  button.disabled = true;
  try {
    const { threads } = await callServer(ralphThreadsEndpoint);
    loadedThreads = threads;
    const active = threads.filter((thread) => !thread.agentCreated && thread.state === "active").length;
    element("activeCount").textContent = String(active);
    renderThreads();
    setNote(status, "");
    setConnection("online", "Connected");
  } catch (error) {
    element("threadList").replaceChildren();
    setNote(status, errorMessage(error, "Could not reach Local Codex."), "error");
    setConnection("offline", "Offline");
  } finally {
    button.disabled = false;
  }
}

/* Settings */

async function load() {
  const settings = await extensionApi.storage.local.get({
    ...DEFAULT_SETTINGS,
    [SUBAGENT_PROJECT_KEY]: "",
    [RALPH_MIN_WORKED_SECONDS_KEY]: DEFAULT_RALPH_MIN_WORKED_SECONDS,
  });
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    element(key).checked = Boolean(settings[key]);
  }
  if (settings[RALPH_MIN_WORKED_SECONDS_KEY] === LEGACY_RALPH_MIN_WORKED_SECONDS) {
    settings[RALPH_MIN_WORKED_SECONDS_KEY] = DEFAULT_RALPH_MIN_WORKED_SECONDS;
    await extensionApi.storage.local.set({ [RALPH_MIN_WORKED_SECONDS_KEY]: DEFAULT_RALPH_MIN_WORKED_SECONDS });
  }
  element(RALPH_MIN_WORKED_SECONDS_KEY).value = String(settings[RALPH_MIN_WORKED_SECONDS_KEY]);
  await Promise.all([loadCurrentThread(), loadRalphProjects(), loadRalphSettings(settings[SUBAGENT_PROJECT_KEY]), loadThreads()]);
}

async function notifySettingsChanged() {
  await extensionApi.runtime.sendMessage({ type: "local-codex-support/settings-changed" }).catch(() => undefined);
}

async function saveSettings() {
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    settings[key] = element(key).checked;
  }
  await extensionApi.storage.local.set(settings);
  await notifySettingsChanged();
}

function normalizeProjectUrl(value) {
  const url = new URL(value.trim());
  if (url.origin !== "https://chatgpt.com" || url.username || url.password ||
      !/^\/g\/[A-Za-z0-9_-]+\/project\/?$/.test(url.pathname)) {
    throw new Error("Use a ChatGPT project URL ending in /project.");
  }
  return `https://chatgpt.com${url.pathname.replace(/\/$/, "")}`;
}

async function saveSubagentProject() {
  const button = element("saveSubagentProject");
  const input = element(SUBAGENT_PROJECT_KEY);
  const status = element("subagentProjectStatus");
  button.disabled = true;
  try {
    const projectUrl = input.value.trim() ? normalizeProjectUrl(input.value) : null;
    const settings = await callServer(ralphSettingsEndpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subagentProjectUrl: projectUrl }),
    });
    input.value = settings.subagentProjectUrl ?? "";
    await extensionApi.storage.local.remove?.(SUBAGENT_PROJECT_KEY);
    setNote(status, settings.subagentProjectUrl
      ? "Saved on the Local Codex server. New agent threads will spawn in this project."
      : "No dedicated project configured. New agent threads will start at chatgpt.com.");
  } catch (error) {
    setNote(status, errorMessage(error, "Could not save the sub-agent project."), "error");
  } finally {
    button.disabled = false;
  }
}

async function saveRalphTime() {
  const button = element("saveRalphTime");
  const status = element("ralphTimeStatus");
  const seconds = Number(element(RALPH_MIN_WORKED_SECONDS_KEY).value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) {
    setNote(status, "Enter a whole number from 0 to 86400 seconds.", "error");
    return;
  }

  button.disabled = true;
  try {
    await extensionApi.storage.local.set({ [RALPH_MIN_WORKED_SECONDS_KEY]: seconds });
    setNote(status, `Saved ${seconds} second${seconds === 1 ? "" : "s"}. Only settled turns above this worked time are classified.`);
    await notifySettingsChanged();
  } finally {
    button.disabled = false;
  }
}

async function loadRalphSettings(legacySubagentProjectUrl = "") {
  const status = element("ralphLoopIntervalStatus");
  const projectStatus = element("subagentProjectStatus");
  try {
    let settings = await callServer(ralphSettingsEndpoint);
    if (!settings.subagentProjectUrl && legacySubagentProjectUrl) {
      const projectUrl = normalizeProjectUrl(legacySubagentProjectUrl);
      settings = await callServer(ralphSettingsEndpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subagentProjectUrl: projectUrl }),
      });
      await extensionApi.storage.local.remove?.(SUBAGENT_PROJECT_KEY);
      setNote(projectStatus, "Migrated the saved Sub-agent project to the Local Codex server.");
    } else {
      setNote(projectStatus, settings.subagentProjectUrl
        ? "Stored on the Local Codex server. New agent threads spawn inside this project."
        : "No dedicated project configured. New agent threads start at chatgpt.com.");
    }
    element(SUBAGENT_PROJECT_KEY).value = settings.subagentProjectUrl ?? "";
    element("ralphLoopIntervalSeconds").value = String(settings.loopIntervalSeconds);
  } catch (error) {
    element(SUBAGENT_PROJECT_KEY).value = legacySubagentProjectUrl || "";
    element("ralphLoopIntervalSeconds").value = String(DEFAULT_RALPH_LOOP_INTERVAL_SECONDS);
    setNote(status, errorMessage(error, "Could not load Local Codex support settings."), "error");
  }
}

async function saveRalphLoopInterval() {
  const button = element("saveRalphLoopInterval");
  const input = element("ralphLoopIntervalSeconds");
  const status = element("ralphLoopIntervalStatus");
  const loopIntervalSeconds = Number(input.value);
  if (!Number.isInteger(loopIntervalSeconds) || loopIntervalSeconds < 120 || loopIntervalSeconds > 86_400) {
    setNote(status, "Enter a whole number from 120 to 86400 seconds.", "error");
    return;
  }

  button.disabled = true;
  try {
    const settings = await callServer(ralphSettingsEndpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loopIntervalSeconds }),
    });
    input.value = String(settings.loopIntervalSeconds);
    setNote(status, `Saved ${settings.loopIntervalSeconds} second${settings.loopIntervalSeconds === 1 ? "" : "s"}. Active threads now use this interval for repeated checks.`);
    await loadThreads();
  } catch (error) {
    setNote(status, errorMessage(error, "Could not save the RALPH check interval."), "error");
  } finally {
    button.disabled = false;
  }
}

async function loadRalphProjects() {
  const status = element("ralphProjectsStatus");
  try {
    const { projects } = await callServer(ralphProjectsEndpoint);
    element("ralphProjects").value = projects.join("\n");
    setNote(status, "These projects are registered automatically. Manual registrations and sub-agents are also retained.");
  } catch (error) {
    setNote(status, errorMessage(error, "Could not load RALPH projects."), "error");
  }
}

async function saveRalphProjects() {
  const button = element("saveRalphProjects");
  const status = element("ralphProjectsStatus");
  const projects = element("ralphProjects").value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  button.disabled = true;
  try {
    const data = await callServer(ralphProjectsEndpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projects }),
    });
    element("ralphProjects").value = data.projects.join("\n");
    setNote(status, `Saved ${data.projects.length} RALPH project${data.projects.length === 1 ? "" : "s"}.`);
    await notifySettingsChanged();
    await loadThreads();
  } catch (error) {
    setNote(status, errorMessage(error, "Could not save RALPH projects."), "error");
  } finally {
    button.disabled = false;
  }
}

for (const key of Object.keys(DEFAULT_SETTINGS)) {
  element(key).addEventListener("change", () => void saveSettings());
}
element("saveSubagentProject").addEventListener("click", () => void saveSubagentProject());
element("saveRalphLoopInterval").addEventListener("click", () => void saveRalphLoopInterval());
element("saveRalphTime").addEventListener("click", () => void saveRalphTime());
element("saveRalphProjects").addEventListener("click", () => void saveRalphProjects());
element("markCurrentThread").addEventListener("click", () => void markCurrentThread());
element("refreshThreads").addEventListener("click", () => void loadThreads());
for (const button of document.querySelectorAll("[data-thread-filter]")) {
  button.addEventListener("click", () => selectThreadFilter(button.dataset.threadFilter));
}
void load();
