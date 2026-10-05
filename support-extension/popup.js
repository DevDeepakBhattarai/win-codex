const extensionApi = globalThis.browser ?? globalThis.chrome;
const config = globalThis.LOCAL_CODEX_THREAD_SYNC;
const DEFAULT_SETTINGS = {
  threadSync: true,
  automationExecutor: false,
  errorRecovery: true,
  ralph: true,
  threadMessaging: false,
};
const RALPH_MIN_WORKED_SECONDS_KEY = "ralphMinWorkedSeconds";
const LEGACY_RALPH_MIN_WORKED_SECONDS = 19 * 60;
const DEFAULT_RALPH_MIN_WORKED_SECONDS = 20 * 60;
const DEFAULT_RALPH_LOOP_INTERVAL_SECONDS = 30 * 60;
document.body.dataset.view = "sidepanel";

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
const schedulesEndpoint = new URL("/chatgpt-support/schedules", ralphThreadsEndpoint);

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

async function callServer(endpoint, init, timeoutMs = 5000) {
  const response = await fetch(endpoint.href, {
    ...init,
    headers: { authorization: `Bearer ${config.extensionToken}`, ...init?.headers },
    signal: AbortSignal.timeout(timeoutMs),
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

let settingsLoaded = false;

function selectTab(tab) {
  for (const other of document.querySelectorAll(".tab")) {
    const selected = other === tab;
    other.setAttribute("aria-selected", String(selected));
    other.tabIndex = selected ? 0 : -1;
    element(other.dataset.panel).hidden = !selected;
  }
  tab.focus();
  element("threadToolbar").hidden = !["panel-threads", "panel-settled"].includes(tab.dataset.panel);
  if (tab.dataset.panel === "panel-schedules") void loadSchedules();
  if (tab.dataset.panel === "panel-settings" && !settingsLoaded) {
    settingsLoaded = true;
    void loadSettings().catch((error) => {
      settingsLoaded = false;
      setNote(element("ralphLoopIntervalStatus"), errorMessage(error, "Could not load settings."), "error");
    });
  }
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
let loadedThreads = [];
let loadedTasks = [];
let currentConversationUrl;
let continuationEnabled = false;

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
  return (match[1]
    ? `https://chatgpt.com/g/${canonicalProjectId(match[1])}/c/${threadId}`
    : `https://chatgpt.com/c/${threadId}`) + (url.searchParams.get("temporary-chat") === "true" ? "?temporary-chat=true" : "");
}

async function loadCurrentThread() {
  const button = element("markCurrentThread");
  const status = element("currentThreadStatus");
  const [tab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
  currentConversationUrl = conversationUrl(tab?.url);
  button.disabled = !currentConversationUrl;
  document.querySelector(".current-thread").hidden = !continuationEnabled || !currentConversationUrl;
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
    button.textContent = "Enable RALPH";
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
}
function threadState(thread) {
  if (thread.state === "complete") return "complete";
  if (thread.waitingForTask) return "waiting for task";
  if (thread.activity === "running") return "running";
  if (thread.activity === "blocked") return "needs attention";
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
    textContent: thread.title || "ChatGPT thread",
  });
  if (!thread.title) title.dataset.placeholder = "true";
  head.append(title);
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.dataset.state = state;
  pill.append(document.createElement("i"), state[0].toUpperCase() + state.slice(1));
  head.append(pill);

  const meta = document.createElement("p");
  meta.className = "thread-meta";
  const updatedAt = Date.parse(thread.attentionAt ?? thread.activityAt ?? thread.registeredAt);
  meta.append(Object.assign(document.createElement("span"), { textContent: formatRelative(updatedAt), title: new Date(updatedAt).toLocaleString() }));
  if (thread.lastContinuationAt) {
    meta.append(metaEntry("Continued", formatRelative(Date.parse(thread.lastContinuationAt))));
  } else if (thread.lastCheckedAt) {
    meta.append(metaEntry("Checked", formatRelative(Date.parse(thread.lastCheckedAt))));
  }
  if (thread.parentThreadId) meta.append(metaEntry("Parent", thread.parentThreadId.slice(0, 8)));
  if (thread.state === "active" && !thread.waitingForTask && !thread.observedOnly && thread.activity !== "idle") meta.append(metaEntry("Next check", formatRelative(thread.nextCheckAt)));

  link.title = thread.conversationUrl;
  link.append(head, meta);

  if (thread.lastError) {
    link.append(Object.assign(document.createElement("p"), {
      className: "thread-error",
      textContent: thread.lastError,
    }));
  }

  card.append(link);
  if (thread.state === "complete" || thread.waitingForTask || !continuationEnabled) {
    item.append(card);
    return item;
  }
  const actions = document.createElement("div");
  actions.className = "thread-actions";
  if (thread.state === "active" && !thread.waitingForTask) {
    const checkButton = document.createElement("button");
    checkButton.className = "button button-sm";
    checkButton.type = "button";
    checkButton.textContent = "Check now";
    checkButton.title = "Run the next RALPH check immediately";
    checkButton.addEventListener("click", () => void checkThreadNow(thread, checkButton));
    actions.append(checkButton);
  }
  const stateButton = document.createElement("button");
  stateButton.className = "button button-outline button-sm";
  stateButton.type = "button";
  stateButton.textContent = "Mark complete";
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

async function setThreadState(thread, button) {
  const nextState = "complete";
  if (nextState === "complete" &&
      !globalThis.confirm(`Mark RALPH thread ${thread.threadId.slice(0, 8)} as complete? Local Codex will stop checking it.`)) return;
  button.disabled = true;
  button.textContent = "Marking...";
  try {
    await callServer(threadStateEndpoint(thread.threadId, nextState), { method: "PUT" });
    await loadThreads();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Mark complete";
    setNote(element("threadsStatus"), errorMessage(error, `Could not mark the RALPH thread ${nextState}.`), "error");
  }
}

function renderEmptyState(message = "No threads", description = "Completed threads appear in Settled.") {
  const item = document.createElement("li");
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.append(Object.assign(document.createElement("strong"), { textContent: message }),
    description);
  item.append(empty);
  return item;
}

function renderThreadList(list, threads) {
  list.replaceChildren();
  if (threads.length === 0) {
    list.append(renderEmptyState());
    return;
  }
  const ordered = [...threads].sort((left, right) =>
    Date.parse(right.attentionAt ?? right.lastCheckedAt ?? right.registeredAt) - Date.parse(left.attentionAt ?? left.lastCheckedAt ?? left.registeredAt));
  list.append(...ordered.map(renderThread));
}

function renderThreads() {
  const search = element("threadSearch").value.trim().toLowerCase();
  const matches = item => !search || (item.title ?? "").toLowerCase().includes(search);
  const childIds = new Set(loadedTasks.map(job => job.childThreadId));
  const regular = loadedThreads.filter(thread => !thread.parentThreadId && !childIds.has(thread.threadId) && matches(thread));
  const active = regular.filter(thread => thread.state !== "complete");
  const working = active.filter(thread => thread.activity === "running" || thread.waitingForTask);
  const ready = active.filter(thread => !working.includes(thread));
  const settled = regular.filter(thread => thread.state === "complete");
  renderThreadList(element("threadList"), ready);
  element("activeSection").hidden = ready.length === 0;
  element("activeCount").textContent = String(ready.length);
  element("workingSection").hidden = working.length === 0;
  element("workingCount").textContent = String(working.length);
  renderThreadList(element("workingList"), working);
  element("settledCount").textContent = String(settled.length);
  renderThreadList(element("settledList"), settled);
  const section = element("subagentThreadsSection");
  const tasks = loadedTasks.filter(job => job.state === "pending" && matches(job));
  section.hidden = tasks.length === 0;
  element("threadsEmpty").hidden = active.length > 0 || tasks.length > 0;
  element("subagentCount").textContent = String(tasks.length);
  const list = element("subagentThreadList");
  list.replaceChildren(...tasks.map(renderTask));
}

function renderTask(job) {
  const item = document.createElement("li");
  const card = Object.assign(document.createElement("div"), { className: "thread" });
  const [label, state] = job.preparationError ? ["Needs attention", "needs attention"]
    : job.state === "cancelled" ? ["Cancelled", "complete"]
    : job.state === "complete" ? ["Report available", "finished"] : ["Task in progress", "running"];
  const title = document.createElement(job.childConversationUrl ? "a" : "strong");
  title.className = "thread-id";
  title.textContent = job.title || "Worker startup";
  if (job.childConversationUrl) {
    title.href = job.childConversationUrl;
    title.addEventListener("click", (event) => { event.preventDefault(); void openConversation(job.childConversationUrl); });
  }
  const pill = Object.assign(document.createElement("span"), { className: "pill" });
  pill.dataset.state = state;
  pill.append(document.createElement("i"), label);
  const head = Object.assign(document.createElement("div"), { className: "thread-head" });
  head.append(title, pill);
  card.append(head);
  const error = job.preparationError;
  if (error) card.append(Object.assign(document.createElement("p"), { className: "thread-error", textContent: error }));
  const actions = Object.assign(document.createElement("div"), { className: "thread-actions" });
  if (job.childConversationUrl) {
    const reviewUrl = Object.assign(document.createElement("a"), {
      className: "inspect-task button button-outline button-sm",
      href: job.childConversationUrl,
      target: "_blank",
      rel: "noreferrer",
      textContent: "Inspect",
      title: job.childConversationUrl,
    });
    reviewUrl.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void openConversation(job.childConversationUrl);
    });
    actions.append(reviewUrl);
  }
  if (job.state === "pending") {
    const action = "cancel";
    const button = Object.assign(document.createElement("button"), { className: "button button-outline button-sm button-danger", type: "button", textContent: "Cancel task" });
    button.addEventListener("click", () => void changeReview(job, action, button));
    actions.append(button);
  }
  if (actions.childElementCount) card.append(actions);
  item.append(card);
  return item;
}

async function changeReview(job, action, button) {
  if (action === "cancel" && !globalThis.confirm(job.childConversationUrl
    ? "Stop this worker and cancel its task?"
    : "Inspect the automation browser first. Confirm that any worker created by this startup has stopped, then cancel the saved job?")) return;
  button.disabled = true;
  try {
    const endpoint = new URL(ralphThreadsEndpoint.href);
    endpoint.pathname = `/chatgpt-support/tasks/${encodeURIComponent(job.jobId)}`;
    await callServer(endpoint, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, confirmedStopped: action === "cancel" }) }, 9 * 60_000);
    await loadThreads();
  } catch (error) {
    setNote(element("threadsStatus"), errorMessage(error, "Task action failed."), "error");
  } finally { button.disabled = false; }
}

let loadingThreads = false;
let renderedSnapshot;
async function loadThreads() {
  if (loadingThreads) return;
  loadingThreads = true;
  const button = element("refreshThreads");
  const status = element("threadsStatus");
  button.disabled = true;
  try {
    const { threads, tasks = [], continuationEnabled: enabled, automationPausedUntil = 0 } = await callServer(ralphThreadsEndpoint);
    continuationEnabled = enabled === true;
    for (const node of document.querySelectorAll("[data-legacy-continuation]")) node.hidden = !continuationEnabled;
    document.querySelector(".current-thread").hidden = !continuationEnabled || !currentConversationUrl;
    loadedThreads = threads;
    loadedTasks = tasks;
    const snapshot = JSON.stringify([threads, tasks, continuationEnabled]);
    if (snapshot !== renderedSnapshot) {
      renderThreads();
      renderedSnapshot = snapshot;
    }
    const paused = automationPausedUntil > Date.now();
    setNote(status, paused ? `ChatGPT could not load a conversation. Tasks stay queued. Automation resumes at ${new Date(automationPausedUntil).toLocaleTimeString()}.` : "");
    setConnection(paused ? "paused" : "online", paused ? "Paused" : "Connected");
  } catch (error) {
    setNote(status, errorMessage(error, "Could not reach Local Codex."), "error");
    setConnection("offline", "Offline");
  } finally {
    button.disabled = false;
    loadingThreads = false;
  }
}

/* Settings */

let loadingSchedules = false;
let scheduleSnapshot;
element("scheduleTimezone").textContent = `Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`;
function updateRepeatFields() {
  const enabled = element("scheduleRepeat").checked;
  element("scheduleInterval").hidden = !enabled;
  element("scheduleIntervalValue").disabled = !enabled;
  element("scheduleIntervalUnit").disabled = !enabled;
}
element("scheduleRepeat").addEventListener("change", updateRepeatFields);

const formatDate = value => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

async function loadSchedules() {
  if (loadingSchedules) return;
  loadingSchedules = true;
  try {
    const { tasks } = await callServer(schedulesEndpoint);
    const snapshot = JSON.stringify(tasks);
    if (snapshot === scheduleSnapshot) return;
    const items = [...tasks].sort((a, b) => Date.parse(b.runAt) - Date.parse(a.runAt)).map(task => {
      const item = document.createElement("li");
      const card = Object.assign(document.createElement("div"), { className: "thread schedule" });
      const prompt = Object.assign(document.createElement("p"), { className: "schedule-prompt", textContent: task.prompt });
      const labels = { pending: "Scheduled", sending: "Starting", sent: "Started", failed: "Failed", missed: "Missed", cancelled: "Cancelled" };
      const pill = Object.assign(document.createElement("span"), { className: "pill" });
      pill.dataset.state = task.state;
      pill.append(document.createElement("i"), labels[task.state] ?? task.state);
      const head = Object.assign(document.createElement("div"), { className: "thread-head" });
      head.append(pill, Object.assign(document.createElement("span"), { className: "schedule-time", textContent: formatDate(task.runAt) }));
      card.append(head, prompt);
      if (task.repeatIntervalSeconds) {
        const seconds = task.repeatIntervalSeconds;
        const unit = seconds % 86400 === 0 ? "day" : seconds % 3600 === 0 ? "hour" : "minute";
        const amount = seconds / (unit === "day" ? 86400 : unit === "hour" ? 3600 : 60);
        card.append(Object.assign(document.createElement("p"), { className: "thread-meta",
          textContent: `Every ${amount} ${unit}${amount === 1 ? "" : "s"}${task.state === "pending" ? " · Next run shown above" : ""}` }));
        if (task.lastRunAt) card.append(Object.assign(document.createElement("p"), { className: "thread-meta",
          textContent: `Last run: ${task.lastRunState ? labels[task.lastRunState] : "Starting"} · ${formatDate(task.lastRunAt)}` }));
      }
      if (task.error) card.append(Object.assign(document.createElement("p"), { className: "thread-error", textContent: task.error }));
      const actions = Object.assign(document.createElement("div"), { className: "thread-actions" });
      if (conversationUrl(task.conversationUrl)) {
        const link = Object.assign(document.createElement("a"), { className: "inspect-task button button-outline button-sm", textContent: "Open chat", href: task.conversationUrl });
        link.addEventListener("click", event => { event.preventDefault(); void openConversation(task.conversationUrl); });
        actions.append(link);
      }
      const canCancel = task.state === "pending" || (task.state === "sending" && task.repeatIntervalSeconds);
      if (task.state !== "sending" || canCancel) {
        const button = Object.assign(document.createElement("button"), { className: `button button-sm ${canCancel ? "button-outline button-danger" : "button-ghost"}`,
          type: "button", textContent: canCancel ? task.repeatIntervalSeconds ? "Stop repeating" : "Cancel schedule" : "Remove" });
        if (canCancel && task.repeatIntervalSeconds) button.title = "Cancel future runs. A prompt already being sent can finish delivery.";
        button.addEventListener("click", () => {
          button.disabled = true;
          const endpoint = new URL(`${schedulesEndpoint.pathname}/${encodeURIComponent(task.id)}${canCancel ? "/cancel" : ""}`, schedulesEndpoint);
          void callServer(endpoint, { method: canCancel ? "PUT" : "DELETE" })
            .then(() => { setNote(element("scheduleStatus"), ""); return loadSchedules(); })
            .catch(error => { button.disabled = false; setNote(element("scheduleStatus"), errorMessage(error, "Could not update the schedule."), "error"); });
        });
        actions.append(button);
      }
      if (actions.childElementCount) card.append(actions);
      item.append(card);
      return item;
    });
    element("scheduleList").replaceChildren(...(items.length ? items : [renderEmptyState("No scheduled tasks", "Add a prompt and a future date above.")]));
    scheduleSnapshot = snapshot;
  } catch (error) {
    setNote(element("scheduleStatus"), errorMessage(error, "Could not load schedules."), "error");
  } finally { loadingSchedules = false; }
}

element("scheduleForm").addEventListener("submit", event => {
  event.preventDefault();
  const date = new Date(element("scheduleAt").value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    setNote(element("scheduleStatus"), "Choose a future date and time.", "error");
    return;
  }
  const repeatIntervalSeconds = element("scheduleRepeat").checked
    ? Number(element("scheduleIntervalValue").value) * Number(element("scheduleIntervalUnit").value) : undefined;
  if (repeatIntervalSeconds !== undefined && (!Number.isInteger(Number(element("scheduleIntervalValue").value)) ||
      repeatIntervalSeconds < 60 || repeatIntervalSeconds > 31_536_000)) {
    setNote(element("scheduleStatus"), "Choose a whole-number interval between one minute and 365 days.", "error");
    return;
  }
  const button = element("saveSchedule");
  button.disabled = true;
  void callServer(schedulesEndpoint, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: element("schedulePrompt").value, runAt: date.toISOString(), repeatIntervalSeconds }) })
    .then(async () => {
      element("scheduleForm").reset();
      updateRepeatFields();
      setNote(element("scheduleStatus"), "Task scheduled.");
      await loadSchedules();
    })
    .catch(error => setNote(element("scheduleStatus"), errorMessage(error, "Could not save the schedule."), "error"))
    .finally(() => { button.disabled = false; });
});
element("refreshSchedules").addEventListener("click", () => void loadSchedules());

async function loadSettings() {
  const settings = await extensionApi.storage.local.get({
    ...DEFAULT_SETTINGS,
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
  await Promise.all([loadRalphProjects(), loadRalphSettings()]);
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
    setNote(status, `Saved ${seconds} second${seconds === 1 ? "" : "s"}. Durations above this threshold appear in classifier metadata.`);
    await notifySettingsChanged();
  } finally {
    button.disabled = false;
  }
}

async function loadRalphSettings() {
  const status = element("ralphLoopIntervalStatus");
  try {
    const settings = await callServer(ralphSettingsEndpoint);
    element("ralphLoopIntervalSeconds").value = String(settings.loopIntervalSeconds);
  } catch (error) {
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
    setNote(status, "These projects are registered automatically. Manual registrations and workers are also retained.");
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
element("saveRalphLoopInterval").addEventListener("click", () => void saveRalphLoopInterval());
element("saveRalphTime").addEventListener("click", () => void saveRalphTime());
element("saveRalphProjects").addEventListener("click", () => void saveRalphProjects());
element("markCurrentThread").addEventListener("click", () => void markCurrentThread());
element("refreshThreads").addEventListener("click", () => void loadThreads());
element("threadSearch").addEventListener("input", renderThreads);
const refreshTimer = setInterval(() => {
  if (document.hidden) return;
  void loadCurrentThread();
  void loadThreads();
  if (!element("panel-schedules").hidden) void loadSchedules();
}, 3000);
window.addEventListener("unload", () => clearInterval(refreshTimer), { once: true });
void Promise.all([loadCurrentThread(), loadThreads()]);
