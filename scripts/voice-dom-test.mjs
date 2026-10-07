import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Voice button labels observed in the account's Chrome session on October 5, 2026.
const url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const localUrl = "https://chatgpt.com/c/local-chatgpt%3A0247af84-32ff-4a12-a96e-59f8fffaba27";
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
			if (globalThis.provisionalUrl) history.replaceState({}, "", globalThis.provisionalUrl);
			event.target.remove();
			setTimeout(() => {
				const end = document.createElement("button");
				end.setAttribute("aria-label", "End Voice");
				end.textContent = "End";
				end.onclick = () => {
					globalThis.endClicks++;
					if (globalThis.ignoreEnd) return;
					end.remove();
					document.querySelector('[aria-label="Turn off microphone"], [aria-label="Turn on microphone"]')?.remove();
					const start = document.createElement("button");
					start.setAttribute("aria-label", "Start Voice");
					document.body.appendChild(start);
				};
				document.body.appendChild(end);
				const mic = document.createElement("button");
				mic.setAttribute("aria-label", "Turn off microphone");
				mic.onclick = () => {
					const next = mic.getAttribute("aria-label") === "Turn off microphone" ? "Turn on microphone" : "Turn off microphone";
					setTimeout(() => mic.setAttribute("aria-label", next), globalThis.micDelay ?? 0);
				};
				document.body.appendChild(mic);
			}, 1000);
		};
	});
	await page.addScriptTag({ content: await readFile(process.argv[2] ?? "support-extension/content-script.js", "utf8") });
	const begin = (kind, targetUrl = url) => page.evaluate(({ kind, url }) => {
		globalThis.voiceResult = null;
		globalThis.voiceListener({ type: "local-codex-support/automation-v1", command: { kind, feature: "voice", targetUrl: url } }, {},
			result => { globalThis.voiceResult = result; });
	}, { kind, url: targetUrl });
	const result = () => page.evaluate(() => globalThis.voiceResult);
	await begin("voice_status");
	await page.clock.runFor(100);
	assert.equal((await result()).ok, true, "injecting the updated extension replaces the previously installed page handler");
	assert.equal((await result()).result.status, "closed");
	await page.evaluate(localUrl => {
		history.replaceState({}, "", "/");
		globalThis.provisionalUrl = localUrl;
		const start = document.querySelector('button[aria-label="Start Voice"]');
		start.hidden = true;
		setTimeout(() => { start.hidden = false; }, 1000);
	}, localUrl);
	await begin("voice_start", "https://chatgpt.com/");
	await page.clock.runFor(500);
	assert.equal(await result(), null, "a newly loaded chat waits for its Voice control instead of failing during hydration");
	await page.clock.runFor(2500);
	assert.equal((await result()).ok, true, "starting a fresh Voice chat accepts ChatGPT's provisional conversation URL");
	assert.equal((await result()).result.status, "active");
	assert.equal((await result()).result.conversationUrl, localUrl);
	await begin("voice_start", localUrl);
	await page.clock.runFor(100);
	assert.equal((await result()).result.status, "active");
	assert.equal(await page.evaluate(() => globalThis.startClicks), 1, "another wake cannot toggle an active call off");
	await page.evaluate(url => { history.replaceState({}, "", url); globalThis.provisionalUrl = undefined; }, url);
	const micLabel = () => page.evaluate(() => document.querySelector('[aria-label="Turn off microphone"], [aria-label="Turn on microphone"]').getAttribute("aria-label"));
	const audio = async (duration, userSpeaking = false, assistantSpeaking = false, inputAvailable = true) => {
		await page.evaluate(({ userSpeaking, assistantSpeaking, inputAvailable }) => {
			clearInterval(globalThis.audioTimer);
			globalThis.audioTimer = setInterval(() => window.postMessage({ type: "local-codex-voice-activity-v1", userSpeaking, assistantSpeaking, inputAvailable }, location.origin), 100);
		}, { userSpeaking, assistantSpeaking, inputAvailable });
		await page.clock.runFor(duration);
	};
	await audio(100, true);
	await audio(4400);
	assert.equal(await micLabel(), "Turn off microphone", "silence below 4.5 seconds leaves the microphone open");
	await audio(200);
	assert.equal(await micLabel(), "Turn on microphone", "4.5 seconds of silence mutes without disconnecting");
	assert.equal(await page.evaluate(() => globalThis.endClicks), 0);
	await begin("voice_start");
	await page.clock.runFor(100);
	assert.equal(await micLabel(), "Turn off microphone", "wake unmutes an existing call");
	await audio(100, true);
	await audio(1300, false, true);
	assert.equal(await micLabel(), "Turn off microphone", "a brief assistant response cannot trigger early mute");
	await audio(400, false, true);
	assert.equal(await micLabel(), "Turn on microphone", "sustained assistant speech mutes earlier after user silence");
	await begin("voice_start");
	await page.clock.runFor(100);
	await audio(3000, true, true);
	assert.equal(await micLabel(), "Turn off microphone", "user speech keeps the mic open during assistant playback");
	await audio(5000, false, false, false);
	assert.equal(await micLabel(), "Turn off microphone", "missing audio measurements never count as silence");
	await page.evaluate(() => { globalThis.micDelay = 200; });
	await audio(100, true);
	await audio(4500);
	await begin("voice_start");
	await page.clock.runFor(600);
	assert.equal(await micLabel(), "Turn off microphone", "a wake queued behind an automatic mute restores the mic after confirmation");
	await page.evaluate(() => { clearInterval(globalThis.audioTimer); globalThis.micDelay = 0; });
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
	await page.evaluate(() => {
		const start = document.querySelector('[aria-label="Start Voice"]');
		start.hidden = false; start.disabled = true; start.setAttribute("aria-busy", "true");
	});
	await begin("voice_start");
	await page.clock.runFor(8200);
	assert.equal((await result()).ok, false);
	assert.match((await result()).error, /^VOICE_LOADING_STUCK:/, "stuck Voice loading is distinct from missing Voice access");
	await page.evaluate(() => history.replaceState({}, "", location.pathname + "?temporary-chat=true"));
	await begin("voice_start");
	await page.clock.runFor(100);
	assert.equal((await result()).ok, false, "a navigated or temporary page cannot receive Voice commands");
	console.log("Voice DOM passed: silence and playback mute timing, speech resets, missing measurements, wake during mute, loading detection, call transitions, and navigation rejection.");
} finally { await browser.close(); }
