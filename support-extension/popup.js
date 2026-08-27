const extensionApi = globalThis.browser ?? globalThis.chrome;
const DEFAULT_SETTINGS = {
  threadSync: true,
  ralf: false,
  threadMessaging: false,
};

async function load() {
  const settings = await extensionApi.storage.local.get(DEFAULT_SETTINGS);
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    document.getElementById(key).checked = Boolean(settings[key]);
  }
}

async function save() {
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    settings[key] = document.getElementById(key).checked;
  }
  await extensionApi.storage.local.set(settings);
  await extensionApi.runtime.sendMessage({ type: "local-codex-support/settings-changed" }).catch(() => undefined);
}

document.addEventListener("change", () => void save());
void load();
