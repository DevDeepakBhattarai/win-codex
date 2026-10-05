import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { prepareThreadSync } from "../dist/thread-sync.js";

// Load the generated package with its real config in a disposable MV3 profile.
// Branded Chrome disables unpacked-extension command-line loading. Use Playwright Chromium.
const directory = await mkdtemp(path.join(os.tmpdir(), "support-action-"));
const server = createServer((req, res) => {
	if (req.url === "/chatgpt-support/commands/claim") { res.writeHead(204).end(); return; }
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ threads: [], tasks: [], continuationEnabled: false }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let context;
try {
	const sync = await prepareThreadSync(directory, server.address().port);
	context = await chromium.launchPersistentContext(path.join(directory, "profile"), {
		executablePath: process.env.SUPPORT_TEST_CHROMIUM ?? chromium.executablePath(), headless: true,
		args: [`--disable-extensions-except=${sync.extensionDirectory}`, `--load-extension=${sync.extensionDirectory}`],
	});
	const worker = context.serviceWorkers().find(worker => worker.url().endsWith("/service-worker.js"))
		?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
	const extensionId = new URL(worker.url()).host;
	// Poll the asynchronous startup write without setting the behavior in the test.
	let behavior;
	for (let attempt = 0; attempt < 20; attempt++) {
		behavior = await worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
		if (behavior.openPanelOnActionClick) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.equal(behavior.openPanelOnActionClick, true, "the actual MV3 startup enables direct toolbar opening");
	assert.equal(await worker.evaluate(() => chrome.action.getPopup({})), "", "the toolbar has no popup");
	assert.deepEqual(await worker.evaluate(() => chrome.sidePanel.getOptions({})), {
		enabled: true, path: "popup.html?view=sidepanel",
	});
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/popup.html?view=sidepanel`);
	await page.getByRole("tab", { name: "Threads", exact: true }).waitFor();
	assert.equal(await page.locator("body").getAttribute("data-view"), "sidepanel");
	console.log("Support action passed in actual MV3 Chromium: generated config, startup behavior, no popup, configured side panel, and sidebar page. Native toolbar click requires browser UI interaction.");
} finally {
	await context?.close();
	await new Promise(resolve => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
