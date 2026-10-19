import { execFileSync, spawn } from "node:child_process";
import { access, copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command = "start", tunnelName = "local"] = process.argv.slice(2).filter(argument => argument !== "--");
if (!["start", "install", "build"].includes(command) || !/^[a-zA-Z0-9_-]+$/.test(tunnelName)) {
  throw new Error("Usage: node scripts/tray.mjs <start|install|build> [tunnel-name]");
}

function run(executable, args) {
  return execFileSync(executable, args, { cwd: root, stdio: "inherit", windowsHide: true });
}

if (process.platform === "win32") {
  if (command === "build") throw new Error("The Windows tray uses PowerShell and needs no separate build.");
  if (command === "install") {
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/install-startup.ps1"), "-TunnelName", tunnelName]);
  } else {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", path.join(root, "scripts/connector-watchdog.ps1"), "-TunnelName", tunnelName], {
      cwd: root, detached: true, stdio: "ignore", windowsHide: true,
    });
    child.once("error", error => { console.error(error.message); process.exitCode = 1; });
    child.unref();
  }
} else if (process.platform === "darwin") {
  const runtime = path.join(root, ".data/runtime");
  const app = path.join(runtime, "Local Codex.app");
  const contents = path.join(app, "Contents");
  const executable = path.join(contents, "MacOS/local-codex");
  const resources = path.join(contents, "Resources");
  const nodeExecutable = await realpath(process.execPath);
  const cloudflaredExecutable = await realpath(execFileSync("/usr/bin/which", ["cloudflared"], { encoding: "utf8" }).trim());
  for (const file of [".env", "dist/server.js", "assets/local-codex-logo.png"]) await access(path.join(root, file));
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(resources, { recursive: true });
  // Compile against Apple's SDK for the current Mac. No third-party GUI runtime is needed.
  run("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx12.0`,
    "-framework", "Cocoa", path.join(root, "scripts/macos/TrayController.swift"), path.join(root, "scripts/macos/main.swift"), "-o", executable]);
  await writeFile(path.join(resources, "configuration.json"), JSON.stringify({ connectorDirectory: await realpath(root), nodeExecutable, cloudflaredExecutable, tunnelName }, null, 2) + "\n");
  await copyFile(path.join(root, "assets/local-codex-logo.png"), path.join(resources, "local-codex-logo.png"));
  await writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.local-codex.menubar</string>
<key>CFBundleName</key><string>Local Codex</string>
<key>CFBundleExecutable</key><string>local-codex</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
  run("/usr/bin/codesign", ["--force", "--sign", "-", app]);
  if (command === "install") {
    const escapeXML = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
    const label = "com.local-codex.menubar";
    const agents = path.join(os.homedir(), "Library/LaunchAgents");
    const plist = path.join(agents, `${label}.plist`);
    await mkdir(agents, { recursive: true });
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escapeXML(executable)}</string></array>
<key>WorkingDirectory</key><string>${escapeXML(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXML(process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</string></dict>
<key>RunAtLoad</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>StandardOutPath</key><string>${escapeXML(path.join(runtime, "menubar.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${escapeXML(path.join(runtime, "menubar.stderr.log"))}</string>
</dict></plist>\n`);
    const domain = `gui/${process.getuid()}`;
    try { execFileSync("/bin/launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" }); } catch { }
    run("/bin/launchctl", ["bootstrap", domain, plist]);
    console.log(`Installed macOS sign-in startup: ${plist}`);
  } else if (command === "start") {
    run("/usr/bin/open", [app]);
  }
  console.log(`macOS menu bar app: ${app}`);
} else {
  throw new Error("The tray is supported on Windows and macOS.");
}
