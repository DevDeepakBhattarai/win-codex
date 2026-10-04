import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Captured ChatGPT markup, October 2026. Exercise the content script in a real DOM.
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
	const page = await browser.newPage();
	await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
		<title>DOM regression - ChatGPT</title>
		<main><div data-turn-key="old"><div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="old">
		<div data-markdown-text-tone="user-message">An earlier assignment</div></div></div></main>
		<div data-composer-body><div contenteditable="true" data-composer-markdown></div><button aria-label="Add files and more">Add</button><button aria-label="Send">Send</button></div>` }));
	await page.goto("https://chatgpt.com/");
	await page.evaluate(() => {
		globalThis.chrome = { runtime: {
			sendMessage: async () => ({}),
			onMessage: { addListener(listener) { globalThis.automationListener = listener; } },
		} };
		globalThis.sendClicks = 0;
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
			history.pushState({}, "", "/c/11111111-1111-4111-8111-111111111111");
			const editor = document.querySelector('[data-composer-markdown]');
			editor.querySelector('[app-mention-display-name]')?.remove();
			const turn = document.createElement("div");
			turn.setAttribute("data-turn-key", "new");
			turn.innerHTML = '<div data-chatgpt-search-unit-key="fallback-turn-1:0:user" data-chatgpt-search-message-ids="new"><div data-user-message-bubble="true"><div data-markdown-text-tone="user-message"></div><button>Show more</button></div></div>';
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
	const sent = await execute({ kind: "send_message", connectorName: process.env.CHATGPT_DOM_SKIP_ATTACHMENT === "true" ? undefined : "Codex",
		message: "Run the assigned check.\n\nPublish its complete report." });
	assert.equal(sent.ok, true, sent.error);
	assert.equal(sent.result.status, "sent");
	assert.equal(await page.evaluate(() => globalThis.sendClicks), 1);
	assert.equal((await execute({ kind: "inspect_thread" })).result.status, "running");
	const stopped = await execute({ kind: "stop_thread" });
	assert.equal(stopped.ok, true, stopped.error);
	assert.equal(stopped.result.status, "stopped");
	const idle = await execute({ kind: "inspect_thread" });
	assert.equal(idle.ok, true, idle.error);
	assert.equal(idle.result.status, "idle");
	assert.equal(idle.result.users.at(-1).id, "new");
	assert.equal(idle.result.users.at(-1).text, "Run the assigned check.\n\nPublish its complete report.");
	assert.equal(idle.result.assistant.text, "Stopped after the assigned check.");
	await page.evaluate(() => {
		history.pushState({}, "", "/");
		document.querySelector("main").replaceChildren();
		globalThis.hideUser = true;
	});
	const hiddenUser = await execute({ kind: "send_message", message: "Run a new assignment whose user message stays hidden." });
	assert.equal(hiddenUser.ok, true, hiddenUser.error);
	assert.equal(hiddenUser.result.status, "sent");
	assert.equal(await page.evaluate(() => globalThis.sendClicks), 2);
	assert.equal((await execute({ kind: "inspect_thread" })).result.status, "running");
	assert.equal((await execute({ kind: "stop_thread" })).result.status, "stopped");
	const hiddenIdle = await execute({ kind: "inspect_thread" });
	assert.equal(hiddenIdle.result.status, "idle");
	assert.deepEqual(hiddenIdle.result.users, []);
	assert.equal(hiddenIdle.result.assistant.text, "Stopped after the assigned check.");
	console.log("ChatGPT DOM passed: visible and hidden user delivery, app links, running detection, stop confirmation, and idle inspection.");
} finally {
	await browser.close();
}
