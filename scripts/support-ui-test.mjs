import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 560, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const parentId = "11111111-1111-4111-8111-111111111111";
  const reviewId = "22222222-2222-4222-8222-222222222222";
  const parentUrl = `https://chatgpt.com/c/${parentId}`;
  const reviewUrl = `https://chatgpt.com/c/${reviewId}`;
  const thread = { threadId: parentId, conversationUrl: parentUrl, title: "Implement feature", state: "active", mode: "continuous", waitingForTask: true, registeredAt: new Date().toISOString(), nextCheckAt: Date.now() + 1800_000 };
  const task = { jobId: reviewId, childThreadId: reviewId, childConversationUrl: reviewUrl + "?temporary-chat=true", parentThreadId: parentId, title: "Independent PR task", resultPath: "D:\\workspace\\task.md", state: "pending" };
  const ready = { ...thread, threadId: "33333333-3333-4333-8333-333333333333", conversationUrl: "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333", title: "Recent completion", waitingForTask: false, activity: "idle", attentionAt: "2026-10-04T02:00:00Z" };
  const older = { ...ready, threadId: "44444444-4444-4444-8444-444444444444", title: "Earlier completion", attentionAt: "2026-10-04T01:00:00Z", agentCreated: true };
  const settled = { ...ready, threadId: "55555555-5555-4555-8555-555555555555", title: "Old closed tab", settledAt: "2026-10-03T12:00:00Z" };
  let settingsRequests = 0;
  let cancelled = false;
  let automationPausedUntil = 0;
  await page.addInitScript(() => {
    globalThis.closedViews = 0;
    globalThis.openedPanels = [];
    globalThis.close = () => { globalThis.closedViews += 1; };
    globalThis.chrome = {
      storage: { local: { async get(defaults) { return defaults; }, async set() {}, async remove() {} } },
      runtime: { async sendMessage() {} },
      sidePanel: { async open(options) { globalThis.openedPanels.push(options); } },
      tabs: { async query() { return [{ id: 7, windowId: 3, url: "https://example.com" }]; }, async create() {}, async update() {} },
    };
  });
  await page.route("http://127.0.0.1:19999/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    let data;
    if (pathname === "/chatgpt-support/ralph/threads") data = { threads: [older, thread, ready, settled, { ...thread, threadId: reviewId, activity: "running", waitingForTask: false }], tasks: [task], automationPausedUntil };
    else if (pathname === "/chatgpt-support/ralph/settings") { settingsRequests += 1; data = { loopIntervalSeconds: 1800 }; }
    else if (pathname === "/chatgpt-support/ralph/projects") data = { projects: [] };
    else if (pathname === `/chatgpt-support/tasks/${reviewId}`) {
      assert.equal(route.request().postDataJSON().action, "cancel");
      cancelled = true;
      task.state = "cancelled";
      thread.waitingForTask = false;
      data = { status: "accepted" };
    }
    if (data) { await route.fulfill({ json: data }); return; }
    if (pathname === "/config.js") {
      const endpoint = suffix => `http://127.0.0.1:19999/chatgpt-support/ralph/${suffix}`;
      await route.fulfill({ contentType: "text/javascript", body: `globalThis.LOCAL_CODEX_THREAD_SYNC = ${JSON.stringify({ extensionToken: "test-token", ralphProjectsUrl: endpoint("projects"), ralphRegisterUrl: endpoint("register"), ralphSettingsUrl: endpoint("settings"), ralphThreadsUrl: endpoint("threads") })};` });
      return;
    }
    const file = pathname.slice(1);
    if (!["popup.html", "popup.js", "popup.css"].includes(file)) { await route.abort(); return; }
    await route.fulfill({ contentType: file.endsWith("html") ? "text/html" : file.endsWith("css") ? "text/css" : "text/javascript", body: await readFile(`support-extension/${file}`, "utf8") });
  });
  await page.goto("http://127.0.0.1:19999/popup.html");
  await page.locator("#readyCount").getByText("2", { exact: true }).waitFor();
  assert.deepEqual(await page.locator("#threadList .thread-id").allTextContents(), ["Recent completion", "Earlier completion"]);
  assert.equal(await page.locator("#workingSection").getAttribute("open"), null, "running work is collapsed by default");
  assert.equal(await page.locator("#workingCount").textContent(), "1");
  assert.equal(await page.locator("#settledCount").textContent(), "1");
  await page.locator("#workingSection summary").click();
  await page.locator("#subagentThreadsSection summary").click();
  await page.getByText("waiting for task", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Check now", exact: true }).count(), 0);
  assert.equal(settingsRequests, 0, "opening the thread view does not fetch settings");
  const reviewLink = page.locator('#subagentThreadList a.inspect-task');
  assert.equal(await reviewLink.textContent(), "Inspect");
  assert.equal(await reviewLink.getAttribute("href"), task.childConversationUrl, "worker inspection preserves temporary chat mode");
  assert.equal(await page.getByText(task.resultPath, { exact: true }).count(), 0,
    "RALPH does not substitute the local result file for worker navigation");
  await mkdir(".data", { recursive: true });
  await page.screenshot({ path: ".data/worker-popup.png", fullPage: true });
  await page.getByRole("button", { name: "Sidebar", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.openedPanels), [{ windowId: 3 }]);
  assert.equal(await page.evaluate(() => globalThis.closedViews), 1);
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.locator("#ralphLoopIntervalSeconds").waitFor({ state: "visible" });
  assert.equal(await page.locator("#ralphLoopIntervalSeconds").inputValue(), "1800");
  assert.equal(settingsRequests, 1);
  await page.getByRole("tab", { name: "Tasks and threads", exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  assert.equal(settingsRequests, 1, "switching tabs reuses loaded settings");
  await page.getByRole("tab", { name: "Tasks and threads", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await page.locator("#subagentThreadsSection").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Run continuously", exact: true }).count(), 0);
  assert.equal(cancelled, true);
  await page.goto("http://127.0.0.1:19999/popup.html?view=sidepanel");
  await page.locator("#threadList .thread-id").first().waitFor();
  assert.equal(await page.locator("#openSidePanel").isVisible(), false);
  await page.getByRole("link", { name: /Recent completion/ }).click();
  assert.equal(await page.evaluate(() => globalThis.closedViews), 0, "the sidebar remains open during inspection");
  thread.activity = "running";
  ready.settledAt = new Date().toISOString();
  await page.locator("#readyCount").getByText("1", { exact: true }).waitFor();
  assert.equal(await page.locator("#threadList .thread-id").textContent(), "Earlier completion", "the sidebar updates without Refresh");
  await page.getByRole("searchbox", { name: "Search threads" }).fill("Implement");
  await page.locator("#workingSection summary").click();
  await page.getByText("running", { exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Search threads" }).fill("");
  automationPausedUntil = Date.now() + 300_000;
  await page.locator("#refreshThreads").click();
  await page.locator('#connection[data-state="paused"]').waitFor();
  assert.equal(await page.locator("#connectionLabel").textContent(), "Paused");
  assert.match(await page.locator("#threadsStatus").textContent(), /Tasks stay queued.*resumes at/);
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "the pause indicator fits the narrow sidebar");
  await page.screenshot({ path: ".data/global-pause-sidebar.png", fullPage: true });
  automationPausedUntil = 0;
  await page.locator("#refreshThreads").click();
  await page.locator('#connection[data-state="online"]').waitFor();
  assert.equal(await page.locator("#connectionLabel").textContent(), "Connected");
  await page.screenshot({ path: ".data/thread-sidebar.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("Support UI passed: completion ordering, collapsed work, separate tasks, settlement, live updates, search, popup/sidebar navigation, and lazy settings. API responses were fixtures.");
} finally { await browser.close(); }
