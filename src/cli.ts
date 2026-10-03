#!/usr/bin/env node
import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const jobSchema = z.object({ jobId: z.string().uuid(), state: z.enum(["pending", "complete", "cancelled"]), preparationError: z.string().optional() }).passthrough();
const connectorDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(connectorDirectory, ".env"), quiet: true });

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    prompt: { type: "string" }, file: { type: "string" }, session: { type: "string" },
    "request-id": { type: "string" }, help: { type: "boolean" },
  } });
  const [command, jobId] = positionals;
  if (values.help || !command) {
    console.log('win-codex-agent run --file spec.md [--session ID] [--request-id ID]\nwin-codex-agent start --prompt "Test http://localhost:3000" [--session ID] [--request-id ID]\nwin-codex-agent wait JOB_ID\nwin-codex-agent list [--session ID]\nwin-codex-agent status JOB_ID\nwin-codex-agent cancel JOB_ID');
  } else {
    if (!["start", "run", "wait", "list", "status", "cancel"].includes(command)) throw new Error(`Unknown command: ${command}`);
    const needsId = ["wait", "status", "cancel"].includes(command);
    if (positionals.length > (needsId ? 2 : 1)) throw new Error("Unexpected positional argument.");
    if (needsId && !z.uuid().safeParse(jobId).success) throw new Error("A job UUID is required.");
    if (values.prompt && values.file) throw new Error("Use --prompt or --file, not both.");
    const prompt = values.file ? await readFile(values.file, "utf8") : values.prompt;
    const starts = command === "start" || command === "run";
    if (starts && !prompt?.trim()) throw new Error(`${command} requires --prompt or --file.`);
    const dataDirectory = path.resolve(connectorDirectory, process.env.DATA_DIR ?? ".data");
    const token = (await readFile(path.join(dataDirectory, "support-extension-token"), "utf8")).trim();
    const base = `http://127.0.0.1:${process.env.THREAD_SYNC_PORT ?? 6002}/agents`;
    const url = command === "list" ? `${base}?session=${encodeURIComponent(values.session ?? "claude")}`
      : starts ? base : `${base}/${jobId}${command === "cancel" ? "/cancel" : command === "wait" ? "/wait" : ""}`;
    const requestId = values["request-id"] ?? (starts ? randomUUID() : undefined);
    const response = await fetch(url, {
      method: starts || command === "cancel" ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: starts ? JSON.stringify({ prompt, session: values.session, requestId }) : undefined,
      signal: AbortSignal.timeout(command === "wait" ? 60_000 : 15_000),
    });
    let body: unknown = await response.json();
    if (!response.ok) {
      console.log(JSON.stringify(body, null, 2));
      process.exitCode = 1;
    } else if (command === "run" || command === "wait") {
      let job = jobSchema.parse(body);
      console.error(`Task ${job.jobId}. Resume this wait with: win-codex-agent wait ${job.jobId}`);
      while (job.state === "pending" && !job.preparationError) {
        const waiting = await fetch(`${base}/${job.jobId}/wait`, {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000),
        });
        body = await waiting.json();
        if (!waiting.ok) throw new Error(`Task wait failed with HTTP ${waiting.status}. Resume the saved job; do not start another task.`);
        job = jobSchema.parse(body);
      }
      console.log(JSON.stringify(body, null, 2));
      if (job.state === "cancelled" || job.preparationError) process.exitCode = 1;
    } else {
      console.log(JSON.stringify(body, null, 2));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
