export type TerminalInvocation = {
  executable: string;
  args: string[];
  shell: string;
  platformName: string;
};

export function formatPlatformName(platform: NodeJS.Platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

export function shouldCreateTerminalProcessGroup(platform: NodeJS.Platform) {
  return platform !== "win32";
}

export function terminalSignalTarget(platform: NodeJS.Platform, pid: number) {
  return shouldCreateTerminalProcessGroup(platform) ? -pid : pid;
}

export function createTerminalInvocation(input: {
  platform: NodeJS.Platform;
  command: string;
  configuredExecutable: string | undefined;
  powerShellExecutable: string;
}): TerminalInvocation {
  const configuredExecutable = input.configuredExecutable?.trim();
  const platformName = formatPlatformName(input.platform);

  if (input.platform === "win32") {
    const executable = configuredExecutable || input.powerShellExecutable;
    return {
      executable,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        input.command,
      ],
      shell: executable,
      platformName,
    };
  }

  if (input.platform === "darwin") {
    const executable = configuredExecutable || "/bin/bash";
    return {
      executable,
      args: ["-lc", input.command],
      shell: executable,
      platformName,
    };
  }

  const executable = configuredExecutable || "/bin/sh";
  return {
    executable,
    args: ["-c", input.command],
    shell: executable,
    platformName,
  };
}
