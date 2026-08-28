const extensionApi = globalThis.browser ?? globalThis.chrome;
const config = globalThis.LOCAL_CODEX_THREAD_SYNC;
const DEFAULT_SETTINGS = {
  threadSync: true,
  ralf: false,
  threadMessaging: false,
};
const SUBAGENT_PROJECT_KEY = "subagentProjectUrl";
const RALF_MIN_WORKED_SECONDS_KEY = "ralfMinWorkedSeconds";
const DEFAULT_RALF_MIN_WORKED_SECONDS = 19 * 60;
const DEFAULT_RALF_LOOP_INTERVAL_SECONDS = 25 * 60;

function validateLoopbackEndpoint(value, pathname) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== pathname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`Local Codex Support endpoint must be ${pathname} on configured IPv4 loopback.`);
  }
  return endpoint;
}

const ralfProjectsEndpoint = validateLoopbackEndpoint(config?.ralfProjectsUrl, "/chatgpt-support/ralf/projects");
const ralfSettingsEndpoint = validateLoopbackEndpoint(config?.ralfSettingsUrl, "/chatgpt-support/ralf/settings");
const ralfThreadsEndpoint = validateLoopbackEndpoint(config?.ralfThreadsUrl, "/chatgpt-support/ralf/threads");

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

/* RALF threads */

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const TIME_UNITS = [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]];

function formatRelative(timestamp) {
  const deltaSeconds = (timestamp - Date.now()) / 1000;
  const [unit, size] = TIME_UNITS.find(([, seconds]) => Math.abs(deltaSeconds) >= seconds) ?? TIME_UNITS.at(-1);
  return relativeTime.format(Math.round(deltaSeconds / size), unit);
}

function projectLabel(conversationUrl) {
  const match = /^https:\/\/chatgpt\.com\/g\/([^/]+)\/c\//.exec(conversationUrl);
  return match ? match[1] : "No project";
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
  if (thread.conversationUrl.startsWith("https://chatgpt.com/")) link.href = thread.conversationUrl;

  const state = threadState(thread);
  const head = document.createElement("div");
  head.className = "thread-head";
  head.append(Object.assign(document.createElement("span"), {
    className: "thread-id",
    textContent: thread.threadId.slice(0, 8),
  }));
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.dataset.state = state;
  pill.append(document.createElement("i"), state);
  head.append(pill);

  const meta = document.createElement("p");
  meta.className = "thread-meta";
  meta.append(metaEntry("Registered", formatRelative(Date.parse(thread.registeredAt))));
  if (thread.lastContinuationAt) {
    meta.append(metaEntry("Continued", formatRelative(Date.parse(thread.lastContinuationAt))));
  } else if (thread.lastCheckedAt) {
    meta.append(metaEntry("Checked", formatRelative(Date.parse(thread.lastCheckedAt))));
  }
  if (thread.state === "active") meta.append(metaEntry("Next check", formatRelative(thread.nextCheckAt)));

  link.append(head, Object.assign(document.createElement("p"), {
    className: "thread-project",
    textContent: projectLabel(thread.conversationUrl),
  }), meta);

  if (thread.lastError) {
    link.append(Object.assign(document.createElement("p"), {
      className: "thread-error",
      textContent: thread.lastError,
    }));
  }

  card.append(link);
  if (thread.state === "active") {
    const actions = document.createElement("div");
    actions.className = "thread-actions";
    const completeButton = document.createElement("button");
    completeButton.className = "button button-ghost";
    completeButton.type = "button";
    completeButton.textContent = "Mark complete";
    completeButton.addEventListener("click", () => void markThreadComplete(thread, completeButton));
    actions.append(completeButton);
    card.append(actions);
  }

  item.append(card);
  return item;
}

function threadCompleteEndpoint(threadId) {
  const endpoint = new URL(ralfThreadsEndpoint.href);
  endpoint.pathname = `${endpoint.pathname}/${encodeURIComponent(threadId)}/complete`;
  return endpoint;
}

async function markThreadComplete(thread, button) {
  if (!globalThis.confirm(`Mark RALF thread ${thread.threadId.slice(0, 8)} as complete? Local Codex will stop checking it.`)) return;
  button.disabled = true;
  button.textContent = "Marking...";
  try {
    await callServer(threadCompleteEndpoint(thread.threadId), { method: "PUT" });
    await loadThreads();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Mark complete";
    setNote(element("threadsStatus"), errorMessage(error, "Could not mark the RALF thread complete."), "error");
  }
}

function renderEmptyState() {
  const item = document.createElement("li");
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.append(
    Object.assign(document.createElement("strong"), { textContent: "No registered threads" }),
    "Open a ChatGPT thread inside one of your RALF projects to register it for the loop.",
  );
  item.append(empty);
  return item;
}

function renderThreads(threads) {
  const list = element("threadList");
  list.replaceChildren();
  if (threads.length === 0) {
    list.append(renderEmptyState());
    return;
  }
  // Active threads first, then the soonest work at the top of each group.
  const ordered = [...threads].sort((left, right) =>
    Number(left.state === "complete") - Number(right.state === "complete") ||
    left.nextCheckAt - right.nextCheckAt);
  list.append(...ordered.map(renderThread));
}

async function loadThreads() {
  const button = element("refreshThreads");
  const status = element("threadsStatus");
  button.disabled = true;
  try {
    const { threads } = await callServer(ralfThreadsEndpoint);
    const active = threads.filter((thread) => thread.state === "active").length;
    element("activeCount").textContent = String(active);
    element("completeCount").textContent = String(threads.length - active);
    element("threadCount").textContent = String(threads.length);
    renderThreads(threads);
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
    [RALF_MIN_WORKED_SECONDS_KEY]: DEFAULT_RALF_MIN_WORKED_SECONDS,
  });
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    element(key).checked = Boolean(settings[key]);
  }
  element(SUBAGENT_PROJECT_KEY).value = settings[SUBAGENT_PROJECT_KEY] ?? "";
  element(RALF_MIN_WORKED_SECONDS_KEY).value = String(settings[RALF_MIN_WORKED_SECONDS_KEY]);
  await Promise.all([loadRalfProjects(), loadRalfSettings(), loadThreads()]);
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
    const projectUrl = normalizeProjectUrl(input.value);
    await extensionApi.storage.local.set({ [SUBAGENT_PROJECT_KEY]: projectUrl });
    input.value = projectUrl;
    setNote(status, "Saved. New agent threads will spawn in this project.");
    await notifySettingsChanged();
  } catch (error) {
    setNote(status, errorMessage(error, "Could not save the sub-agent project."), "error");
  } finally {
    button.disabled = false;
  }
}

async function saveRalfTime() {
  const button = element("saveRalfTime");
  const status = element("ralfTimeStatus");
  const seconds = Number(element(RALF_MIN_WORKED_SECONDS_KEY).value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) {
    setNote(status, "Enter a whole number from 0 to 86400 seconds.", "error");
    return;
  }

  button.disabled = true;
  try {
    await extensionApi.storage.local.set({ [RALF_MIN_WORKED_SECONDS_KEY]: seconds });
    setNote(status, `Saved ${seconds} second${seconds === 1 ? "" : "s"}.`);
    await notifySettingsChanged();
  } finally {
    button.disabled = false;
  }
}

async function loadRalfSettings() {
  const status = element("ralfLoopIntervalStatus");
  try {
    const { loopIntervalSeconds } = await callServer(ralfSettingsEndpoint);
    element("ralfLoopIntervalSeconds").value = String(loopIntervalSeconds);
  } catch (error) {
    element("ralfLoopIntervalSeconds").value = String(DEFAULT_RALF_LOOP_INTERVAL_SECONDS);
    setNote(status, errorMessage(error, "Could not load the RALF loop interval."), "error");
  }
}

async function saveRalfLoopInterval() {
  const button = element("saveRalfLoopInterval");
  const input = element("ralfLoopIntervalSeconds");
  const status = element("ralfLoopIntervalStatus");
  const loopIntervalSeconds = Number(input.value);
  if (!Number.isInteger(loopIntervalSeconds) || loopIntervalSeconds < 1 || loopIntervalSeconds > 86_400) {
    setNote(status, "Enter a whole number from 1 to 86400 seconds.", "error");
    return;
  }

  button.disabled = true;
  try {
    const settings = await callServer(ralfSettingsEndpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loopIntervalSeconds }),
    });
    input.value = String(settings.loopIntervalSeconds);
    setNote(status, `Saved ${settings.loopIntervalSeconds} second${settings.loopIntervalSeconds === 1 ? "" : "s"}. Active threads were rescheduled.`);
    await loadThreads();
  } catch (error) {
    setNote(status, errorMessage(error, "Could not save the RALF loop interval."), "error");
  } finally {
    button.disabled = false;
  }
}

async function loadRalfProjects() {
  const status = element("ralfProjectsStatus");
  try {
    const { projects } = await callServer(ralfProjectsEndpoint);
    element("ralfProjects").value = projects.join("\n");
    setNote(status, "Only threads inside these projects are registered for RALF.");
  } catch (error) {
    setNote(status, errorMessage(error, "Could not load RALF projects."), "error");
  }
}

async function saveRalfProjects() {
  const button = element("saveRalfProjects");
  const status = element("ralfProjectsStatus");
  const projects = element("ralfProjects").value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  button.disabled = true;
  try {
    const data = await callServer(ralfProjectsEndpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projects }),
    });
    element("ralfProjects").value = data.projects.join("\n");
    setNote(status, `Saved ${data.projects.length} RALF project${data.projects.length === 1 ? "" : "s"}.`);
    await notifySettingsChanged();
    await loadThreads();
  } catch (error) {
    setNote(status, errorMessage(error, "Could not save RALF projects."), "error");
  } finally {
    button.disabled = false;
  }
}

for (const key of Object.keys(DEFAULT_SETTINGS)) {
  element(key).addEventListener("change", () => void saveSettings());
}
element("saveSubagentProject").addEventListener("click", () => void saveSubagentProject());
element("saveRalfLoopInterval").addEventListener("click", () => void saveRalfLoopInterval());
element("saveRalfTime").addEventListener("click", () => void saveRalfTime());
element("saveRalfProjects").addEventListener("click", () => void saveRalfProjects());
element("refreshThreads").addEventListener("click", () => void loadThreads());
void load();
