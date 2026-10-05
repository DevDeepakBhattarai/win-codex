import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { ScheduledTasks, createScheduleApi } from "../dist/scheduled-tasks.js";
import { RalphRegistry, SupportCommandBus, ThreadPreparationCoordinator } from "../dist/chatgpt-support.js";
import { ThreadSyncRegistry } from "../dist/thread-sync.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "scheduled-tasks-"));
const token = "x".repeat(43);
const commands = new SupportCommandBus();
const registry = await RalphRegistry.open(directory);
const preparer = new ThreadPreparationCoordinator(commands, await ThreadSyncRegistry.open(directory), async () => {});
const services = { commands, registry, preparer, launchBrowser: async () => { throw new Error("Unexpected browser launch"); } };
const schedules = await ScheduledTasks.open(directory);
const app = express();
app.use(express.json());
app.use("/schedules", createScheduleApi(schedules, token));
const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}/schedules`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "chrome-extension://test" };
const request = (suffix = "", init = {}) => fetch(base + suffix, { ...init, headers: { ...headers, ...init.headers } });
try {
	assert.equal((await request("", { headers: { authorization: "Bearer wrong" } })).status, 401);
	assert.equal((await request("", { headers: { origin: "https://example.com" } })).status, 403);
	for (const input of [{ prompt: "", runAt: new Date(Date.now() + 60_000).toISOString() },
		{ prompt: "Run this", runAt: new Date(Date.now() - 60_000).toISOString() },
		{ prompt: "Run this", runAt: "invalid" },
		{ prompt: "Run this", runAt: new Date(Date.now() + 60_000).toISOString(), repeatIntervalSeconds: 59 },
		{ prompt: "Run this", runAt: new Date(Date.now() + 60_000).toISOString(), repeatIntervalSeconds: 60.5 }]) {
		assert.equal((await request("", { method: "POST", body: JSON.stringify(input) })).status, 400);
	}
	const runAt = new Date(Date.now() + 60_000).toISOString();
	const created = await request("", { method: "POST", body: JSON.stringify({ prompt: "Cancel me", runAt }) });
	assert.equal(created.status, 201);
	const { task } = await created.json();
	assert.equal((await (await request(`/${task.id}/cancel`, { method: "PUT" })).json()).task.state, "cancelled");
	assert.equal((await (await ScheduledTasks.open(directory)).all())[0].state, "cancelled", "cancellation survives restart");
	await commands.claim("executor", ["threadMessaging"], 0);
	await schedules.tick(services);
	assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined, "cancelled work never sends");
	assert.equal((await request(`/${task.id}`, { method: "DELETE" })).status, 200);
	const queued = await schedules.create({ prompt: "Do the scheduled work", runAt: new Date(Date.now() + 150).toISOString() });
	assert.equal((await request(`/${queued.id}`, { method: "DELETE" })).status, 409);
	await schedules.tick(services);
	assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined, "future work does not run early");
	await new Promise(resolve => setTimeout(resolve, 180));
	const running = schedules.tick(services);
	const command = await commands.claim("executor", ["threadMessaging"], 1000);
	assert.equal(command.kind, "send_message");
	assert.equal(command.message, "Do the scheduled work");
	assert.equal(command.temporary, true);
	assert.equal(command.targetUrl, "https://chatgpt.com/");
	assert.equal((await request(`/${queued.id}/cancel`, { method: "PUT" })).status, 409, "claimed tasks cannot be cancelled as if unsent");
	await schedules.tick(services);
	assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined, "concurrent ticks cannot send twice");
	const conversationUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111?temporary-chat=true";
	commands.complete({ commandId: command.id, browserId: "executor", kind: command.kind, ok: true,
		result: { status: "sent", conversationUrl, title: "Scheduled work" } });
	await running;
	assert.equal((await schedules.all())[0].state, "sent");
	assert.equal((await registry.threads())[0].conversationUrl, conversationUrl, "scheduled work registers for normal RALPH continuation");
	assert.equal((await (await ScheduledTasks.open(directory)).all())[0].conversationUrl, conversationUrl);
	const failing = await schedules.create({ prompt: "Uncertain delivery", runAt: new Date(Date.now() + 100).toISOString() });
	await new Promise(resolve => setTimeout(resolve, 130));
	const failedRun = schedules.tick(services);
	const failedCommand = await commands.claim("executor", ["threadMessaging"], 1000);
	commands.complete({ commandId: failedCommand.id, browserId: "executor", kind: failedCommand.kind,
		ok: false, error: "Acknowledgement lost after Send", deliveryUncertain: true });
	await failedRun;
	assert.equal((await schedules.all()).find(entry => entry.id === failing.id).state, "failed");
	await schedules.tick(services);
	assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined, "uncertain deliveries never retry automatically");
	const persisted = JSON.parse(await readFile(path.join(directory, "scheduled-tasks.json"), "utf8"));
	persisted.tasks.push({ ...queued, id: crypto.randomUUID(), state: "pending", runAt: new Date(Date.now() - 60_000).toISOString() });
	persisted.tasks.push({ ...queued, id: crypto.randomUUID(), state: "sending" });
	await writeFile(path.join(directory, "scheduled-tasks.json"), JSON.stringify(persisted));
	const restarted = await ScheduledTasks.open(directory);
	assert.deepEqual((await restarted.all()).slice(-2).map(entry => entry.state), ["missed", "failed"]);
	await restarted.tick(services);
	assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined, "restart skips missed runs and preserves uncertain sends");
	const RealDate = Date;
	let now = RealDate.now();
	globalThis.Date = class extends RealDate {
		constructor(...args) { super(...(args.length ? args : [now])); }
		static now() { return now; }
	};
	try {
		const repeated = await schedules.create({ prompt: "Repeat every minute", runAt: new Date(now + 1000).toISOString(), repeatIntervalSeconds: 60 });
		now += 1000;
		const repeatRun = schedules.tick(services);
		const repeatCommand = await commands.claim("executor", ["threadMessaging"], 1000);
		commands.complete({ commandId: repeatCommand.id, browserId: "executor", kind: repeatCommand.kind, ok: true,
			result: { status: "sent", conversationUrl, title: "Repeat work" } });
		await repeatRun;
		let saved = (await schedules.all()).find(entry => entry.id === repeated.id);
		assert.equal(saved.state, "pending");
		assert.equal(saved.lastRunState, "sent");
		assert.equal(Date.parse(saved.runAt), now + 60_000, "repeat retains its cadence");
		await schedules.tick(services);
		assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined, "repeat waits for the next interval");
		now += 185_000;
		const lateRun = schedules.tick(services);
		const lateCommand = await commands.claim("executor", ["threadMessaging"], 1000);
		commands.complete({ commandId: lateCommand.id, browserId: "executor", kind: lateCommand.kind, ok: false,
			error: "Acknowledgement lost", deliveryUncertain: true });
		await lateRun;
		saved = (await schedules.all()).find(entry => entry.id === repeated.id);
		assert.equal(saved.state, "pending");
		assert.equal(saved.lastRunState, "failed");
		assert.equal(Date.parse(saved.runAt), now + 55_000, "late delivery skips elapsed intervals without shifting the cadence");
		await schedules.tick(services);
		assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined, "failed occurrence is not replayed");
		now += 55_000;
		const cancelledRun = schedules.tick(services);
		const cancelledCommand = await commands.claim("executor", ["threadMessaging"], 1000);
		await schedules.cancel(repeated.id);
		commands.complete({ commandId: cancelledCommand.id, browserId: "executor", kind: cancelledCommand.kind, ok: true,
			result: { status: "sent", conversationUrl, title: "Last repeat" } });
		await cancelledRun;
		assert.equal((await schedules.all()).find(entry => entry.id === repeated.id).state, "cancelled", "in-flight completion never revives a cancelled repeat");
		now += 120_000;
		await schedules.tick(services);
		assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined);
		const restartData = JSON.parse(await readFile(path.join(directory, "scheduled-tasks.json"), "utf8"));
		for (const state of ["pending", "sending"]) {
			restartData.tasks.push({ ...repeated, id: crypto.randomUUID(), state, runAt: new Date(now - 185_000).toISOString() });
		}
		await writeFile(path.join(directory, "scheduled-tasks.json"), JSON.stringify(restartData));
		const repeatRestart = await ScheduledTasks.open(directory);
		for (const [index, entry] of (await repeatRestart.all()).slice(-2).entries()) {
			assert.equal(entry.state, "pending");
			assert.equal(entry.lastRunState, index === 0 ? "missed" : "failed");
			assert.equal(Date.parse(entry.runAt), now + 55_000, "restart skips elapsed occurrences but preserves future repeats");
		}
		await repeatRestart.tick(services);
		assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined, "restart never bursts missed repeats");
		const removed = await schedules.create({ prompt: "Cancel before delivery", runAt: new Date(now + 1000).toISOString(), repeatIntervalSeconds: 3600 });
		now += 1000;
		let releaseBrowser;
		let browserReady;
		const browserEntered = new Promise(resolve => { browserReady = resolve; });
		const browserGate = new Promise(resolve => { releaseBrowser = resolve; });
		const heldRun = schedules.tick({ ...services, commands: {
			automationPausedUntil: () => commands.automationPausedUntil(),
			messageCooldownUntil: () => commands.messageCooldownUntil(),
			ensureBrowser: async () => { browserReady(); await browserGate; },
			execute: input => commands.execute(input),
		} });
		await browserEntered;
		await schedules.cancel(removed.id);
		await schedules.remove(removed.id);
		releaseBrowser();
		await heldRun;
		assert.equal(await commands.claim("executor", ["threadMessaging"], 0), undefined, "cancellation and removal during browser startup prevent delivery");
	} finally { globalThis.Date = RealDate; }
	console.log("Scheduled tasks passed: authentication, validation, persistence, due delivery, RALPH registration, repeat cadence, missed intervals, failures, cancellation races, and restart recovery.");
} finally {
	schedules.close();
	commands.close();
	await new Promise(resolve => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
