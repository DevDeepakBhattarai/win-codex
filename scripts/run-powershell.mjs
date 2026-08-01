import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function resolvePowerShellExecutable(
  platform = process.platform,
  configuredExecutable = process.env.POWERSHELL_EXECUTABLE,
) {
  const configured = configuredExecutable?.trim();

  if (
    configured &&
    !(platform !== "win32" && configured.toLowerCase() === "powershell.exe")
  ) {
    return configured;
  }

  return platform === "win32" ? "powershell.exe" : "pwsh";
}

export function createPowerShellStartupArguments(
  platform = process.platform,
  interactive = false,
) {
  const startupArguments = ["-NoLogo", "-NoProfile"];
  if (!interactive) {
    startupArguments.push("-NonInteractive");
  }
  if (platform === "win32") {
    startupArguments.push("-ExecutionPolicy", "Bypass");
  }
  return startupArguments;
}

function run() {
  const forwardedArguments = process.argv.slice(2);
  const separatorIndex = forwardedArguments.indexOf("--");
  if (separatorIndex !== -1) {
    forwardedArguments.splice(separatorIndex, 1);
  }

  const [scriptPath, ...scriptArguments] = forwardedArguments;
  if (!scriptPath) {
    console.error("Usage: node scripts/run-powershell.mjs <script.ps1> [arguments]");
    process.exitCode = 1;
    return;
  }

  const executable = resolvePowerShellExecutable();
  const interactive = path.basename(scriptPath).toLowerCase() === "smoke-test.ps1";
  const startupArguments = createPowerShellStartupArguments(
    process.platform,
    interactive,
  );

  const child = spawn(
    executable,
    [...startupArguments, "-File", path.resolve(scriptPath), ...scriptArguments],
    {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  );

  child.once("error", (error) => {
    console.error(`Could not start ${executable}: ${error.message}`);
    process.exitCode = 1;
  });

  child.once("exit", (exitCode, signal) => {
    if (signal) {
      console.error(`${executable} exited because of signal ${signal}.`);
      process.exitCode = 1;
      return;
    }

    process.exitCode = exitCode ?? 1;
  });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) {
  run();
}
