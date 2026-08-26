import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function launchChrome(input: {
  executablePath?: string;
  profileDirectory?: string;
  userDataDirectory?: string;
} = {}) {
  const executablePath = input.executablePath ?? process.env.BROWSER_EXECUTABLE_PATH ?? await findChrome();
  const profileDirectory = input.profileDirectory ?? process.env.BROWSER_PROFILE_DIRECTORY;
  const userDataDirectory = input.userDataDirectory ?? process.env.BROWSER_USER_DATA_DIRECTORY;
  const args = [
    ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
    ...(userDataDirectory ? [`--user-data-dir=${path.resolve(userDataDirectory)}`] : []),
  ];
  const environment = { ...process.env };
  delete environment.OAUTH_CONSENT_PIN;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, args, {
      env: environment,
      shell: false,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => reject(new Error(`Could not start Chrome: ${error.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function findChrome() {
  const candidates = process.platform === "win32"
    ? [
        path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error("Chrome was not found. Install Chrome or set BROWSER_EXECUTABLE_PATH to its executable path.");
}
