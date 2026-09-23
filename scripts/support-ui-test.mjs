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
  const thread = { threadId: parentId, conversationUrl: parentUrl, title: "Implement feature", state: "active", mode: "continuous", waitingForReview: true, registeredAt: new Date().toISOString(), nextCheckAt: Date.now() + 180000 };
  const review = { jobId: reviewId, childConversationUrl: reviewUrl, parentThreadId: parentId, title: "Independent PR review", resultPath: "D:\\workspace\\review.md", state: "pending", preparationError: "message channel closed" };
  const operationId = "33333333-3333-4333-8333-333333333333";
  const operation = { id: operationId, label: "Start reviewer", targetUrl: "https://chatgpt.com/", state: "cooldown", kind: "send_message", feature: "threadMessaging", createdAt: new Date().toISOString() };
  let settingsRequests = 0;
  let cancelled = false;
  let parentCompleted = false;
  let operationStopped = false;
  await page.addInitScript(() => {
    globalThis.chrome = {
      storage: { local: { async get(defaults) { return defaults; }, async set() {}, async remove() {} } },
      runtime: { async sendMessage(message) { globalThis.__runtimeMessages ??= []; globalThis.__runtimeMessages.push(message); return { ok: true, active: true }; } },
      tabs: { async query() { return []; }, async create() {}, async update() {} },
    };
  });
  await page.route("http://127.0.0.1:19999/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    let data;
    if (pathname === "/chatgpt-support/ralph/threads") data = { threads: [thread], reviews: [review], operations: operationStopped ? [] : [operation] };
    else if (pathname === "/chatgpt-support/ralph/settings") { settingsRequests += 1; data = { loopIntervalSeconds: 180 }; }
    else if (pathname === "/chatgpt-support/ralph/projects") data = { projects: [] };
    else if (pathname === `/chatgpt-support/commands/${operationId}/cancel`) {
      operationStopped = true;
      data = { status: "cancelled" };
    }
    else if (pathname === `/chatgpt-support/ralph/threads/${parentId}/complete`) {
      parentCompleted = true;
      thread.state = "complete";
      thread.waitingForReview = false;
      data = { threadId: parentId, state: "complete" };
    }
    else if (pathname === `/chatgpt-support/reviews/${reviewId}`) {
      assert.equal(route.request().postDataJSON().action, "cancel");
      cancelled = true;
      review.state = "cancelled";
      review.notifiedAt = new Date().toISOString();
      thread.waitingForReview = false;
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
  await page.getByText("waiting for review", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Check now", exact: true }).count(), 0);
  const parentCard = page.locator("#threadList .thread");
  assert.equal(await parentCard.getByRole("button", { name: "Mark complete", exact: true }).count(), 1,
    "a parent waiting for review can still be marked complete");
  const reviewCard = page.locator("#subagentThreadList .thread");
  assert.equal(await reviewCard.getByRole("button", { name: "Cancel review", exact: true }).count(), 1,
    "an errored review can still be cancelled");
  assert.equal(await reviewCard.getByRole("button", { name: "Mark complete", exact: true }).count(), 1,
    "an errored review can be marked complete without waiting for recovery");
  const operationCard = page.locator("#automationOperationList .thread");
  await operationCard.getByText("Start reviewer", { exact: true }).waitFor();
  await operationCard.getByText("Waiting to retry", { exact: true }).waitFor();
  await operationCard.getByRole("button", { name: "Stop", exact: true }).click();
  assert.equal(operationStopped, true, "queued reviewer retries are visible and stoppable");
  await page.locator("#automationOperationsSection").waitFor({ state: "hidden" });
  assert.equal(settingsRequests, 0, "opening the thread view does not fetch settings");
  const reviewLink = page.locator('#subagentThreadList a.thread-url');
  assert.equal(await reviewLink.textContent(), reviewUrl, "RALPH renders the exact reviewer conversation URL");
  assert.equal(await reviewLink.getAttribute("href"), reviewUrl, "the visible reviewer URL opens the reviewer conversation");
  assert.equal(await page.getByText(review.resultPath, { exact: true }).count(), 0,
    "RALPH does not substitute the local result file for reviewer navigation");
  await mkdir(".data", { recursive: true });
  await page.screenshot({ path: ".data/reviewer-popup.png", fullPage: true });
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.locator("#ralphLoopIntervalSeconds").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("ralphLoopIntervalSeconds").value === "180");
  assert.equal(settingsRequests, 1);
  await page.getByRole("tab", { name: "RALPH threads", exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  assert.equal(settingsRequests, 1, "switching tabs reuses loaded settings");
  await page.getByRole("tab", { name: "RALPH threads", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#threadList").getByRole("button", { name: "Mark complete", exact: true }).click();
  assert.equal(parentCompleted, true, "marking the blocked parent complete reaches the backend");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Cancel review", exact: true }).click();
  assert.equal(cancelled, true);
  await page.getByRole("button", { name: "Completed", exact: true }).click();
  await page.getByText("Cancelled", { exact: true }).waitFor();
  assert.deepEqual(errors, []);

  const controlPage = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await controlPage.setContent("<!doctype html><html><head><title>ChatGPT</title></head><body></body></html>");
  await controlPage.evaluate(() => {
    globalThis.__automationListener = null;
    globalThis.chrome = {
      runtime: {
        async sendMessage() { return { ok: true }; },
        onMessage: { addListener(listener) { globalThis.__automationListener = listener; } },
      },
      storage: { local: { async get(defaults) { return defaults; }, async set() {} } },
    };
  });
  await controlPage.addScriptTag({ path: "support-extension/content-script.js" });
  await controlPage.evaluate(() => {
    globalThis.__automationResult = new Promise((resolve) => {
      globalThis.__automationListener({
        type: "local-codex-support/automation-v1",
        command: { id: "operation-test", kind: "send_message", operationLabel: "Start reviewer", message: "review" },
      }, {}, resolve);
    });
  });
  const control = controlPage.locator("#__local-codex-support-automation");
  await control.getByText("Local Codex: Start reviewer", { exact: true }).waitFor();
  await control.getByRole("button", { name: "Stop", exact: true }).click();
  const stoppedResult = await controlPage.evaluate(() => globalThis.__automationResult);
  assert.equal(stoppedResult.ok, false);
  assert.match(stoppedResult.error, /stopped by user/i);
  await control.waitFor({ state: "detached" });
  await controlPage.close();

  console.log("Support popup passed: blocked parents and reviewers stay controllable, queued retries are stoppable, and active page automation exposes Stop.");
} finally { await browser.close(); }
