import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { createUnifiedBrowserService } from "../dist/browser.js";

const desktop = process.env.ELECTRON_CONTROL_APP_DIR;
assert.ok(desktop, "Set ELECTRON_CONTROL_APP_DIR to apps/desktop in the ALLWEONE checkout.");
const desktopRequire = createRequire(path.join(path.resolve(desktop), "package.json"));
const { build } = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
const electron = desktopRequire("electron");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "unified-electron-test-"));
const children = [];
let service;
let chrome;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(operation, predicate, label) {
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    const value = await operation();
    if (predicate(value)) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function port() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function launch(name, { enabled = true, packaged = false } = {}) {
  const fixtureDirectory = path.join(temporaryRoot, `fixture-${name.replace(/[^a-z0-9]+/gi, "-")}`);
  await mkdir(fixtureDirectory, { recursive: true });
  const fixture = path.join(fixtureDirectory, "main.mjs");
  await writeFile(path.join(fixtureDirectory, "package.json"), JSON.stringify({ name: "electron-control-fixture", version: "1.0.0", type: "module", main: "main.mjs" }));
  const adapterUrl = pathToFileURL(path.join(temporaryRoot, "adapter", "control.mjs")).href;
  await writeFile(fixture, `
    import { app, BrowserWindow } from 'electron';
    import { startElectronControlBridge } from ${JSON.stringify(adapterUrl)};
    app.setName(${JSON.stringify(name)});
    app.setPath('userData', ${JSON.stringify(path.join(temporaryRoot, name))});
    app.setPath('downloads', ${JSON.stringify(temporaryRoot)});
    if (${packaged}) Object.defineProperty(app, 'isPackaged', { value: true });
    app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: true, width: 1000, height: 700, webPreferences: { backgroundThrottling: false } });
    await window.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(`
      <!doctype html><title>${name}</title><h1>${name}</h1>
      <button id="click" onclick="this.textContent='Clicked'">Click me</button>
      <input aria-label="Text" id="text"><input type="file" id="file">
      <a id="download" download="bridge.txt" href="data:text/plain;base64,ZWxlY3Ryb24gZG93bmxvYWQ=">Download</a>
      <input id="check" type="checkbox"><select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <button id="hover" onmouseenter="this.textContent='Hovered'">Hover me</button>
      <div id="drag" style="width:200px;height:60px;background:#eee" onmousedown="this.textContent='Dragging'" onmouseup="this.textContent='Dropped'">Drag here</div>
      <div style="height:2000px">Scroll test</div><p>End</p>
    `)}));
    const stop = await startElectronControlBridge({ getMainWindow: () => window });
    app.on('before-quit', stop);
    app.on('window-all-closed', () => app.quit());
    if (!${enabled} || ${packaged}) { setTimeout(() => { stop(); app.exit(0); }, 750); }
    });
  `);
  const env = { ...process.env, ALLWEONE_AGENT_CONTROL: enabled ? "1" : "0", LOCAL_CODEX_ELECTRON_BRIDGE_DESCRIPTOR: path.join(temporaryRoot, "descriptor.json") };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fixtureDirectory], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.push(child);
  const watchdog = setTimeout(() => child.kill(), 30_000);
  watchdog.unref();
  child.once("exit", () => clearTimeout(watchdog));
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  child.stderr.on("data", (data) => { log += data; });
  child.on("error", (error) => { log += error.message; });
  child.log = () => log;
  return child;
}
try {
  await build({
    configFile: false, logLevel: "error",
    build: { outDir: path.join(temporaryRoot, "adapter"), emptyOutDir: true,
      lib: { entry: path.join(desktop, "src/main/electron-control.ts"), formats: ["es"], fileName: () => "control.mjs" },
      rollupOptions: { external: (id) => id === "electron" || id.startsWith("node:") }, minify: false },
  });
  const chromePort = await port();
  const electronPort = await port();
  service = await createUnifiedBrowserService({ dataDirectory: path.join(temporaryRoot, "bridge"), port: chromePort, electronPort,
    descriptorPath: path.join(temporaryRoot, "descriptor.json"), launchBrowser: async () => { throw new Error("Unexpected Chrome launch"); } });

  // A real WebSocket peer isolates routing from any installed Chrome profile.
  const token = (await readFile(path.join(temporaryRoot, "bridge/browser-bridge-token"), "utf8")).trim();
  chrome = new WebSocket(`ws://127.0.0.1:${chromePort}?token=${token}`);
  await once(chrome, "open");
  chrome.send(JSON.stringify({ type: "hello", protocolVersion: 1, extensionId: "test-chrome", extensionVersion: "1" }));
  const chromeTab = { id: 1, windowId: 1, title: "Chrome peer", url: "https://example.test", active: true, pinned: false, highlighted: true, index: 0 };
  let chromeInputs = 0;
  chrome.on("message", (raw) => {
    const request = JSON.parse(String(raw));
    let result = {};
    if (request.method === "tabs.list") result = [chromeTab];
    else if (request.method.startsWith("tabs.")) result = chromeTab;
    else if (request.method === "debugger.command") {
      if (request.params.method.startsWith("Input.")) chromeInputs++;
      if (request.params.method === "Runtime.evaluate") result = { result: { value: "chrome-selected" } };
    }
    chrome.send(JSON.stringify({ type: "response", id: request.id, ok: true, result }));
  });
  const descriptor = JSON.parse(await readFile(path.join(temporaryRoot, "descriptor.json"), "utf8"));
  const unauthorized = new WebSocket(`${descriptor.bridgeUrl}?token=wrong`);
  assert.equal((await once(unauthorized, "close"))[0], 1008);

  for (const [name, options] of [["normal-mode", { enabled: false }], ["packaged-mode", { packaged: true }]]) {
    const child = await launch(name, options);
    await once(child, "exit");
    assert.equal(child.exitCode, 0, child.log());
    assert.equal(service.status().electronConnected, false, `${name} must not expose control`);
  }
  const first = await launch("Electron first");
  const second = await launch("Electron second");
  const controls = service.forSession("first-chat");
  const tabs = await until(() => controls.listTabs(), (tabs) => tabs.filter((tab) => tab.targetKind === "electron").length === 2, "two Electron apps");
  const a = tabs.find((tab) => tab.processId === first.pid);
  const b = tabs.find((tab) => tab.processId === second.pid);
  const c = tabs.find((tab) => tab.targetKind === "chrome");
  assert.ok(a && b && c, JSON.stringify(tabs));
  assert.equal(a.rendererId, b.rendererId, "fixture must exercise overlapping process-local IDs");
  assert.notEqual(a.id, b.id);
  assert.equal(a.targetId, `electron:${first.pid}:${a.rendererId}`);
  assert.equal(a.appName, "Electron first");
  await controls.claimTab({ tabId: a.id, title: a.title, url: a.url });
  await assert.rejects(service.forSession("second-chat").snapshot(), /No sticky/);
  assert.equal(service.forSession("first-chat"), controls, "selection persists between stateless requests");
  await controls.action({ action: "click", locator: "#click" });
  assert.equal((await controls.evaluate(undefined, "document.querySelector('#click').textContent")).value, "Clicked");
  await controls.action({ action: "type", locator: "#text", text: "Hello Electron", clear: true });
  await controls.action({ action: "press", key: "End", locator: "#text" });
  await controls.action({ action: "press", key: "Backspace", locator: "#text" });
  assert.equal((await controls.evaluate(undefined, "document.querySelector('#text').value")).value, "Hello Electro");
  await controls.action({ action: "hover", locator: "#hover" });
  assert.equal((await controls.evaluate(undefined, "document.querySelector('#hover').textContent")).value, "Hovered");
  await controls.action({ action: "check", locator: "#check", checked: true });
  await controls.action({ action: "select", locator: "#choice", values: ["b"] });
  assert.deepEqual((await controls.evaluate(undefined, "[document.querySelector('#check').checked, document.querySelector('#choice').value]")).value, [true, "b"]);
  const point = (await controls.evaluate(undefined, "(() => { const r=document.querySelector('#drag').getBoundingClientRect(); return {x:r.x+20,y:r.y+20}; })()")).value;
  await controls.action({ action: "drag", path: [point, { x: point.x + 60, y: point.y }] });
  assert.equal((await controls.evaluate(undefined, "document.querySelector('#drag').textContent")).value, "Dropped");
  const upload = path.join(temporaryRoot, "upload.txt");
  await writeFile(upload, "upload works");
  const uploaded = await controls.upload({ locator: "#file", files: [upload] });
  assert.equal(uploaded.snapshot.tabId, a.id, "nested upload snapshots use the public target ID");
  assert.equal((await controls.evaluate(undefined, "document.querySelector('#file').files[0].name")).value, "upload.txt");
  const downloaded = await controls.download({ action: "trigger", locator: "#download" });
  assert.equal(downloaded.download.state, "complete");
  assert.equal(downloaded.download.tabId, a.id);
  assert.equal(await readFile(downloaded.download.filename, "utf8"), "electron download");
  assert.equal((await controls.download({ action: "wait", downloadId: downloaded.download.id })).download.state, "complete");
  assert.equal((await controls.download({ action: "list" })).downloads[0].id, downloaded.download.id);
  await controls.action({ action: "scroll", deltaY: 600 });
  assert.ok((await controls.evaluate(undefined, "scrollY")).value > 0);
  const shot = await controls.screenshot({ fullPage: true });
  assert.ok((await readFile(shot.path)).byteLength > 100);
  const snapshot = await controls.snapshot();
  assert.ok(snapshot.screenshotData);
  assert.ok(snapshot.snapshot.accessibilityTree.length > 0);
  assert.equal(snapshot.snapshot.tabId, a.id);

  // Activating another process outside this session must not retarget it.
  const other = service.forSession("second-chat");
  const otherTabs = await other.listTabs();
  const otherB = otherTabs.find((tab) => tab.processId === second.pid);
  await other.claimTab({ tabId: otherB.id, title: otherB.title, url: otherB.url });
  await other.action({ action: "activate" });
  await controls.listTabs();
  assert.equal((await controls.evaluate(undefined, "document.title")).value, "Electron first");
  assert.equal(chromeInputs, 0);
  await controls.claimTab({ tabId: c.id, title: c.title, url: c.url });
  assert.equal((await controls.evaluate(undefined, "document.title")).value, "chrome-selected");
  await controls.releaseTab(c.id);
  await assert.rejects(controls.evaluate(undefined, "document.title"), /No sticky/);
  const listed = await controls.listTabs();
  const selected = listed.find((tab) => tab.processId === first.pid);
  await controls.claimTab({ tabId: selected.id, title: selected.title, url: selected.url });
  first.kill();
  await once(first, "exit");
  await until(() => controls.listTabs(), (tabs) => !tabs.some((tab) => tab.processId === first.pid), "disconnected target removed");
  await assert.rejects(controls.evaluate(undefined, "document.title"), /unavailable|not controlled|closed|disconnected/);
  assert.equal((await other.evaluate(undefined, "document.title")).value, "Electron second");
  await other.releaseTab(otherB.id);
  assert.ok((await other.listTabs()).some((tab) => tab.processId === second.pid), "release leaves the app open");
  console.log("PASS: unified Chrome/Electron routing, real input, screenshots, upload, process collisions, sticky sessions, disconnect rejection, normal and packaged gates");
} catch (error) {
  for (const child of children) console.error(child.log());
  throw error;
} finally {
  chrome?.terminate();
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), pause(3_000)]).catch(() => undefined);
    }
  }
  await service?.close();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await pause(250);
    }
  }
}




