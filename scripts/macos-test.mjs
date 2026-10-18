import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Run the native macOS tray tests on a Mac.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "local-codex-mac-"));
const fixture = path.join(temporary, "Installation with spaces & symbols");
await mkdir(path.join(fixture, "dist"), { recursive: true });
const portServer = net.createServer();
await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
await writeFile(path.join(fixture, ".env"), `HOST=127.0.0.1\nPORT=${port}\n`);
await writeFile(path.join(fixture, "dist/server.js"), `
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { existsSync, realpathSync } = require('node:fs');
const path = require('node:path');
const root = realpathSync(path.resolve(__dirname, '..'));
const installationId = existsSync(path.join(root, 'foreign')) ? 'another-installation' : createHash('sha256').update(root).digest('hex');
createServer((req,res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ok:true,name:'local-codex',installationId,pid:process.pid}));
}).listen(${port},'127.0.0.1');
`);
const tunnelSource = path.join(temporary, "Tunnel.swift");
await writeFile(tunnelSource, "import Foundation\nThread.sleep(forTimeInterval: 180)\n");
const cloudflaredExecutable = path.join(temporary, "cloudflared");
execFileSync("/usr/bin/xcrun", ["swiftc", tunnelSource, "-o", cloudflaredExecutable], { stdio: "inherit" });
const config = path.join(temporary, "configuration.json");
await writeFile(config, JSON.stringify({ connectorDirectory: await realpath(fixture), nodeExecutable: await realpath(process.execPath), cloudflaredExecutable, tunnelName: "tray-test" }));
const test = path.join(temporary, "tray-tests");
execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-O", path.join(root, "scripts/macos/TrayController.swift"), path.join(root, "scripts/macos/TrayControllerTests.swift"), "-o", test], { stdio: "inherit" });
try {
  execFileSync(test, [config, String(port)], { stdio: "inherit", timeout: 120_000 });
} catch (error) {
  console.error(await readFile(path.join(fixture, ".data/runtime/watchdog.log"), "utf8").catch(() => "No supervisor log."));
  console.error("Fixture installation:", await realpath(fixture));
  throw error;
}
// Package and launch a separate installation so tests never replace the user's app or settings.
for (const file of ["scripts/tray.mjs", "scripts/macos/TrayController.swift", "scripts/macos/main.swift", "assets/local-codex-logo.png"]) {
  const destination = path.join(fixture, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, file), destination);
}
execFileSync(process.execPath, [path.join(fixture, "scripts/tray.mjs"), "build", "tray-test"], { stdio: "inherit", env: { ...process.env, PATH: `${temporary}:${process.env.PATH}` } });
const app = path.join(fixture, ".data/runtime/Local Codex.app");
execFileSync("/usr/bin/plutil", ["-lint", path.join(app, "Contents/Info.plist")], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
const menuBar = spawn(path.join(app, "Contents/MacOS/local-codex"), [], { stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
menuBar.stderr.setEncoding("utf8").on("data", chunk => { diagnostics += chunk; });
try {
  await once(menuBar, "spawn");
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(menuBar.exitCode, null, diagnostics || "The packaged menu bar app exited during startup.");
  assert.equal(menuBar.signalCode, null, diagnostics || "The packaged menu bar app crashed during startup.");
} finally {
  if (menuBar.exitCode === null && menuBar.signalCode === null) {
    const stopped = once(menuBar, "exit");
    menuBar.kill("SIGTERM");
    await stopped;
  }
}
console.log("PASS: native menu bar app compiles, bundles, validates and launches on macOS.");
