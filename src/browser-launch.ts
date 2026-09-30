import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const starts = new Map<string, Promise<void>>();

export async function launchChrome(input: {
  executablePath?: string;
  profileDirectory?: string;
  userDataDirectory?: string;
} = {}) {
  const executablePath = input.executablePath ?? process.env.BROWSER_EXECUTABLE_PATH ?? await findChrome();
  const profileDirectory = input.profileDirectory ?? process.env.BROWSER_PROFILE_DIRECTORY;
  const userDataDirectory = input.userDataDirectory ?? process.env.BROWSER_USER_DATA_DIRECTORY;
  const key = JSON.stringify([executablePath, userDataDirectory]);
  const pending = starts.get(key);
  if (pending) return pending;
  const start = (async () => {
    if (await isChromeRunning(executablePath, userDataDirectory)) return;
    const args = [
      "--new-tab",
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
  })().finally(() => starts.delete(key));
  starts.set(key, start);
  return start;
}

async function isChromeRunning(executablePath: string, userDataDirectory?: string) {
  let commandLines: string[];
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | Where-Object { $chromeProcess = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; $chromeProcess -and $chromeProcess.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object ExecutablePath,CommandLine)"],
    { windowsHide: true, timeout: 10_000 });
    const processes = z.array(z.object({ ExecutablePath: z.string().nullable(), CommandLine: z.string().nullable() }))
      .parse(stdout.trim() ? JSON.parse(stdout) : []);
    commandLines = processes.filter(entry => entry.ExecutablePath?.toLowerCase() === path.resolve(executablePath).toLowerCase())
      .flatMap(entry => entry.CommandLine ? [entry.CommandLine] : []);
  } else {
    const { stdout } = await execFileAsync("ps", ["-ax", "-ww", "-o", "args="], { timeout: 10_000 });
    commandLines = stdout.split("\n").filter(line => line.trimStart().startsWith(`${executablePath} `) ||
      line.trimStart().startsWith(`"${executablePath}" `) || line.trim() === executablePath);
  }
  return commandLines.some(commandLine => {
    if (/(?:^|\s)--type(?:=|\s)/.test(commandLine)) return false;
    const argument = commandLine.match(/(?:^|\s)--user-data-dir(?:=|\s+)(.*)/)?.[1];
    if (!userDataDirectory) return !argument;
    if (!argument) return false;
    const runningDirectory = argument.match(/^"([^"]+)"/)?.[1]
      ?? (process.platform === "win32" ? argument.split(/\s/)[0] : undefined);
    if (!runningDirectory) {
      // ps joins arguments without quoting. Match the configured directory in full.
      const directory = path.resolve(userDataDirectory);
      return argument.startsWith(directory) && /^(?:\s+(?:--|https?:\/\/|about:)|\s*$)/.test(argument.slice(directory.length));
    }
    const normalize = (directory: string) => process.platform === "win32"
      ? path.resolve(directory).toLowerCase() : path.resolve(directory);
    return normalize(runningDirectory) === normalize(userDataDirectory);
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
