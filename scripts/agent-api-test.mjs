import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createAgentApi } from "../dist/agent-api.js";
import { SubagentJobRegistry } from "../dist/subagent-jobs.js";
import { RalphRegistry, SupportCommandBus, ThreadPreparationCoordinator } from "../dist/chatgpt-support.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "agent-api-test-"));
const jobs = await SubagentJobRegistry.open(directory);
const registry = await RalphRegistry.open(directory);
const commands = new SupportCommandBus(undefined, undefined, 0);
let browserLaunch;
const preparer = new ThreadPreparationCoordinator(commands, { hasThread: async () => true }, async () => {});
const app = express();
app.use(express.json());
const requests = [];
app.use("/agents", (req, _res, next) => { requests.push({ method: req.method, url: req.url, session: req.body?.session }); next(); });
app.use("/agents", createAgentApi({ token: "test-token", jobs, registry, commands, preparer, dataDirectory: directory,
	launchBrowser: async () => { await browserLaunch; } }));
const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
const url = `http://127.0.0.1:${server.address().port}/agents`;
const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
const request = (suffix = "", body, extraHeaders = {}, signal = AbortSignal.timeout(30_000)) =>
	fetch(url + suffix, { method: body ? "POST" : "GET", headers: { ...headers, ...extraHeaders }, body: body && JSON.stringify(body), signal });
const claim = () => commands.claim("extension", ["threadMessaging", "threadPreparation"], 1000);
const sent = command => commands.complete({ commandId: command.id, browserId: "extension", kind: "send_message", ok: true,
	result: { status: "sent", conversationUrl: `https://chatgpt.com/c/${randomUUID()}` } });
const publish = async (job, report) => {
	await writeFile(job.resultPath + ".tmp", report);
	await rename(job.resultPath + ".tmp", job.resultPath);
};
let reopened;
try {
	assert.equal((await request("", undefined, { authorization: "Bearer wrong" })).status, 401);
	assert.equal((await request("", { prompt: "x", requestId: "origin" }, { origin: "https://example.com" })).status, 401);
	assert.equal((await request("", { prompt: " ", requestId: "blank" })).status, 400);
	assert.equal((await request("", { prompt: "Missing retry ID" })).status, 400);
	let rejectLaunch;
	browserLaunch = new Promise((_resolve, reject) => { rejectLaunch = reject; });
	const startupConnection = new AbortController();
	const startup = await request("", { prompt: "Unavailable browser", session: "startup", requestId: "no-browser" }, {}, startupConnection.signal);
	const startupId = startup.headers.get("x-job-id");
	const startupAborted = assert.rejects(startup.json());
	startupConnection.abort();
	await startupAborted;
	const startupRecovery = await request(`/${startupId}/wait`);
	rejectLaunch(new Error("browser unavailable before send"));
	const startupFailure = await startupRecovery.json();
	assert.match(startupFailure.preparationError, /browser unavailable before send/);
	assert.equal(startupFailure.deliveryUncertain, false, "definite startup failure releases a recovery wait");
	assert.equal(startupFailure.childThreadId, undefined);
	assert.equal((await (await request(`/${startupId}/wait`)).json()).deliveryUncertain, false,
		"recovery also returns an already saved pre-send failure");
	await jobs.cancel(startupId);
	browserLaunch = undefined;
	const payload = { prompt: "Test the checkout form at http://localhost:3000", requestId: "first" };
	const starts = await Promise.all([request("", payload), request("", payload)]);
	assert.equal(starts[0].status, 200);
	const jobId = starts[0].headers.get("x-job-id");
	assert.equal(jobId, starts[1].headers.get("x-job-id"), "retries hold the same assignment");
	const send = await claim();
	assert.equal(send.kind, "send_message");
	assert.ok(send.message.includes(payload.prompt));
	assert.ok(send.message.includes(jobId));
	assert.match(send.message, /rename that file/);
	assert.doesNotMatch(send.message, /task_done|start_task|sync_current_thread/);
	assert.equal(await commands.claim("other", ["threadMessaging"], 0), undefined, "duplicate requests dispatch one worker");
	sent(send);
	const job = await jobs.job(jobId);
	assert.equal((await readFile(job.specPath, "utf8")).trim(), payload.prompt);
	const bodies = starts.map(response => response.json());
	await writeFile(job.resultPath + ".tmp", "Partial report");
	assert.equal(await Promise.race([bodies[0].then(() => "returned"), delay(80, "waiting")]), "waiting", "temporary files do not release the caller");
	await writeFile(job.resultPath, "   ");
	assert.equal(await Promise.race([bodies[0].then(() => "returned"), delay(80, "waiting")]), "waiting", "empty final files do not signal completion");
	const evidenceDirectory = path.join(directory, "recordings", jobId);
	await mkdir(evidenceDirectory, { recursive: true });
	await writeFile(path.join(evidenceDirectory, "checkout.png"), "fixture");
	await writeFile(path.join(evidenceDirectory, "unfinished.partial.webm"), "fixture");
	await publish(job, "Checkout passed with observed evidence.");
	const results = await Promise.all(bodies);
	assert.equal(results[0].state, "complete");
	assert.equal(results[0].result.trim(), "Checkout passed with observed evidence.");
	assert.equal(results[1].result, results[0].result);
	assert.deepEqual(results[0].screenshots, [path.join(evidenceDirectory, "checkout.png")]);
	assert.deepEqual(results[0].videos, []);
	assert.equal((await request("", { ...payload, prompt: "different" })).status, 409);
	const unsent = await request("", { prompt: "Attachment failed", session: "unsent", requestId: "attachment" });
	const unsentCommand = await claim();
	commands.complete({ commandId: unsentCommand.id, browserId: "extension", kind: "send_message", ok: false,
		error: "ChatGPT send button did not become actionable.", deliveryUncertain: false });
	const unsentJob = await unsent.json();
	assert.equal(unsentJob.deliveryUncertain, false);
	assert.equal((await (await request(`/${unsentJob.jobId}/wait`)).json()).deliveryUncertain, false,
		"an executor-confirmed unsent assignment cannot leave recovery waiting for a nonexistent worker");
	await jobs.cancel(unsentJob.jobId);

	const failedPayload = { prompt: "Worker startup failure", requestId: "failed" };
	const failed = await request("", failedPayload);
	const failedCommand = await claim();
	commands.complete({ commandId: failedCommand.id, browserId: "extension", kind: "send_message", ok: false, error: "Delivery uncertain after Send" });
	const failedJob = await failed.json();
	assert.match(failedJob.preparationError, /Delivery uncertain/);
	assert.equal((await (await request("", failedPayload)).json()).jobId, failedJob.jobId);
	assert.equal(await commands.claim("extension", ["threadMessaging"], 0), undefined, "uncertain sends are not replayed");
	const reserved = await jobs.create({ threadId: "api:local" });
	assert.equal((await request("", { prompt: "Capacity", requestId: "capacity" })).status, 429);
	await jobs.cancel(reserved.jobId);
	const uncertainRecovery = await request(`/${failedJob.jobId}/wait`);
	const uncertainBody = uncertainRecovery.json();
	assert.equal(await Promise.race([uncertainBody.then(() => "returned"), delay(80, "waiting")]), "waiting",
		"recovery waits for a report even when the send acknowledgement was lost");
	await publish(await jobs.job(failedJob.jobId), "Worker ran despite a lost send acknowledgement");
	assert.equal((await uncertainBody).state, "complete");

	const connection = new AbortController();
	const interruptedPayload = { prompt: "Continue after client disconnect", session: "disconnect", requestId: "same" };
	const disconnected = await request("", interruptedPayload, {}, connection.signal);
	const disconnectedId = disconnected.headers.get("x-job-id");
	const disconnectedBody = disconnected.json();
	const rejectedBody = assert.rejects(disconnectedBody);
	const disconnectedSend = await claim();
	sent(disconnectedSend);
	connection.abort();
	await rejectedBody;
	const recovered = await request(`/${disconnectedId}/wait`);
	const retried = await request("", interruptedPayload);
	assert.equal(retried.headers.get("x-job-id"), disconnectedId);
	assert.equal(await commands.claim("extension", ["threadMessaging"], 0), undefined, "reconnecting does not create another worker");
	await publish(await jobs.job(disconnectedId), "Report survives caller disconnection");
	assert.equal((await recovered.json()).result.trim(), "Report survives caller disconnection");
	assert.equal((await retried.json()).state, "complete");

	await writeFile(path.join(directory, "support-extension-token"), "test-token\n");
	const cli = path.resolve("dist/cli.js");
	const run = promisify(execFile)(process.execPath, [cli, "run", "--prompt", "Test one long request", "--session", "cli-test", "--request-id", "cli-one"], {
		cwd: directory, timeout: 30_000,
		env: { ...process.env, DATA_DIR: directory, THREAD_SYNC_PORT: String(server.address().port) },
	});
	const cliSend = await claim();
	sent(cliSend);
	const cliJob = (await jobs.forParent("api:cli-test"))[0];
	await delay(16_000);
	await publish(cliJob, "CLI received its report through one held request");
	const runResult = await run;
	assert.equal(JSON.parse(runResult.stdout).result.trim(), "CLI received its report through one held request");
	assert.match(runResult.stderr, /Recover an interrupted connection/);
	assert.equal(requests.filter(req => req.session === "cli-test").length, 1);
	assert.equal(requests.filter(req => req.url.includes("/wait")).length, 5, "only explicit recovery requests use wait");
	const status = await promisify(execFile)(process.execPath, [cli, "status", cliJob.jobId], {
		env: { ...process.env, DATA_DIR: directory, THREAD_SYNC_PORT: String(server.address().port) },
	});
	assert.equal(JSON.parse(status.stdout).state, "complete");
	assert.equal((await request("/not-a-job/wait")).status, 404);
	assert.equal((await request(`/${jobId}/cancel`, {})).status, 404, "local callers have no cancel endpoint");

	const restartJob = await jobs.create({ threadId: "api:restart", requestId: "restart", promptHash: "hash" });
	await jobs.close();
	await publish(restartJob, "Published while the service was stopped");
	reopened = await SubagentJobRegistry.open(directory);
	assert.equal((await reopened.job(restartJob.jobId)).state, "complete");
	assert.equal((await reopened.job(restartJob.jobId)).preparationError, undefined);
	assert.equal((await reopened.create({ threadId: "api:restart", requestId: "restart", promptHash: "hash" })).jobId, restartJob.jobId);
	const restartedRegistry = await RalphRegistry.open(directory);
	assert.ok((await restartedRegistry.threads()).some(thread => thread.parentThreadId === "api:local"),
		"the service can reload worker registrations with local API parent sessions");
	console.log("Agent API passed: one blocking request, file completion, retry deduplication, disconnect recovery, startup failure, capacity, evidence, CLI keepalive, and restart recovery.");
} finally {
	commands.close();
	await jobs.close();
	await reopened?.close();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	assert.equal(path.dirname(directory), os.tmpdir());
	await rm(directory, { recursive: true, force: true });
}
