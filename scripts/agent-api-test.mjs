import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createAgentApi } from "../dist/agent-api.js";
import { SubagentJobRegistry } from "../dist/subagent-jobs.js";
import { RalphRegistry, SupportCommandBus, SubagentResultController, ThreadPreparationCoordinator } from "../dist/chatgpt-support.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "agent-api-test-"));
const jobs = await SubagentJobRegistry.open(directory);
const registry = await RalphRegistry.open(directory);
const commands = new SupportCommandBus(undefined, undefined, 0);
const preparer = new ThreadPreparationCoordinator(commands, { hasThread: async () => true }, async () => {});
const controller = new SubagentResultController(jobs, commands, async () => {}, 60_000, 0);
const app = express();
app.use(express.json());
app.use("/agents", createAgentApi({ token: "test-token", jobs, registry, commands, preparer, dataDirectory: directory, launchBrowser: async () => {} }));
const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
const url = `http://127.0.0.1:${server.address().port}/agents`;
const request = async (suffix = "", body, headers = {}) => {
  const response = await fetch(url + suffix, { method: body ? "POST" : "GET", headers: { authorization: "Bearer test-token", "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const completeCommand = (command, result) => commands.complete({ commandId: command.id, browserId: "extension", kind: command.kind, ok: true, result });
const claim = () => commands.claim("extension", ["threadMessaging", "threadPreparation"], 1000);
try {
  assert.equal((await request("", undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await request("", { prompt: "x" }, { origin: "https://example.com" })).status, 401);
  assert.equal((await request("", { prompt: " " })).status, 400);
  const payload = { prompt: "Test the checkout form at http://localhost:3000", requestId: "first" };
  const starts = await Promise.all([request("", payload), request("", payload)]);
  assert.equal(starts[0].status, 202);
  assert.equal(starts[0].body.jobId, starts[1].body.jobId, "retries reserve and send only one child");
  const jobId = starts[0].body.jobId;
  const send = await claim();
  assert.equal(send.kind, "send_message");
  assert.ok(send.message.includes(payload.prompt));
  assert.ok(send.message.includes(jobId));
  assert.match(send.message, /browser_recording/);
  assert.match(send.message, /submit_subagent_result/);
  assert.equal(await commands.claim("other", ["threadMessaging"], 0), undefined);
  const childUrl = `https://chatgpt.com/c/${randomUUID()}`;
  completeCommand(send, { status: "sent", conversationUrl: childUrl });
  const prepare = await claim();
  assert.equal(prepare.kind, "prepare_thread");
  completeCommand(prepare, { status: "prepared", conversationUrl: childUrl });
  assert.equal((await request(`/${jobId}`)).body.childConversationUrl, childUrl);
  assert.equal((await request("", { ...payload, prompt: "different" })).status, 409);

  const second = await request("", { prompt: "Second task", requestId: "second" });
  const failedSend = await claim();
  commands.complete({ commandId: failedSend.id, browserId: "extension", kind: "send_message", ok: false, error: "Delivery uncertain after Send" });
  await new Promise(resolve => setTimeout(resolve, 20));
  const failure = await request(`/${second.body.jobId}`);
  assert.match(failure.body.preparationError, /Delivery uncertain/);
  assert.equal((await request("", { prompt: "Third task" })).status, 429, "uncertain delivery keeps its slot");
  await request("", { prompt: "Second task", requestId: "second" });
  assert.equal(await commands.claim("extension", ["threadMessaging"], 0), undefined, "failed sends are never replayed");
  assert.equal((await request(`/${second.body.jobId}/cancel`, {})).body.state, "cancelled");

  const cancelling = request(`/${jobId}/cancel`, {});
  const stop = await claim();
  assert.equal(stop.kind, "stop_thread");
  commands.complete({ commandId: stop.id, browserId: "extension", kind: "stop_thread", ok: false, error: "Stop not confirmed" });
  assert.equal((await cancelling).status, 409);
  assert.equal((await request(`/${jobId}`)).body.state, "pending");
  await jobs.complete(jobId, "Checkout test passed, with evidence.");
  assert.equal((await request(`/${jobId}`)).body.result, "Checkout test passed, with evidence.\n");
  await writeFile(path.join(directory, "support-extension-token"), "test-token\n");
  const cli = await promisify(execFile)(process.execPath, ["dist/cli.js", "status", jobId], {
    env: { ...process.env, DATA_DIR: directory, THREAD_SYNC_PORT: String(server.address().port) },
  });
  assert.equal(JSON.parse(cli.stdout).result, "Checkout test passed, with evidence.\n", "CLI reads the local token and retrieves the API report");
  await controller.tick();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await commands.claim("extension", ["threadMessaging"], 0), undefined, "API results never send a parent message");
  assert.equal((await request()).body.jobs.length, 2);

  const interrupted = await jobs.create({ threadId: "api:restart", requestId: "restart", promptHash: "hash" });
  const reopened = await SubagentJobRegistry.open(directory);
  assert.match((await reopened.job(interrupted.jobId)).preparationError, /interrupted/);
  assert.equal((await reopened.create({ threadId: "api:restart", requestId: "restart", promptHash: "hash" })).jobId, interrupted.jobId);
  console.log("Agent API: async dispatch, retry deduplication, results, capacity, failed stop, and restart recovery passed.");
} finally {
  controller.close();
  commands.close();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(directory), os.tmpdir());
  await rm(directory, { recursive: true, force: true });
}
