import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Captured ChatGPT markup, October 2026. Exercise the content script in a real DOM.
const browser = await chromium.launch({ channel: "chrome", headless: true });
let phase = "initial delivery";
const timeout = setTimeout(() => { console.error(`ChatGPT DOM test timed out during ${phase}.`); void browser.close(); }, 120_000);
try {
	const page = await browser.newPage();
	await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
		<title>DOM regression - ChatGPT</title><button aria-label="Temporary chat">Temporary</button>
		<main><div data-turn-key="old"><div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="old">
		<div data-markdown-text-tone="user-message">An earlier assignment</div></div></div></main>
		<div data-composer-body><div contenteditable="true" data-composer-markdown></div><button aria-label="Add files and more">Add</button><button aria-label="Send">Send</button></div>` }));
	await page.goto("https://chatgpt.com/");
	await page.evaluate(() => {
		globalThis.chrome = { runtime: {
			sendMessage: async message => {
				if (message.activity && !globalThis.failedActivityReport) { globalThis.failedActivityReport = true; throw new Error("Extension context invalidated."); }
				(globalThis.observedActivity ??= []).push(message);
				return { ok: true };
			},
			onMessage: { addListener(listener) { globalThis.automationListener = listener; } },
		} };
		globalThis.sendClicks = 0;
		globalThis.temporaryClicks = 0;
		document.querySelector('button[aria-label="Temporary chat"]').onclick = event => {
			// The first click reaches the rendered control before its client handler is ready.
			if (++globalThis.temporaryClicks === 1) return;
			event.currentTarget.setAttribute("aria-label", "Turn off temporary chat");
			history.replaceState({}, "", "/?temporary-chat=true");
		};
		document.querySelector('button[aria-label="Add files and more"]').onclick = () => {
			const connector = document.createElement("button");
			connector.setAttribute("data-list-navigation-item", "true");
			connector.innerHTML = "<span>Codex</span><span>Helps you control my computer</span>";
			connector.onclick = () => {
				const oldEditor = document.querySelector('[data-composer-markdown]');
				const freshEditor = oldEditor.cloneNode(true);
				const mention = document.createElement("span");
				mention.setAttribute("app-mention-display-name", "Codex");
				mention.textContent = "Codex";
				freshEditor.appendChild(mention);
				oldEditor.replaceWith(freshEditor);
				connector.remove();
			};
			document.body.appendChild(connector);
		};
		const button = document.querySelector('button[aria-label="Send"]');
		globalThis.hostSend = () => {
			globalThis.sendClicks += 1;
			history.pushState({}, "", "/c/11111111-1111-4111-8111-111111111111" + location.search);
			const editor = document.querySelector('[data-composer-markdown]');
			editor.querySelector('[app-mention-display-name]')?.remove();
			const turn = document.createElement("div");
			turn.setAttribute("data-turn-key", "new");
			turn.innerHTML = '<div data-chatgpt-search-unit-key="fallback-turn-1:0:user" data-chatgpt-search-message-ids="new"><div data-user-message-bubble="true"><div data-markdown-text-tone="user-message"></div><button>Show more</button></div></div>';
			turn.querySelector('[data-chatgpt-search-message-ids]').setAttribute("data-chatgpt-search-message-ids", globalThis.sendClicks === 1 ? "new" : `new-${globalThis.sendClicks}`);
			const text = turn.querySelector('[data-markdown-text-tone="user-message"]');
			for (const line of editor.innerText.split("\n").filter(Boolean)) {
				const paragraph = document.createElement("p");
				paragraph.textContent = line;
				text.appendChild(paragraph);
			}
			const app = document.createElement("a");
			app.href = "/plugins/attached-app";
			app.textContent = "Codex";
			text.appendChild(app);
			if (globalThis.hideUser) turn.replaceChildren();
			document.querySelector("main").appendChild(turn);
			editor.textContent = "";
			button.setAttribute("aria-label", "Stop");
			button.onclick = () => {
				button.setAttribute("aria-label", "Send");
				button.onclick = globalThis.hostSend;
				const response = document.createElement("div");
				response.setAttribute("data-markdown-text-tone", "primary");
				response.textContent = "Stopped after the assigned check.";
				turn.appendChild(response);
			};
		};
		button.onclick = globalThis.hostSend;
	});
	const scriptPath = process.env.CHATGPT_CONTENT_SCRIPT ?? "support-extension/content-script.js";
	await page.addScriptTag({ content: await readFile(scriptPath, "utf8") });
	const execute = command => page.evaluate(command => new Promise(resolve => {
		globalThis.automationListener({ type: "local-codex-support/automation-v1", command }, {}, resolve);
	}), command);
	const sent = await execute({ kind: "send_message", temporary: true, connectorName: process.env.CHATGPT_DOM_SKIP_ATTACHMENT === "true" ? undefined : "Codex",
		message: "Run the assigned check.\n\nPublish its complete report." });
	assert.equal(sent.ok, true, sent.error);
	assert.equal(sent.result.status, "sent");
	assert.equal(sent.result.conversationUrl, "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111?temporary-chat=true", "worker creation preserves temporary mode through Send and connector attachment");
	assert.equal(await page.evaluate(() => globalThis.sendClicks), 1);
	assert.equal(await page.evaluate(() => globalThis.temporaryClicks), 2, "startup retries an ignored click without turning temporary mode off");
	await page.evaluate(() => {
		const alert = document.createElement("div");
		alert.setAttribute("role", "alert");
		alert.textContent = "File upload failed";
		document.body.appendChild(alert);
	});
	assert.equal((await execute({ kind: "page_health" })).result.status, "ok", "An upload error cannot trigger response recovery or stop a healthy turn");
	await page.evaluate(() => document.querySelector('[role="alert"]').remove());
	assert.equal((await execute({ kind: "inspect_thread" })).result.status, "running");
	phase = "stop and recovery";
	const stopped = await execute({ kind: "stop_thread" });
	assert.equal(stopped.ok, true, stopped.error);
	assert.equal(stopped.result.status, "stopped");
	const idle = await execute({ kind: "inspect_thread" });
	assert.equal(idle.ok, true, idle.error);
	assert.equal(idle.result.status, "idle");
	assert.equal(idle.result.users.at(-1).id, "new");
	assert.equal(idle.result.users.at(-1).text, "Run the assigned check.\n\nPublish its complete report.");
	assert.equal(idle.result.assistant.text, "Stopped after the assigned check.");
	const wrongChatRecovery = await execute({ kind: "send_message", recovering: true,
		targetUrl: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222", message: "Continue" });
	assert.equal(wrongChatRecovery.ok, false, "Recovery dispatched to a different conversation is rejected in the page itself");
	assert.equal(await page.evaluate(() => globalThis.sendClicks), 1);
	await page.evaluate(() => {
		document.querySelector('[data-composer-markdown]').textContent = "My unsent note";
		const alert = document.createElement("div");
		alert.setAttribute("role", "alert");
		alert.textContent = "Something went wrong";
		document.body.appendChild(alert);
	});
	const preserveDraft = await execute({ kind: "send_message", recovering: true, recoveryContinuation: true,
		targetUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111?temporary-chat=true", message: "Continue" });
	assert.equal(preserveDraft.ok, true, preserveDraft.error);
	assert.equal(preserveDraft.result.status, "idle");
	assert.equal(await page.locator('[data-composer-markdown]').innerText(), "My unsent note", "Automatic continuation preserves a user draft");
	assert.equal(await page.evaluate(() => globalThis.sendClicks), 1);
	await page.evaluate(() => { document.querySelector('[data-composer-markdown]').textContent = ""; document.querySelector('[role="alert"]').remove(); });
	const expiredRecovery = await execute({ kind: "send_message", recovering: true, recoveryContinuation: true,
		targetUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111?temporary-chat=true", message: "Continue", recoveryExpiresAt: Date.now() + 300 });
	assert.equal(expiredRecovery.ok, false);
	assert.match(expiredRecovery.error, /reservation expired/);
	assert.equal(await page.evaluate(() => globalThis.sendClicks), 1, "A reservation that expires while the page waits cannot click Send");
	await page.waitForFunction(() => globalThis.observedActivity.some(message => message.activity === "idle"));
	assert.ok(await page.evaluate(() => globalThis.observedActivity.some(message => message.activity === "running")), "modern composer activity reaches the extension");
	await page.evaluate(() => {
		const alert = document.createElement("div");
		alert.setAttribute("role", "alert");
		alert.textContent = "Something went wrong";
		const retry = document.createElement("button");
		retry.textContent = "Retry";
		retry.onclick = () => alert.remove();
		alert.appendChild(retry);
		document.body.appendChild(alert);
	});
	assert.equal((await execute({ kind: "recover_page" })).result.status, "recovery_started");
	assert.equal((await execute({ kind: "page_health" })).result.status, "ok");
	await page.evaluate(() => {
		const status = document.createElement("div");
		status.setAttribute("role", "status");
		status.innerHTML = '<span class="text-chatgpt-recovery">Connection interrupted. Waiting for the complete answer</span>';
		document.body.appendChild(status);
	});
	assert.equal((await execute({ kind: "page_health" })).result.status, "connection_interrupted", "the exact supplied recovery notice is detected");
	await page.waitForFunction(() => globalThis.observedActivity.some(message => message.pageHealth === "connection_interrupted"));
	await page.evaluate(() => {
		const status = document.querySelector('[role="status"]');
		const button = document.querySelector('button[aria-label="Send"]');
		button.setAttribute("aria-label", "Stop");
		button.onclick = () => {
			button.setAttribute("aria-label", "Send");
			button.onclick = () => { status.remove(); globalThis.hostSend(); };
		};
	});
	const recovered = await execute({ kind: "resume_interrupted", message: "Continue the remaining assignment." });
	assert.equal(recovered.ok, true, recovered.error);
	assert.equal(recovered.result.status, "sent", "a stuck turn stops before continuation even while the recovery notice remains visible");
	assert.equal(await page.evaluate(() => globalThis.sendClicks), 2);
	assert.equal((await execute({ kind: "stop_thread" })).result.status, "stopped");
	await page.evaluate(() => {
		const alert = document.createElement("div");
		alert.setAttribute("role", "alert");
		alert.textContent = "Something went wrong";
		document.body.appendChild(alert);
		const button = document.querySelector('button[aria-label="Send"]');
		button.onclick = () => { alert.remove(); globalThis.hostSend(); };
	});
	await page.waitForFunction(() => globalThis.observedActivity.some(message => message.pageHealth === "recoverable_error"));
	const idleRecovery = await execute({ kind: "resume_interrupted", message: "Continue the existing task." });
	assert.equal(idleRecovery.ok, true, idleRecovery.error);
	assert.equal(idleRecovery.result.status, "sent", "an error on an already idle turn still receives continuation");
	assert.equal(await page.evaluate(() => globalThis.sendClicks), 3);
	assert.equal((await execute({ kind: "stop_thread" })).result.status, "stopped");
	await page.evaluate(() => {
		history.pushState({}, "", "/");
		document.querySelector("main").replaceChildren();
		globalThis.hideUser = true;
	});
	phase = "hidden user delivery";
	const hiddenUser = await execute({ kind: "send_message", message: "Run a new assignment whose user message stays hidden." });
	assert.equal(hiddenUser.ok, true, hiddenUser.error);
	assert.equal(hiddenUser.result.status, "sent");
	assert.equal(await page.evaluate(() => globalThis.sendClicks), 4);
	assert.equal((await execute({ kind: "inspect_thread" })).result.status, "running");
	assert.equal((await execute({ kind: "stop_thread" })).result.status, "stopped");
	const hiddenIdle = await execute({ kind: "inspect_thread" });
	assert.equal(hiddenIdle.result.status, "idle");
	assert.deepEqual(hiddenIdle.result.users, []);
	assert.equal(hiddenIdle.result.assistant.text, "Stopped after the assigned check.");
	await page.evaluate(() => {
		history.pushState({}, "", "/c/11111111-1111-4111-8111-111111111111");
		const heading = document.createElement("h2");
		heading.textContent = "Could not load this ChatGPT conversation";
		document.querySelector("main").appendChild(heading);
	});
	assert.equal((await execute({ kind: "page_health" })).result.status, "ok", "error text quoted beside loaded messages does not pause work");
	await page.evaluate(() => {
		document.querySelector("main").innerHTML = '<div><h2>Could not load this ChatGPT conversation</h2><button>Retry</button></div>';
		document.querySelector('[data-composer-body]').remove();
		globalThis.retryClicks = 0;
		document.querySelector("main button").onclick = () => { globalThis.retryClicks++; document.querySelector("main").replaceChildren(); };
	});
	assert.equal((await execute({ kind: "page_health" })).result.status, "conversation_unavailable", "the screenshot error is recognized without a composer or an alert role");
	await page.waitForFunction(() => globalThis.observedActivity.some(message => message.type === "local-codex-support/conversation-unavailable-v1"));
	assert.equal(await page.evaluate(() => globalThis.retryClicks), 0, "observing the error never clicks Retry");
	await page.evaluate(() => {
		history.pushState({}, "", "/c/22222222-2222-4222-8222-222222222222");
		document.querySelector("main").appendChild(document.createElement("div"));
	});
	await page.waitForFunction(() => globalThis.observedActivity.some(message => message.type === "local-codex-support/conversation-unavailable-v1" && message.conversationUrl.endsWith("22222222-2222-4222-8222-222222222222")));

	phase = "global pause";
	await page.clock.install();
	await page.evaluate(() => {
		globalThis.pauseUntil = Date.now() + 300_000;
		chrome.storage = { local: { async get() { return { automationPausedUntil: globalThis.pauseUntil }; } } };
		globalThis.recoveryResult = null;
		globalThis.automationListener({ type: "local-codex-support/automation-v1", command: { kind: "recover_page" } }, {}, result => { globalThis.recoveryResult = result; });
	});
	await page.clock.runFor(1000);
	assert.equal(await page.evaluate(() => globalThis.retryClicks), 0, "an already loaded content script honors the global pause before Retry");
	assert.equal(await page.evaluate(() => globalThis.recoveryResult), null);
	await page.clock.fastForward(299_000);
	await page.clock.runFor(1000);
	assert.notEqual(await page.evaluate(() => globalThis.recoveryResult), null);
	assert.equal(await page.evaluate(() => globalThis.recoveryResult.result.status), "recovery_started");
	assert.equal(await page.evaluate(() => globalThis.retryClicks), 1, "the same request resumes at five minutes without another command");
	console.log("ChatGPT DOM passed: visible and hidden user delivery, app links, running detection, stop confirmation, and idle inspection.");
} finally {
	clearTimeout(timeout);
	await browser.close();
}
