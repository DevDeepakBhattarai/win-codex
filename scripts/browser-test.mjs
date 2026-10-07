import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { createBrowserService } from "../dist/browser.js";
import { launchChrome } from "../dist/browser-launch.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "win-codex-browser-test-"));
const uploadPath = path.join(temporaryRoot, "upload.txt");
await writeFile(uploadPath, "browser upload test", "utf8");

const testServer = http.createServer((request, response) => {
  if (request.url === "/favicon.svg" || request.url === "/updated.svg") {
    response.writeHead(200, { "content-type": "image/svg+xml" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="green"/></svg>');
    return;
  }
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
    response.end('<!doctype html><title>User tab</title><link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="32x32"><h1>User tab</h1>');
    return;
  }
  if (request.url === "/csp") {
    response.writeHead(200, { "content-type": "text/html", "content-security-policy": "img-src 'self'" });
    response.end('<!doctype html><title>CSP</title><link rel="icon" href="/favicon.svg"><h1>Restricted images</h1>');
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
    <input id="text" aria-label="Text">
    <input id="checked" type="checkbox">
    <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
    <button id="hover" onmouseenter="this.textContent='Hovered'">Hover me</button>
    <div id="drag" style="width:200px;height:60px;background:#eee" onmousedown="this.textContent='Dragging'" onmouseup="this.textContent='Dropped'">Drag here</div>
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
try {
  const pagePort = await listen(testServer);
  const bridgePort = await availablePort();
  const debuggingPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${pagePort}`;
  const dataDirectory = path.join(temporaryRoot, "bridge");
  const extensionDirectory = path.join(dataDirectory, "browser-extension");

  const executablePath = await findBrowserExecutable();
  let launchAttempts = 0;
  let failLaunch = true;
  const launchBrowser = async () => {
    launchAttempts += 1;
    if (failLaunch) {
      await launchChrome({ executablePath: path.join(temporaryRoot, "missing-chrome") });
      return;
    }
    context = await chromium.launchPersistentContext(path.join(temporaryRoot, "profile"), {
      executablePath,
      headless: false,
      args: [
        "--mute-audio",
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
        `--remote-debugging-port=${debuggingPort}`,
      ],
    });
  };
  service = await createBrowserService({ dataDirectory, port: bridgePort, launchBrowser });
  assert.equal(service.status().connected, false);
  assert.equal(launchAttempts, 0, "status must not launch Chrome");
  const failedStarts = await Promise.allSettled([service.open({ url: baseUrl }), service.listTabs()]);
  for (const result of failedStarts) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /Could not start Chrome/);
  }
  assert.equal(launchAttempts, 1, "concurrent failures must share one launch attempt");
  failLaunch = false;
  const [startupA, startupB] = await Promise.all([
    service.open({ url: `${baseUrl}/?task=A`, active: false }),
    service.open({ url: `${baseUrl}/?task=B`, active: false }),
    service.listTabs(),
  ]);
  assert.equal(launchAttempts, 2, "a failed launch must be retryable and successful calls must share startup");
  const startupTabs = [startupA.snapshot.tabId, startupB.snapshot.tabId];
  assert.notEqual(...startupTabs);
  const tabsBeforeReuse = (await service.listTabs()).map(tab => tab.id).sort();
  await launchChrome({ executablePath, userDataDirectory: path.join(temporaryRoot, "profile") });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual((await service.listTabs()).map(tab => tab.id).sort(), tabsBeforeReuse,
    "the real launcher must reuse a running Chrome profile without creating another tab");
  const concurrentClicks = await Promise.all(startupTabs.map(tabId => service.action({ tabId, action: "dblclick", locator: "css=#double" })));
  for (const result of concurrentClicks) assert.match(result.snapshot.visibleText, /Double count: 1/);
  await Promise.all(startupTabs.map((tabId, index) => service.action({ tabId, action: "type", locator: "css=#text", text: `task ${index}` })));
  const typed = await Promise.all(startupTabs.map(tabId => service.evaluate(tabId, 'document.querySelector("#text").value')));
  assert.deepEqual(typed.map(result => result.value), ["task 0", "task 1"]);
  const cspTab = await service.open({ url: `${baseUrl}/csp`, active: false });
  await assertControlFavicon(context, cspTab.snapshot.tabId);
  await service.action({ tabId: cspTab.snapshot.tabId, action: "close" });
  for (const tabId of startupTabs) await service.action({ tabId, action: "close" });

  // Exercise the native executable launcher without touching the user's profile.
  await launchChrome({ executablePath, userDataDirectory: path.join(temporaryRoot, "profile") });
  assert.equal(service.status().connected, true);

  console.log("automatic startup, launch retry, and concurrent background tabs passed");

  await waitUntil(() => service.status().connected, 15_000, "extension connection");
  await service.close();
  service = undefined;
  await closeExtensionServiceWorker(debuggingPort);
  service = await createBrowserService({
    dataDirectory,
    port: bridgePort,
    launchBrowser,
  });
  await waitUntil(() => service.status().connected, 5_000, "extension reconnection after server restart");

  const userPage = context.pages()[0];
  await userPage.goto(`${baseUrl}/user`);

  // A reused call can create native peers before the Voice observer loads.
  await userPage.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Voice reuse fixture</title>" }));
  await userPage.goto("https://chatgpt.com/?model=auto");
  await userPage.evaluate(async () => {
    const sender = new RTCPeerConnection();
    const receiver = new RTCPeerConnection();
    const speaker = new Audio();
    receiver.ontrack = event => { speaker.srcObject = event.streams[0]; void speaker.play(); };
    sender.onicecandidate = event => { if (event.candidate) void receiver.addIceCandidate(event.candidate); };
    receiver.onicecandidate = event => { if (event.candidate) void sender.addIceCandidate(event.candidate); };
    const audio = new AudioContext();
    await audio.resume();
    const oscillator = audio.createOscillator();
    const output = audio.createMediaStreamDestination();
    oscillator.connect(output);
    oscillator.start();
    sender.addTrack(output.stream.getAudioTracks()[0], output.stream);
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    window.voiceFixture = { sender, receiver, audio, oscillator, speaker };
    window.voiceActivity = [];
    window.addEventListener("message", event => {
      if (event.data?.type === "local-codex-voice-activity-v1") window.voiceActivity.push(event.data);
    });
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("No microphone needed in loopback fixture"); };
  });
  await userPage.addScriptTag({ content: await readFile(process.argv[2] ?? "support-extension/voice-audio.js", "utf8") });
  await userPage.evaluate(() => window.postMessage({ type: "local-codex-voice-monitor-v1", active: true }, location.origin));
  const voiceTab = (await service.listTabs()).find(tab => tab.url === "https://chatgpt.com/?model=auto");
  assert.ok(voiceTab);
  await service.observeVoiceAudio(voiceTab.id, "https://chatgpt.com/");
  try {
    await waitUntil(() => userPage.evaluate(() => window.voiceActivity.some(event => event.assistantSpeaking)), 10_000, "playback from a native peer created before observer injection");
  } catch (error) {
    console.error(await userPage.evaluate(async () => ({
      audioState: window.voiceFixture.audio.state,
      sender: window.voiceFixture.sender.connectionState,
      receiver: window.voiceFixture.receiver.connectionState,
      stats: [...(await window.voiceFixture.receiver.getStats()).values()].filter(report => report.type === "inbound-rtp"),
      activity: window.voiceActivity.slice(-2),
    })));
    throw error;
  }
  assert.equal((await service.listTabs()).find(tab => tab.id === voiceTab.id).ownership, "user", "audio discovery does not claim the user's Voice tab");
  await assert.rejects(service.observeVoiceAudio(voiceTab.id, "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111"), /navigated away/);
  await userPage.evaluate(async () => {
    window.postMessage({ type: "local-codex-voice-monitor-v1", active: false }, location.origin);
    window.voiceFixture.sender.close();
    window.voiceFixture.receiver.close();
    window.voiceFixture.oscillator.stop();
    await window.voiceFixture.audio.close();
  });
  await userPage.unroute("https://chatgpt.com/**");
  await userPage.goto(`${baseUrl}/user`);
  console.log("Voice reuse passed: existing native WebRTC playback observed without claiming or refreshing the tab");

  let result = await service.open({ url: baseUrl, active: true });
  const agentTabId = result.snapshot.tabId;
  assert.equal(launchAttempts, 2, "connected Chrome must be reused");
  assert.equal((await service.snapshot(undefined, false)).snapshot.tabId, agentTabId);
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
  await assertControlFavicon(context, agentTabId);

  // These assertions exercise extension CDP delivery against real rendered controls.
  const originalEncoder = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join(temporaryRoot, "missing-ffmpeg");
  await assert.rejects(service.recording({ action: "start", tabId: agentTabId }), /requires FFmpeg/);
  if (originalEncoder === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = originalEncoder;
  const recording = await service.recording({ action: "start", tabId: agentTabId });
  assert.equal(recording.status, "recording");
  await service.action({ tabId: agentTabId, action: "hover", locator: "css=#hover" });
  assert.equal((await service.evaluate(agentTabId, 'document.querySelector("#hover").textContent')).value, "Hovered");
  await service.action({ tabId: agentTabId, action: "select", locator: "css=#choice", values: ["b"] });
  assert.equal((await service.evaluate(agentTabId, 'document.querySelector("#choice").value')).value, "b");
  await assert.rejects(service.action({ tabId: agentTabId, action: "select", locator: "css=#choice", values: ["absent"] }), /missing or disabled/);
  for (const checked of [true, true, false]) {
    await service.action({ tabId: agentTabId, action: "check", locator: "css=#checked", checked });
    assert.equal((await service.evaluate(agentTabId, 'document.querySelector("#checked").checked')).value, checked);
  }
  const dragRect = (await service.evaluate(agentTabId, 'JSON.stringify(document.querySelector("#drag").getBoundingClientRect().toJSON())')).value;
  const rect = JSON.parse(dragRect);
  await service.action({ tabId: agentTabId, action: "drag", path: [{ x: rect.x + 5, y: rect.y + 5 }, { x: rect.x + 100, y: rect.y + 10 }] });
  assert.equal((await service.evaluate(agentTabId, 'document.querySelector("#drag").textContent')).value, "Dropped");
  const viewport = await service.viewport({ tabId: agentTabId, width: 390, height: 844 });
  assert.ok(viewport.screenshotData, "responsive results include a real image");
  assert.deepEqual((await service.evaluate(agentTabId, '[innerWidth, innerHeight]')).value, [390, 844]);
  const cropped = await service.screenshot({ tabId: agentTabId, clip: { x: 0, y: 0, width: 200, height: 100 } });
  const png = await readFile(cropped.path);
  assert.equal(png.readUInt32BE(16), 200);
  assert.equal(png.readUInt32BE(20), 100);
  await service.viewport({ tabId: agentTabId });
  await service.evaluate(agentTabId, 'document.body.style.background = "rgb(30, 170, 90)"');
  await new Promise(resolve => setTimeout(resolve, 500));
  const saved = await service.recording({ action: "stop", tabId: agentTabId });
  assert.equal(saved.status, "saved", saved.error);
  const runFile = promisify(execFile);
  const probe = JSON.parse((await runFile("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", saved.path])).stdout);
  assert.equal(probe.streams[0].codec_name, "vp8");
  assert.ok(Number(probe.format.duration) >= 1, "recording preserves elapsed time");
  const decoded = (await runFile(process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-i", saved.path, "-f", "framemd5", "-"])).stdout;
  const hashes = decoded.split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim());
  assert.ok(new Set(hashes).size > 1, "video contains changing rendered frames, not one repeated screenshot");
  await mkdir(path.resolve(".audit-backup", "agent-api"), { recursive: true });
  await copyFile(saved.path, path.resolve(".audit-backup", "agent-api", "browser-test.webm"));
  await copyFile(cropped.path, path.resolve(".audit-backup", "agent-api", "screenshot.png"));
  await service.evaluate(agentTabId, 'document.body.style.minHeight = "1800px"');
  const full = await service.screenshot({ tabId: agentTabId, fullPage: true });
  assert.ok((await readFile(full.path)).readUInt32BE(20) >= 1800, "full-page screenshots include content below the viewport");
  await service.evaluate(agentTabId, 'document.body.style.minHeight = ""');
  const keepDialogOpen = () => {};
  agentPage.on("dialog", keepDialogOpen);
  await service.evaluate(agentTabId, 'setTimeout(() => { document.querySelector("#text").value = prompt("Test prompt", "initial"); }, 100); "scheduled"');
  await waitUntil(async () => (await service.dialog({ tabId: agentTabId, action: "get" })).dialog, 5000, "JavaScript prompt");
  assert.equal((await service.dialog({ tabId: agentTabId, action: "get" })).dialog.type, "prompt");
  await service.dialog({ tabId: agentTabId, action: "accept", text: "Confirmed" });
  assert.equal((await service.evaluate(agentTabId, 'document.querySelector("#text").value')).value, "Confirmed");
  agentPage.off("dialog", keepDialogOpen);

  const clicksBeforeDouble = Number((await readOverlay(agentPage))?.clickCount ?? 0);
  result = await service.action({ tabId: agentTabId, action: "dblclick", locator: "css=#double" });
  assert.match(result.snapshot.visibleText, /Double count: 1/);
  const clickedOverlay = await readOverlay(agentPage);
  assert.equal(Number(clickedOverlay?.clickCount), clicksBeforeDouble + 2);
  assert.ok(Number.isFinite(Number(clickedOverlay?.pointerX)));
  assert.ok(Number.isFinite(Number(clickedOverlay?.pointerY)));
  const screenshotDirectory = path.resolve(".audit-backup", "browser-indicators");
  await mkdir(screenshotDirectory, { recursive: true });
  const session = await context.newCDPSession(agentPage);
  const documentTree = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  const dom = JSON.stringify(documentTree);
  assert.ok(dom.includes('"aura"') && dom.includes('"pointer"'));
  assert.ok(!dom.includes("Codex is controlling this tab") && !dom.includes('"badge"'));
  const pointerImage = findPointerImage(documentTree.root);
  assert.ok(pointerImage, "the animated mouse must contain its image");
  const resolvedImage = await session.send("DOM.resolveNode", { nodeId: pointerImage.nodeId });
  await waitUntil(async () => {
    const imageState = await session.send("Runtime.callFunctionOn", {
      objectId: resolvedImage.object.objectId,
      functionDeclaration: "function() { return this.complete && this.naturalWidth > 0; }",
      returnByValue: true,
    });
    return imageState.result.value;
  }, 5_000, "visible mouse image");
  await agentPage.screenshot({ path: path.join(screenshotDirectory, "controlled-tab.png") });
  await session.detach();

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
  await assertControlFavicon(context, agentTabId);

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

  const tabsBeforeClaim = await service.listTabs();
  const listedUserTab = tabsBeforeClaim.find((tab) => tab.url === `${baseUrl}/user` && !tab.controlled);
  assert.ok(listedUserTab);
  const originalIcons = await readFavicons(userPage);
  await userPage.bringToFront();
  await service.claimTab({
    tabId: listedUserTab.id,
    title: listedUserTab.title,
    url: listedUserTab.url,
  });
  await waitUntil(
    () => readOverlay(userPage).then((overlay) => overlay?.controlled === "true", () => false),
    10_000,
    "claimed-tab control aura",
  );
  await assertControlFavicon(context, listedUserTab.id);
  await service.releaseTab(listedUserTab.id);
  assert.deepEqual(await readFavicons(userPage), originalIcons);
  await waitUntil(async () => (await tabFavicon(context, listedUserTab.id)) === `${baseUrl}/favicon.svg`, 5_000, "restored site favicon");
  await service.listTabs();
  await service.claimTab({ tabId: listedUserTab.id, title: listedUserTab.title, url: listedUserTab.url });
  await userPage.evaluate(() => {
    document.querySelector('link[rel="icon"]').setAttribute("href", "/updated.svg");
  });
  await waitUntil(async () => isControlFavicon((await readFavicons(userPage))[0].href), 5_000, "control favicon after site update");

  const releasedAgentTab = await service.open({ url: `${baseUrl}/second`, active: false });
  const closingVideo = await service.recording({ action: "start", tabId: releasedAgentTab.snapshot.tabId });
  await service.releaseTab(releasedAgentTab.snapshot.tabId);
  await access(closingVideo.path);
  assert.equal(JSON.parse(await readFile(`${closingVideo.path}.json`, "utf8")).status, "saved", "release finalizes the video before closing the tab");
  assert.equal(
    (await service.listTabs()).some((tab) => tab.id === releasedAgentTab.snapshot.tabId),
    false,
    "releasing an agent-opened tab must close it",
  );

  const newWindow = await service.open({ url: `${baseUrl}/second`, active: false, newWindow: true });
  const newWindowTabId = newWindow.snapshot.tabId;
  const popupRelease = await service.releaseTab(popup.id);
  assert.deepEqual(popupRelease, { tabId: popup.id, origin: "opened", closed: true });
  const windowRelease = await service.releaseTab(newWindowTabId);
  assert.deepEqual(windowRelease, { tabId: newWindowTabId, origin: "opened", closed: true });
  const agentRelease = await service.releaseTab(agentTabId);
  assert.deepEqual(agentRelease, { tabId: agentTabId, origin: "opened", closed: true });
  const userRelease = await service.releaseTab(listedUserTab.id);
  assert.deepEqual(userRelease, { tabId: listedUserTab.id, origin: "claimed", closed: false });
  const releasedUserTab = (await service.listTabs()).find((tab) => tab.id === listedUserTab.id);
  assert.equal(releasedUserTab?.controlled, false);
  assert.equal(releasedUserTab?.ownership, "user");
  await waitUntil(
    () => readOverlay(userPage).then((overlay) => overlay === null, () => false),
    10_000,
    "claimed-tab aura cleanup",
  );
  assert.deepEqual(await readFavicons(userPage), [{ ...originalIcons[0], href: "/updated.svg" }]);
  await waitUntil(async () => (await tabFavicon(context, listedUserTab.id)) === `${baseUrl}/updated.svg`, 5_000, "restored updated site favicon");

  await context.close();
  context = undefined;
  await waitUntil(() => !service.status().connected, 5_000, "Chrome shutdown");
  await service.listTabs();
  assert.equal(launchAttempts, 3, "a tab listing must restart closed Chrome");

  const disconnected = await createBrowserService({
    dataDirectory: path.join(temporaryRoot, "disconnected"),
    port: await availablePort(),
    launchBrowser: async () => {},
  });
  try {
    await assert.rejects(disconnected.open({ url: baseUrl }), /extension did not connect within 15 seconds/);
    const interrupted = disconnected.listTabs();
    await disconnected.close();
    await assert.rejects(interrupted, /shutting down/);
  } finally {
    await disconnected.close();
  }

  console.log("browser integration test passed");
} finally {
  await context?.close().catch(() => undefined);
  await service?.close().catch(() => undefined);
  await new Promise((resolve) => testServer.close(() => resolve()));
  const relativeTemp = path.relative(os.tmpdir(), temporaryRoot);
  assert.ok(relativeTemp.startsWith("win-codex-browser-test-") && !relativeTemp.includes(path.sep));
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

async function readFavicons(page) {
  return await page.evaluate(() => [...document.querySelectorAll('link[rel~="icon"]')].map(link => ({
    href: link.getAttribute("href"),
    type: link.getAttribute("type"),
    sizes: link.getAttribute("sizes"),
  })));
}

async function tabFavicon(context, tabId) {
  return await context.serviceWorkers()[0].evaluate(async id => (await chrome.tabs.get(id)).favIconUrl, tabId);
}

async function assertControlFavicon(context, tabId) {
  await waitUntil(async () => isControlFavicon(await tabFavicon(context, tabId)), 5_000, "mouse tab favicon");
}

function isControlFavicon(url) {
  return url?.startsWith("chrome-extension://") && new URL(url).pathname === "/cursor.svg";
}

function findPointerImage(node) {
  if (node.nodeName === "IMG" && node.attributes?.some(value => value.endsWith("/cursor.svg"))) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const image = findPointerImage(child);
    if (image) return image;
  }
}
