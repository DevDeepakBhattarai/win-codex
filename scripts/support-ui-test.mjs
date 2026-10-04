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
  const thread = { threadId: parentId, conversationUrl: parentUrl, title: "Implement feature", state: "active", mode: "continuous", waitingForTask: true, registeredAt: new Date().toISOString(), nextCheckAt: Date.now() + 180000 };
  const task = { jobId: reviewId, childConversationUrl: reviewUrl, parentThreadId: parentId, title: "Independent PR task", resultPath: "D:\\workspace\\task.md", state: "pending" };
  let settingsRequests = 0;
  let cancelled = false;
  await page.addInitScript(() => {
    globalThis.chrome = {
      storage: { local: { async get(defaults) { return defaults; }, async set() {}, async remove() {} } },
      runtime: { async sendMessage() {} },
      tabs: { async query() { return []; }, async create() {}, async update() {} },
    };
  });
  await page.route("http://127.0.0.1:19999/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    let data;
    if (pathname === "/chatgpt-support/ralph/threads") data = { threads: [thread], tasks: [task] };
    else if (pathname === "/chatgpt-support/ralph/settings") { settingsRequests += 1; data = { loopIntervalSeconds: 180 }; }
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
  await page.getByText("waiting for task", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Check now", exact: true }).count(), 0);
  assert.equal(settingsRequests, 0, "opening the thread view does not fetch settings");
  const reviewLink = page.locator('#subagentThreadList a.thread-url');
  assert.equal(await reviewLink.textContent(), reviewUrl, "RALPH renders the exact worker conversation URL");
  assert.equal(await reviewLink.getAttribute("href"), reviewUrl, "the visible worker URL opens the worker conversation");
  assert.equal(await page.getByText(task.resultPath, { exact: true }).count(), 0,
    "RALPH does not substitute the local result file for worker navigation");
  await mkdir(".data", { recursive: true });
  await page.screenshot({ path: ".data/worker-popup.png", fullPage: true });
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.locator("#subagentProjectUrl").waitFor({ state: "visible" });
  assert.equal(await page.locator("#ralphLoopIntervalSeconds").isVisible(), false, "bounded tasks do not expose continuation controls");
  assert.equal(settingsRequests, 1);
  await page.getByRole("tab", { name: "Tasks and threads", exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  assert.equal(settingsRequests, 1, "switching tabs reuses loaded settings");
  await page.getByRole("tab", { name: "Tasks and threads", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await page.getByRole("button", { name: "Completed", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Run continuously", exact: true }).count(), 0);
  assert.equal(cancelled, true);
  await page.getByRole("button", { name: "Completed", exact: true }).click();
  await page.getByText("Cancelled", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Support popup passed: paused parent, task cancellation, completed reports, and lazy settings. All API responses were local fixtures.");
} finally { await browser.close(); }
