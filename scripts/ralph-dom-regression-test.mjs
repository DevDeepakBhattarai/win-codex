import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import vm from "node:vm";

const source = await readFile(process.env.CHATGPT_CONTENT_SCRIPT ?? "support-extension/content-script.js", "utf8");
const workerSource = await readFile("support-extension/service-worker.js", "utf8");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
	for (const markup of [
		'<section data-turn="user"><div data-message-author-role="user">Finish the task.</div></section><section data-turn="assistant"><div data-message-author-role="assistant">I made partial progress.</div></section>',
		'<div data-turn-key="current"><div data-chatgpt-search-unit-key="turn:user"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">Finish the task.</div></div></div><div data-chatgpt-search-unit-key="turn:assistant"><div data-markdown-text-style="assistant-message" data-markdown-text-tone="primary">I made partial progress.</div></div><button>Worked for 40m 31s</button></div>',
	]) {
		const page = await browser.newPage();
		await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
			<main>${markup}</main><div data-composer-body><div contenteditable="true" data-composer-markdown></div><button aria-label="Start voice mode">Voice</button></div>` }));
		await page.goto("https://chatgpt.com/c/11111111-1111-4111-8111-111111111111");
		await page.evaluate(() => {
			globalThis.activity = [];
			globalThis.automationListeners = [];
			globalThis.chrome = { runtime: { sendMessage: async message => { globalThis.activity.push(message); return { ok: true }; },
				onMessage: { addListener(listener) { globalThis.automationListeners.push(listener); } } } };
		});
		await page.addScriptTag({ content: source.replace('const contentScriptVersion = "1.19.0";', 'const contentScriptVersion = "stale-regression";')
			.replace('function pageHealth() {', 'function pageHealth() { return { status: "stale" };') });
		await page.addScriptTag({ content: source });
		const execute = command => page.evaluate(command => new Promise(resolve =>
			globalThis.automationListeners.forEach(listener => listener({ type: "local-codex-support/automation-v1", command }, {}, resolve))), command);
		if (!process.argv[2]) {
			await page.waitForFunction(() => globalThis.activity.some(message => message.activity === "idle"), undefined, { timeout: 5000 });
		}
		assert.equal((await execute({ kind: "page_health" })).result.status, "ok", "a normal final response stays healthy");
		if (process.argv[2] !== "notices") {
			if (markup.includes("data-turn-key")) {
				const final = await execute({ kind: "inspect_thread" });
				assert.equal(final.result.workedSeconds, 2431, "modern final responses retain their worked duration");
				assert.equal(final.result.assistant.synthetic, false);
			}
			await page.evaluate(() => document.querySelector('[data-message-author-role="assistant"], [data-markdown-text-tone="primary"]').textContent = "");
			const empty = await execute({ kind: "inspect_thread" });
			assert.equal(empty.ok, true, empty.error);
			assert.equal(empty.result.status, "idle");
			assert.equal(empty.result.assistant.synthetic, true, "an empty response element is a stopped turn without a final response");
			await page.evaluate(() => document.querySelector('[data-message-author-role="assistant"], [data-markdown-text-tone="primary"]').textContent = "I made partial progress.");
		}
		if (process.argv[2] === "empty") { await page.close(); continue; }

		await page.evaluate(() => {
			const quoted = document.createElement("span");
			quoted.setAttribute("role", "status");
			quoted.textContent = "Stream disconnected.";
			document.querySelector('[data-message-author-role="assistant"], [data-markdown-text-tone="primary"]').appendChild(quoted);
		});
		assert.equal((await execute({ kind: "page_health" })).result.status, "ok", "a quoted notice inside assistant prose cannot stop the agent");
		await page.evaluate(() => document.querySelector('[role="status"]').remove());

		for (const text of ["Our systems are thinking a bit more about this request before responding.", "Thinking", "Working on your request."]) {
			await page.evaluate(text => {
				document.querySelector('button[aria-label="Start voice mode"]').setAttribute("aria-label", "Stop");
				document.querySelector("main").insertAdjacentHTML("beforeend", `<div role="status">${text}</div>`);
			}, text);
			assert.equal((await execute({ kind: "page_health" })).result.status, "ok", "a normal progress notice must never trigger automatic Stop");
			await page.evaluate(() => { document.querySelector('main [role]').remove(); document.querySelector('button[aria-label="Stop"]').setAttribute("aria-label", "Start voice mode"); });
		}
		for (const role of ["status", "alert"]) {
			await page.evaluate(role => {
				document.querySelector('button[aria-label="Start voice mode"]').setAttribute("aria-label", "Stop");
				const notice = document.createElement("div");
				notice.setAttribute("role", role);
				notice.setAttribute("aria-live", "polite");
				notice.textContent = role === "status" ? "Stream disconnected."
					: "There was an error generating the response.";
				const currentTurn = document.querySelector('section[data-turn="assistant"], [data-turn-key]');
				(role === "status" ? currentTurn : document.querySelector("main")).appendChild(notice);
			}, role);
			assert.equal((await execute({ kind: "page_health" })).result.status, "recoverable_error",
				"a recognized error outside messages identifies a stale Stop state");
			await page.evaluate(() => document.querySelector('button[aria-label="Stop"]').setAttribute("aria-label", "Start voice mode"));
			assert.equal((await execute({ kind: "page_health" })).result.status, "recoverable_error", "the notice remains recoverable after Stop disappears");
			await page.evaluate(() => document.querySelector('main [role]').remove());
		}

		await page.evaluate(() => {
			const tool = document.createElement("div");
			tool.setAttribute("data-tool-call-id", "tool1");
			tool.innerHTML = '<div role="status">Executing a tool call.</div>';
			document.querySelector("main").appendChild(tool);
		});
		assert.equal((await execute({ kind: "page_health" })).result.status, "ok", "a tool's status is normal work");
		await page.evaluate(() => {
			document.querySelector("main").insertAdjacentHTML("beforeend", '<div role="alert">Stream disconnected.</div><section data-turn="user"><div data-message-author-role="user">Start the next task.</div></section>');
			document.querySelector('button[aria-label="Start voice mode"]').setAttribute("aria-label", "Stop");
		});
		assert.equal((await execute({ kind: "page_health" })).result.status, "ok", "an older terminal notice cannot interrupt a newer user turn");
		if (!process.argv[2]) {
			await page.evaluate(markup => {
				document.querySelector("main").innerHTML = markup;
				globalThis.stopClicks = 0;
				globalThis.sentTexts = [];
				globalThis.stopConfirmedAt = 0;
				globalThis.sentAt = 0;
				const button = document.querySelector("[data-composer-body] button");
				const editor = document.querySelector('[contenteditable="true"]');
				button.onclick = () => {
					if (button.getAttribute("aria-label") === "Stop") {
						globalThis.stopClicks++;
						setTimeout(() => {
							button.setAttribute("aria-label", "Start voice mode");
							globalThis.stopConfirmedAt = Date.now();
						}, 250);
					} else if (button.getAttribute("aria-label") === "Send") {
						globalThis.sentTexts.push(editor.innerText.trim());
						globalThis.sentAt = Date.now();
						const turn = document.createElement("section");
						turn.setAttribute("data-turn", "user");
						turn.innerHTML = '<div data-message-author-role="user" data-message-id="continued"></div>';
						turn.firstChild.textContent = editor.innerText;
						document.querySelector("main").appendChild(turn);
						editor.textContent = "";
						button.setAttribute("aria-label", "Stop");
					}
				};
				editor.addEventListener("input", () => button.setAttribute("aria-label", editor.innerText.trim() ? "Send" : "Start voice mode"));
			}, markup);
			const config = { extensionToken: "x".repeat(40) };
			for (const [key, route] of Object.entries({ bindUrl: "/thread-sync/bind", commandClaimUrl: "/chatgpt-support/commands/claim",
				commandResultUrl: "/chatgpt-support/commands/result", threadObserveUrl: "/chatgpt-support/threads/observe",
				ralphRegisterUrl: "/chatgpt-support/ralph/register" })) config[key] = `http://127.0.0.1:6002${route}`;
			const storage = { threadSync: false, automationExecutor: false, errorRecovery: false, ralph: false, threadMessaging: false };
			const context = { URL, AbortSignal, AbortController, crypto: globalThis.crypto, Response, Error,
				setTimeout, clearTimeout, console, importScripts() {}, LOCAL_CODEX_THREAD_SYNC: config,
				browser: {
					runtime: { id: "fixture", getPlatformInfo: async () => {}, onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
					storage: { local: { async get(query) { return typeof query === "string" ? { [query]: storage[query] } : { ...query, ...storage }; },
						async set(values) { Object.assign(storage, values); }, async remove(key) { delete storage[key]; } } },
					scripting: { async executeScript() {} },
					tabs: { onUpdated: { addListener() {} }, async query() { return [{ id: 7, url: page.url(), status: "complete" }]; },
						async get() { return { id: 7, url: page.url(), status: "complete" }; },
						async sendMessage(_id, { command }) { return execute(command); } },
				},
				async fetch(_endpoint, options) {
					const request = JSON.parse(options.body);
					if (request.recoveryReservation?.action === "acquire") return new Response(JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expiresAt: Date.now() + 540_000 }));
					return new Response(null, { status: 204 });
				},
			};
			vm.runInNewContext(workerSource, context);
			await new Promise(resolve => setImmediate(resolve));
			vm.runInNewContext("pollGeneration += 1; pollController?.abort(); voicePollController?.abort();", context);
			await page.evaluate(() => document.querySelector("main").insertAdjacentHTML("beforeend", '<div role="status">Our systems are thinking a bit more about this request before responding.</div>'));
			assert.equal(await context.recoverPage(7), false, "the actual worker leaves normal reasoning alone");
			assert.equal((await execute({ kind: "stop_thread", recovering: true, targetUrl: page.url(), requireFailure: true })).result.status, "error_cleared",
				"recovery rechecks the error before clicking Stop even if an earlier health check was stale");
			assert.equal(await page.evaluate(() => globalThis.stopClicks), 0);
			await page.evaluate(() => document.querySelector('main [role]').textContent = "Stream disconnected.");
			assert.equal(await context.recoverPage(7), true, "a recognized error completes the actual worker recovery");
			assert.deepEqual(await page.evaluate(() => globalThis.sentTexts), ["Continue"], "recovery sends exactly one plain Continue");
			assert.equal(await page.evaluate(() => globalThis.stopClicks), 1);
			assert.equal(await page.evaluate(() => globalThis.sentAt > globalThis.stopConfirmedAt && globalThis.stopConfirmedAt > 0), true,
				"Continue is sent only after the page confirms that Stop disappeared");
			assert.equal(await context.recoverPage(7), false, "the resumed healthy turn cannot be stopped by its older error");
			assert.equal(await page.evaluate(() => globalThis.stopClicks), 1);
			if (markup.includes("data-turn-key")) {
				await page.evaluate(markup => {
					document.querySelector("main").innerHTML = markup;
					document.querySelector('[data-chatgpt-search-unit-key$=":assistant"]').remove();
					document.querySelector('[data-turn-key]').insertAdjacentHTML("beforeend", '<div data-markdown-text-style="assistant-message" data-markdown-text-tone="primary">I am still fixing the task.</div>');
					document.querySelector('[data-composer-body] button').setAttribute("aria-label", "Start voice mode");
					globalThis.originalNow = Date.now;
					globalThis.clockStartedAt = Date.now();
					globalThis.clockOffset = 0;
					Date.now = () => globalThis.clockStartedAt + (globalThis.originalNow() - globalThis.clockStartedAt) * 100 + globalThis.clockOffset;
				}, markup);
				assert.equal((await execute({ kind: "inspect_thread" })).result.status, "loading", "progress messages do not bypass the missing-final hydration grace period");
				await page.evaluate(() => globalThis.clockOffset = 180_000);
				const progressOnly = await execute({ kind: "inspect_thread" });
				assert.equal(progressOnly.result.status, "idle");
				assert.equal(progressOnly.result.assistant.synthetic, true, "a stopped turn containing only progress is a missing final, not a completed response");
				await page.evaluate(() => Date.now = globalThis.originalNow);
			}
		}
		await page.close();
	}
	console.log(`RALPH DOM regression case ${process.argv[2] ?? "all"} passed.`);
} finally {
	await browser.close();
}
