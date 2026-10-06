import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Voice button labels observed in the account's Chrome session on October 5, 2026.
const url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
	const page = await browser.newPage();
	await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
		<main></main><div data-composer-body><div contenteditable="true" data-composer-markdown aria-label="Ask ChatGPT"></div>
		<button aria-label="Stop">Stop text generation</button><button aria-label="Start Voice">Voice</button></div>` }));
	await page.goto(url);
	await page.clock.install();
	await page.evaluate(() => {
		globalThis.__localCodexSupportInstalled = { version: "1.11.0" };
		globalThis.voiceListener = (_message, _sender, reply) => reply({ ok: false, error: "The stale page handler is still active." });
		globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener(listener) { globalThis.voiceListener = listener; } } },
			storage: { local: { get: async () => ({ automationPausedUntil: Date.now() + 300_000 }) } } };
		globalThis.startClicks = 0;
		globalThis.endClicks = 0;
		globalThis.textStopClicks = 0;
		document.querySelector('button[aria-label="Stop"]').onclick = () => globalThis.textStopClicks++;
		document.querySelector('button[aria-label="Start Voice"]').onclick = event => {
			globalThis.startClicks++;
			event.target.remove();
			setTimeout(() => {
				const end = document.createElement("button");
				end.setAttribute("aria-label", "End Voice");
				end.textContent = "End";
				end.onclick = () => {
					globalThis.endClicks++;
					if (globalThis.ignoreEnd) return;
					end.remove();
					const start = document.createElement("button");
					start.setAttribute("aria-label", "Start Voice");
					document.body.appendChild(start);
				};
				document.body.appendChild(end);
			}, 1000);
		};
	});
	await page.addScriptTag({ content: await readFile("support-extension/content-script.js", "utf8") });
	const begin = kind => page.evaluate(({ kind, url }) => {
		globalThis.voiceResult = null;
		globalThis.voiceListener({ type: "local-codex-support/automation-v1", command: { kind, feature: "voice", targetUrl: url } }, {},
			result => { globalThis.voiceResult = result; });
	}, { kind, url });
	const result = () => page.evaluate(() => globalThis.voiceResult);
	await begin("voice_status");
	await page.clock.runFor(100);
	assert.equal((await result()).ok, true, "injecting the updated extension replaces the previously installed page handler");
	assert.equal((await result()).result.status, "closed");
	await page.evaluate(() => {
		const start = document.querySelector('button[aria-label="Start Voice"]');
		start.hidden = true;
		setTimeout(() => { start.hidden = false; }, 1000);
	});
	await begin("voice_start");
	await page.clock.runFor(500);
	assert.equal(await result(), null, "a newly loaded chat waits for its Voice control instead of failing during hydration");
	await page.clock.runFor(2500);
	assert.deepEqual(await result(), { ok: true, result: { status: "active", conversationUrl: url } });
	await begin("voice_start");
	await page.clock.runFor(100);
	assert.equal((await result()).result.status, "active");
	assert.equal(await page.evaluate(() => globalThis.startClicks), 1, "another wake cannot toggle an active call off");
	await page.evaluate(() => { globalThis.ignoreEnd = true; });
	await begin("voice_stop");
	await page.clock.runFor(30_100);
	assert.equal((await result()).ok, false, "a failed end click cannot report the call closed");
	assert.match((await result()).error, /did not confirm Voice closed/);
	await page.evaluate(() => { globalThis.ignoreEnd = false; });
	await begin("voice_stop");
	await page.clock.runFor(1000);
	assert.equal((await result()).result.status, "closed", "ending Voice works during the automation pause");
	assert.equal(await page.evaluate(() => globalThis.textStopClicks), 0, "Voice stop never cancels a text generation");
	await begin("voice_stop");
	await page.clock.runFor(100);
	assert.equal((await result()).result.status, "closed");
	assert.equal(await page.evaluate(() => globalThis.endClicks), 2);
	await page.evaluate(() => { document.querySelector('button[aria-label="Start Voice"]').hidden = true; });
	await begin("voice_stop");
	await page.clock.runFor(30_100);
	assert.equal((await result()).ok, false, "missing Voice controls cannot be treated as a closed call");
	await begin("voice_status");
	await page.clock.runFor(100);
	assert.equal((await result()).result.status, "unavailable");
	await page.evaluate(() => history.replaceState({}, "", location.pathname + "?temporary-chat=true"));
	await begin("voice_start");
	await page.clock.runFor(100);
	assert.equal((await result()).ok, false, "a navigated or temporary page cannot receive Voice commands");
	console.log("Voice DOM passed: observed state transitions, duplicate wakes, ignored end click, pause bypass, text-stop isolation, missing controls, and navigation rejection.");
} finally { await browser.close(); }
