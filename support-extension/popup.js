const extensionApi = globalThis.browser ?? globalThis.chrome;
const config = globalThis.LOCAL_CODEX_THREAD_SYNC;
const DEFAULT_SETTINGS = {
  threadSync: true,
  ralf: false,
  threadMessaging: false,
};
const SUBAGENT_PROJECT_KEY = "subagentProjectUrl";

function validateLoopbackEndpoint(value, pathname) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== pathname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`Local Codex Support endpoint must be ${pathname} on configured IPv4 loopback.`);
  }
  return endpoint;
}

const ralfProjectsEndpoint = validateLoopbackEndpoint(config?.ralfProjectsUrl, "/chatgpt-support/ralf/projects");

async function load() {
  const settings = await extensionApi.storage.local.get({ ...DEFAULT_SETTINGS, [SUBAGENT_PROJECT_KEY]: "" });
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    document.getElementById(key).checked = Boolean(settings[key]);
  }
  document.getElementById(SUBAGENT_PROJECT_KEY).value = settings[SUBAGENT_PROJECT_KEY] ?? "";
  await loadRalfProjects();
}

async function saveSettings() {
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    settings[key] = document.getElementById(key).checked;
  }
  await extensionApi.storage.local.set(settings);
  await extensionApi.runtime.sendMessage({ type: "local-codex-support/settings-changed" }).catch(() => undefined);
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
  const button = document.getElementById("saveSubagentProject");
  const input = document.getElementById(SUBAGENT_PROJECT_KEY);
  const status = document.getElementById("subagentProjectStatus");
  button.disabled = true;
  try {
    const projectUrl = normalizeProjectUrl(input.value);
    await extensionApi.storage.local.set({ [SUBAGENT_PROJECT_KEY]: projectUrl });
    input.value = projectUrl;
    status.textContent = "Saved. New agent threads will spawn in this project.";
    await extensionApi.runtime.sendMessage({ type: "local-codex-support/settings-changed" }).catch(() => undefined);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not save the sub-agent project.";
  } finally {
    button.disabled = false;
  }
}

async function loadRalfProjects() {
  const status = document.getElementById("ralfProjectsStatus");
  try {
    const response = await fetch(ralfProjectsEndpoint.href, {
      headers: { authorization: `Bearer ${config.extensionToken}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `RALF projects returned ${response.status}.`);
    document.getElementById("ralfProjects").value = data.projects.join("\n");
    status.textContent = "Only threads inside these projects are registered for RALF.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not load RALF projects.";
  }
}

async function saveRalfProjects() {
  const button = document.getElementById("saveRalfProjects");
  const status = document.getElementById("ralfProjectsStatus");
  const projects = document.getElementById("ralfProjects").value
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
  button.disabled = true;
  try {
    const response = await fetch(ralfProjectsEndpoint.href, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${config.extensionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ projects }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `RALF projects returned ${response.status}.`);
    document.getElementById("ralfProjects").value = data.projects.join("\n");
    status.textContent = `Saved ${data.projects.length} RALF project${data.projects.length === 1 ? "" : "s"}.`;
    await extensionApi.runtime.sendMessage({ type: "local-codex-support/settings-changed" }).catch(() => undefined);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not save RALF projects.";
  } finally {
    button.disabled = false;
  }
}

for (const key of Object.keys(DEFAULT_SETTINGS)) {
  document.getElementById(key).addEventListener("change", () => void saveSettings());
}
document.getElementById("saveSubagentProject").addEventListener("click", () => void saveSubagentProject());
document.getElementById("saveRalfProjects").addEventListener("click", () => void saveRalfProjects());
void load();
