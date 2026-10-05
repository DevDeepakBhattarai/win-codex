import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 380, height: 700 }, timezoneId: "Asia/Katmandu" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = id => `https://chatgpt.com/c/${id}`;
  const parentId = "11111111-1111-4111-8111-111111111111";
  const reviewId = "22222222-2222-4222-8222-222222222222";
  const baseThread = { registeredAt: new Date().toISOString(), nextCheckAt: Date.now() + 1800_000 };
  const parent = { ...baseThread, threadId: parentId, conversationUrl: url(parentId), title: "Implement feature", state: "active", waitingForTask: true };
  const active = { ...baseThread, threadId: "33333333-3333-4333-8333-333333333333", conversationUrl: url("33333333-3333-4333-8333-333333333333"), title: "Check remaining work", state: "active", activity: "idle" };
  const legacyActive = { ...active, threadId: "44444444-4444-4444-8444-444444444444", title: "Legacy active with settlement", settledAt: new Date().toISOString() };
  const complete = Array.from({ length: 24 }, (_, index) => ({ ...baseThread,
    threadId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    conversationUrl: url(`00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`),
    title: `Completed task ${index}`, state: "complete", activity: "idle", lastCheckedAt: new Date(Date.now() - index * 60_000).toISOString(),
  }));
  const task = { jobId: reviewId, childThreadId: reviewId, childConversationUrl: url(reviewId) + "?temporary-chat=true", parentThreadId: parentId, title: "Independent review", state: "pending" };
  let settingsRequests = 0;
  let cancelled = false;
  let automationPausedUntil = 0;
  let schedules = [];
  let scheduleRequests = 0;
  await page.addInitScript(() => {
    globalThis.closedViews = 0;
    globalThis.openedChats = [];
    globalThis.close = () => { globalThis.closedViews += 1; };
    globalThis.chrome = {
      storage: { local: { async get(defaults) { return defaults; }, async set() {}, async remove() {} } },
      runtime: { async sendMessage() {} },
      tabs: { async query() { return [{ id: 7, windowId: 3, url: "https://example.com" }]; },
        async create(options) { globalThis.openedChats.push(options.url); }, async update() {} },
    };
  });
  await page.route("http://127.0.0.1:19999/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    let data;
    if (pathname === "/chatgpt-support/ralph/threads") data = { threads: [parent, active, legacyActive, ...complete], tasks: [task], continuationEnabled: true, automationPausedUntil };
    else if (pathname === "/chatgpt-support/ralph/settings") { settingsRequests += 1; data = { loopIntervalSeconds: 1800 }; }
    else if (pathname === "/chatgpt-support/ralph/projects") data = { projects: [] };
    else if (pathname === "/chatgpt-support/schedules") {
      if (route.request().method() === "POST") {
        scheduleRequests++;
        const input = route.request().postDataJSON();
        schedules.push({ ...input, id: "99999999-9999-4999-8999-999999999999", state: "pending" });
        data = { task: schedules.at(-1) };
      } else data = { tasks: schedules };
    } else if (pathname.endsWith("/cancel") && pathname.startsWith("/chatgpt-support/schedules/")) {
      schedules[0].state = "cancelled";
      data = { task: schedules[0] };
    } else if (pathname.startsWith("/chatgpt-support/schedules/") && route.request().method() === "DELETE") {
      schedules = []; data = { status: "removed" };
    } else if (pathname === `/chatgpt-support/tasks/${reviewId}`) {
      assert.equal(route.request().postDataJSON().action, "cancel");
      cancelled = true;
      task.state = "cancelled";
      parent.waitingForTask = false;
      parent.activity = "running";
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
  await page.goto("http://127.0.0.1:19999/popup.html?view=sidepanel");
  await page.locator("#activeCount").getByText("2", { exact: true }).waitFor();
  assert.deepEqual(await page.locator("#threadList .thread-id").allTextContents(), ["Check remaining work", "Legacy active with settlement"]);
  assert.equal(await page.locator("#workingSection").getAttribute("open"), "", "working chats are visible on opening the sidebar");
  assert.equal(await page.locator("#workingCount").textContent(), "1");
  assert.equal(await page.locator("#settledCount").textContent(), "24");
  assert.equal(await page.locator("#panel-threads").getByText("Completed task 0", { exact: true }).count(), 0, "completed chats cannot crowd active work");
  assert.equal(await page.getByRole("button", { name: "Run continuously", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Sidebar", exact: true }).count(), 0);
  assert.equal(settingsRequests, 0);
  assert.equal(await page.locator('#subagentThreadList a.inspect-task').getAttribute("href"), task.childConversationUrl);
  await page.getByRole("link", { name: "Inspect", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.openedChats), [task.childConversationUrl]);
  assert.equal(await page.evaluate(() => globalThis.closedViews), 0);
  await page.getByRole("tab", { name: /Settled/ }).click();
  assert.equal(await page.getByRole("button", { name: "Mark active", exact: true }).count(), 0, "settled cards offer no contradictory active action");
  await page.locator("#settledList .thread-id").last().scrollIntoViewIfNeeded();
  assert.equal(await page.locator("#settledList .thread-id").last().isVisible(), true, "long completed lists remain scrollable");
  assert.ok(await page.locator("main").evaluate(node => node.scrollTop > 0));
  await page.getByRole("searchbox", { name: "Search threads" }).fill("Completed task 23");
  assert.equal(await page.locator("#settledList .thread-id").count(), 1);
  await page.getByRole("searchbox", { name: "Search threads" }).fill("");
  await page.getByRole("tab", { name: "Threads", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await page.locator("#subagentThreadsSection").waitFor({ state: "hidden" });
  assert.equal(cancelled, true);
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("ralphLoopIntervalSeconds").value === "1800");
  assert.equal(settingsRequests, 1);
  await page.getByRole("tab", { name: "Threads", exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  assert.equal(settingsRequests, 1, "settings remain lazy and cached");
  await page.getByRole("tab", { name: "Schedules", exact: true }).click();
  assert.match(await page.locator("#scheduleTimezone").textContent(), /Asia\/(?:Katmandu|Kathmandu)/);
  await page.getByLabel("Prompt", { exact: true }).fill("Run my scheduled check");
  const localTime = await page.evaluate(() => {
    const date = new Date(Date.now() + 3600_000);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  await page.getByLabel("Date and time", { exact: true }).fill(localTime);
  const expectedUtc = await page.evaluate(() => new Date(document.getElementById("scheduleAt").value).toISOString());
  await page.getByRole("button", { name: "Schedule task", exact: true }).click();
  await page.locator("#scheduleList").getByText("Run my scheduled check", { exact: true }).waitFor();
  assert.equal(schedules[0].runAt, expectedUtc, "the local time converts to the selected instant");
  assert.equal(scheduleRequests, 1);
  await page.getByRole("button", { name: "Cancel schedule", exact: true }).click();
  await page.locator("#scheduleList").getByText(/Cancelled/).waitFor();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.locator("#scheduleList .empty").waitFor();
  await page.getByLabel("Prompt", { exact: true }).fill("Do not run in the past");
  await page.getByLabel("Date and time", { exact: true }).fill("2000-01-01T12:00");
  await page.getByRole("button", { name: "Schedule task", exact: true }).click();
  await page.getByText("Choose a future date and time.", { exact: true }).waitFor();
  assert.equal(scheduleRequests, 1, "invalid past schedules never reach the API");
  for (const [amount, unit, seconds, cadence] of [[1, "60", 60, "Every 1 minute"], [1, "3600", 3600, "Every 1 hour"], [7, "60", 420, "Every 7 minutes"]]) {
    await page.getByLabel("Prompt", { exact: true }).fill("Recurring check");
    await page.getByLabel("Date and time", { exact: true }).fill(localTime);
    await page.getByLabel("Repeat", { exact: true }).check();
    await page.getByLabel("Every", { exact: true }).fill(String(amount));
    await page.getByLabel("Unit", { exact: true }).selectOption(unit);
    await page.getByRole("button", { name: "Schedule task", exact: true }).click();
    await page.locator("#scheduleList").getByText(cadence, { exact: false }).waitFor();
    assert.equal(schedules[0].repeatIntervalSeconds, seconds, "repeat interval reaches the server in seconds");
    assert.equal(await page.locator("#scheduleInterval").isVisible(), false, "successful save resets repeat controls");
    schedules[0].state = "sending";
    await page.getByRole("button", { name: "Refresh", exact: true }).last().click();
    await page.locator("#scheduleList").getByText(/^Starting/).waitFor();
    await page.getByRole("button", { name: "Stop repeating", exact: true }).click();
    await page.locator("#scheduleList").getByText(/Cancelled/).waitFor();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.locator("#scheduleList .empty").waitFor();
  }
  assert.equal(scheduleRequests, 4);
  await page.getByRole("tab", { name: "Threads", exact: true }).click();
  active.state = "complete";
  await page.locator("#activeCount").getByText("1", { exact: true }).waitFor();
  assert.equal(await page.locator("#threadList .thread-id").textContent(), "Legacy active with settlement", "completion moves a chat without Refresh");
  automationPausedUntil = Date.now() + 300_000;
  await page.locator("#refreshThreads").click();
  await page.locator('#connection[data-state="paused"]').waitFor();
  await page.setViewportSize({ width: 320, height: 600 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mkdir(".data", { recursive: true });
  await page.screenshot({ path: ".data/thread-sidebar.png", fullPage: true });
  await page.getByRole("tab", { name: "Schedules", exact: true }).click();
  await page.getByLabel("Repeat", { exact: true }).check();
  await page.screenshot({ path: ".data/schedule-sidebar.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("Support UI passed: active and settled separation, scrolling, working tasks, live completion, temporary chat inspection, one-time and minute/hour/custom repeat schedules, cancellation during delivery, timezone conversion, narrow sidebar, and lazy settings. API responses were fixtures.");
} finally { await browser.close(); }
