import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

// Supply OS process inventory and capture starts at the child_process boundary.
// The launch decision, profile matching, and concurrent startup remain production code.
const originalExecFile = childProcess.execFile;
const originalSpawn = childProcess.spawn;
let processes = [];
let inventoryError;
let spawnError;
const starts = [];
childProcess.execFile = Object.assign(() => {}, {
  [promisify.custom]: async () => {
    if (inventoryError) throw inventoryError;
    return { stdout: process.platform === "win32" ? JSON.stringify(processes) :
      processes.map(entry => entry.CommandLine).join("\n"), stderr: "" };
  },
});
childProcess.spawn = (executable, args, options) => {
  starts.push({ executable, args, options });
  const child = new EventEmitter();
  child.unref = () => {};
  queueMicrotask(() => child.emit(spawnError ? "error" : "spawn", spawnError));
  return child;
};
syncBuiltinESMExports();
try {
  const { launchChrome } = await import(process.argv[2] ?? "../dist/browser-launch.js");
  const executablePath = path.resolve("test-chrome", "chrome.exe");
  const userDataDirectory = path.resolve("test-chrome", "profile with spaces");
  const input = { executablePath, userDataDirectory, profileDirectory: "Profile 2" };
  const commandLine = `"${executablePath}" --user-data-dir="${userDataDirectory}"`;

  processes = [{ ExecutablePath: executablePath, CommandLine: commandLine }];
  await launchChrome(input);
  assert.equal(starts.length, 0, "running Chrome is reused without opening another tab or instance");

  processes = [];
  await Promise.all([launchChrome(input), launchChrome(input), launchChrome(input)]);
  assert.equal(starts.length, 1, "closed Chrome starts once across concurrent callers");
  assert.deepEqual(starts[0].args, ["--new-tab", "--profile-directory=Profile 2", `--user-data-dir=${userDataDirectory}`]);
  assert.equal(starts[0].options.shell, false);
  assert.equal(starts[0].options.windowsHide, true);
  assert.equal(starts[0].options.env.OAUTH_CONSENT_PIN, undefined);

  processes = [{ ExecutablePath: executablePath, CommandLine: `${commandLine} --type=renderer` }];
  await launchChrome(input);
  assert.equal(starts.length, 2, "an orphan renderer does not count as a running browser");
  processes = [{ ExecutablePath: executablePath, CommandLine: `"${executablePath}" --user-data-dir="${path.resolve("another-profile")}"` }];
  await launchChrome(input);
  assert.equal(starts.length, 3, "a different user-data directory does not prevent startup of the configured browser");

  processes = [];
  spawnError = new Error("ENOENT");
  await assert.rejects(launchChrome(input), /Could not start Chrome: ENOENT/);
  spawnError = undefined;
  await launchChrome(input);
  assert.equal(starts.length, 5, "a failed startup can be retried");

  inventoryError = new Error("Process inventory unavailable");
  await assert.rejects(launchChrome(input), /Process inventory unavailable/);
  assert.equal(starts.length, 5, "an unknown process state must not spawn duplicate browsers");
} finally {
  childProcess.execFile = originalExecFile;
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
console.log("Browser launch tests passed.");
