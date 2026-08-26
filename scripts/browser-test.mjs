import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { createBrowserService } from "../dist/browser.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "win-codex-browser-test-"));
const uploadPath = path.join(temporaryRoot, "upload.txt");
await writeFile(uploadPath, "browser upload test", "utf8");

const testServer = http.createServer((request, response) => {
  if (request.url === "/download") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": "attachment; filename=browser-download.txt",
    });
    response.end("browser download test");
    return;
  }
  if (request.url === "/second") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Second</title><h1>Second page</h1>");
    return;
  }
  if (request.url === "/popup") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Popup</title><h1>Popup page</h1>");
    return;
  }
  if (request.url === "/user") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>User tab</title><h1>User tab</h1>");
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <title>Browser bridge test</title>
    <h1>Browser bridge test</h1>
    <p id="double-count">Double count: 0</p>
    <button id="double">Double click</button>
    <button id="popup">Open popup</button>
    <input id="upload" type="file" hidden>
    <p id="upload-result">Upload: empty</p>
    <a id="download" href="/download" download>Download</a>
    <a id="next" href="/second">Next</a>
    <script>
      let doubleCount = 0;
      document.querySelector('#double').addEventListener('dblclick', () => {
        doubleCount += 1;
        document.querySelector('#double-count').textContent = 'Double count: ' + doubleCount;
      });
      document.querySelector('#popup').addEventListener('click', () => {
        window.open('/popup', 'browser-bridge-popup', 'width=500,height=400');
      });
      document.querySelector('#upload').addEventListener('change', (event) => {
        document.querySelector('#upload-result').textContent = 'Upload: ' + event.target.files[0].name;
      });
    </script>`);
});

let service;
let context;
let originalClipboard;
try {
  const pagePort = await listen(testServer);
  const bridgePort = await availablePort();
  const debuggingPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${pagePort}`;
  const dataDirectory = path.join(temporaryRoot, "bridge");
  const extensionDirectory = path.join(dataDirectory, "browser-extension");

  service = await createBrowserService({ dataDirectory, port: bridgePort });
  const executablePath = await findBrowserExecutable();
  context = await chromium.launchPersistentContext(path.join(temporaryRoot, "profile"), {
    executablePath,
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      `--remote-debugging-port=${debuggingPort}`,
    ],
  });

  await waitUntil(() => service.status().connected, 15_000, "extension connection");
  await service.close();
  service = undefined;
  await closeExtensionServiceWorker(debuggingPort);
  service = await createBrowserService({ dataDirectory, port: bridgePort });
  await waitUntil(() => service.status().connected, 5_000, "extension reconnection after server restart");

  const userPage = context.pages()[0];
  await userPage.goto(`${baseUrl}/user`);

  let result = await service.open({ url: baseUrl, active: true });
  const agentTabId = result.snapshot.tabId;
  const agentPage = await waitUntil(
    () => context.pages().find((page) => page.url() === `${baseUrl}/`),
    10_000,
    "agent test page",
  );
  await waitUntil(
    () => readOverlay(agentPage).then((overlay) => overlay?.controlled === "true", () => false),
    10_000,
    "control aura",
  );

  result = await service.action({ tabId: agentTabId, action: "dblclick", locator: "css=#double" });
  assert.match(result.snapshot.visibleText, /Double count: 1/);
  const clickedOverlay = await readOverlay(agentPage);
  assert.equal(clickedOverlay?.clickCount, "2");
  assert.ok(Number.isFinite(Number(clickedOverlay?.pointerX)));
  assert.ok(Number.isFinite(Number(clickedOverlay?.pointerY)));

  result = await service.action({ tabId: agentTabId, action: "click", locator: "css=#next" });
  await service.action({ tabId: agentTabId, action: "wait", waitForUrlIncludes: "/second" });
  await service.action({ tabId: agentTabId, action: "back" });
  assert.equal((await service.snapshot(agentTabId, false)).snapshot.url, `${baseUrl}/`);
  await service.action({ tabId: agentTabId, action: "forward" });
  assert.equal((await service.snapshot(agentTabId, false)).snapshot.url, `${baseUrl}/second`);
  await service.action({ tabId: agentTabId, action: "back" });
  await service.action({ tabId: agentTabId, action: "reload", bypassCache: true });
  await waitUntil(
    () => readOverlay(agentPage).then((overlay) => overlay?.controlled === "true", () => false),
    10_000,
    "control aura after navigation",
  );

  await service.action({ tabId: agentTabId, action: "click", locator: "css=#popup" });
  await waitUntil(async () => (await service.listTabs()).some((tab) => tab.parentTabId === agentTabId), 10_000, "owned popup");
  const popup = (await service.listTabs()).find((tab) => tab.parentTabId === agentTabId);
  assert.equal(popup?.ownership, "agent");
  assert.equal(popup?.controlled, true);
  assert.ok((await service.snapshot(agentTabId, false)).snapshot.relatedTabs.some((tab) => tab.id === popup?.id));
  const popupPage = await waitUntil(
    () => context.pages().find((page) => page.url() === `${baseUrl}/popup`),
    10_000,
    "popup test page",
  );
  await waitUntil(
    () => readOverlay(popupPage).then((overlay) => overlay?.controlled === "true", () => false),
    10_000,
    "popup control aura",
  );

  result = await service.upload({ tabId: agentTabId, locator: "css=#upload", files: [uploadPath] });
  assert.match(result.snapshot.visibleText, /Upload: upload\.txt/);

  const downloadResult = await service.download({
    action: "trigger",
    tabId: agentTabId,
    locator: "css=#download",
    timeoutMs: 15_000,
    waitForCompletion: true,
  });
  assert.equal(downloadResult.download.state, "complete");
  assert.ok(downloadResult.download.filename);
  await access(downloadResult.download.filename);

  originalClipboard = (await service.clipboard({ action: "read_text" })).text;
  await service.clipboard({ action: "write_text", text: "browser clipboard test" });
  assert.equal((await service.clipboard({ action: "read_text" })).text, "browser clipboard test");

  const tabsBeforeClaim = await service.listTabs();
  const listedUserTab = tabsBeforeClaim.find((tab) => tab.url === `${baseUrl}/user` && !tab.controlled);
  assert.ok(listedUserTab);
  await service.manageTab({
    action: "claim",
    tabId: listedUserTab.id,
    title: listedUserTab.title,
    url: listedUserTab.url,
  });
  await waitUntil(
    () => readOverlay(userPage).then((overlay) => overlay?.controlled === "true", () => false),
    10_000,
    "claimed-tab control aura",
  );

  const newWindow = await service.open({ url: `${baseUrl}/second`, active: false, newWindow: true });
  const newWindowTabId = newWindow.snapshot.tabId;
  await service.manageTab({ action: "mark_deliverable", tabId: agentTabId });
  await service.manageTab({ action: "mark_handoff", tabId: listedUserTab.id });

  const firstCleanup = await service.manageTab({ action: "cleanup" });
  assert.ok(firstCleanup.closed.includes(newWindowTabId));
  assert.ok(firstCleanup.closed.includes(popup.id));
  assert.ok(firstCleanup.preserved.some((entry) => entry.tabId === agentTabId && entry.mark === "deliverable"));
  assert.ok(firstCleanup.preserved.some((entry) => entry.tabId === listedUserTab.id && entry.mark === "handoff"));

  const secondCleanup = await service.manageTab({ action: "cleanup" });
  assert.ok(secondCleanup.closed.includes(agentTabId));
  assert.ok(secondCleanup.released.includes(listedUserTab.id));
  const releasedUserTab = (await service.listTabs()).find((tab) => tab.id === listedUserTab.id);
  assert.equal(releasedUserTab?.controlled, false);
  assert.equal(releasedUserTab?.ownership, "user");
  await waitUntil(
    () => readOverlay(userPage).then((overlay) => overlay === null, () => false),
    10_000,
    "claimed-tab aura cleanup",
  );

  console.log("browser integration test passed");
} finally {
  if (originalClipboard !== undefined && service?.status().connected) {
    await service.clipboard({ action: "write_text", text: originalClipboard }).catch(() => undefined);
  }
  await context?.close().catch(() => undefined);
  await service?.close().catch(() => undefined);
  await new Promise((resolve) => testServer.close(() => resolve()));
  await rm(temporaryRoot, { recursive: true, force: true });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Test server did not expose a TCP port."));
      else resolve(address.port);
    });
  });
}

async function availablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function findBrowserExecutable() {
  const candidates = [
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const playwrightDirectory = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const revisions = await readdir(playwrightDirectory, { withFileTypes: true }).catch(() => []);
  for (const revision of revisions) {
    if (revision.isDirectory() && revision.name.startsWith("chromium-")) {
      candidates.unshift(path.join(playwrightDirectory, revision.name, "chrome-win64", "chrome.exe"));
    }
  }
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error("No Chrome or Chromium executable is available for the browser integration test.");
}

async function closeExtensionServiceWorker(debuggingPort) {
  const targetsUrl = `http://127.0.0.1:${debuggingPort}/json/list`;
  const targets = await waitUntil(
    async () => {
      const result = await fetch(targetsUrl).then((response) => response.json()).catch(() => []);
      return Array.isArray(result) && result.length > 0 ? result : undefined;
    },
    5_000,
    "Chrome debugging endpoint",
  );
  const serviceWorker = targets.find(
    (target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"),
  );
  assert.ok(serviceWorker, "Chrome extension service worker target was not found");
  const response = await fetch(`${targetsUrl.slice(0, -4)}close/${serviceWorker.id}`, { method: "PUT" });
  assert.equal(response.ok, true, `Could not stop extension service worker: ${response.status}`);
}

async function waitUntil(check, timeoutMs, description) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function readOverlay(page) {
  return await page.evaluate(() => {
    const host = document.getElementById("__local-codex-control-overlay");
    if (!(host instanceof HTMLElement)) return null;
    return {
      controlled: host.dataset.localCodexControl,
      pointerX: host.dataset.pointerX,
      pointerY: host.dataset.pointerY,
      clickCount: host.dataset.clickCount,
    };
  });
}
