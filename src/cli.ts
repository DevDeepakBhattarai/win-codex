#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    prompt: { type: "string" }, file: { type: "string" }, session: { type: "string" },
    "request-id": { type: "string" }, help: { type: "boolean" },
  } });
  const [command, jobId] = positionals;
  if (values.help || !command) {
    console.log('win-codex-agent start --prompt "Test http://localhost:3000" [--session claude] [--request-id ID]\nwin-codex-agent start --file prompt.txt\nwin-codex-agent list [--session claude]\nwin-codex-agent status JOB_ID\nwin-codex-agent cancel JOB_ID');
  } else {
    if (!["start", "list", "status", "cancel"].includes(command)) throw new Error(`Unknown command: ${command}`);
    if (positionals.length > (command === "status" || command === "cancel" ? 2 : 1)) throw new Error("Unexpected positional argument.");
    if ((command === "status" || command === "cancel") && !/^[0-9a-f-]{36}$/i.test(jobId ?? "")) throw new Error("A job UUID is required.");
    if (values.prompt && values.file) throw new Error("Use --prompt or --file, not both.");
    const prompt = values.file ? await readFile(values.file, "utf8") : values.prompt;
    if (command === "start" && !prompt?.trim()) throw new Error("start requires --prompt or --file.");
    const dataDirectory = path.resolve(process.env.DATA_DIR ?? ".data");
    const token = (await readFile(path.join(dataDirectory, "support-extension-token"), "utf8")).trim();
    const base = `http://127.0.0.1:${process.env.THREAD_SYNC_PORT ?? 6002}/agents`;
    const url = command === "list" ? `${base}?session=${encodeURIComponent(values.session ?? "claude")}`
      : command === "start" ? base : `${base}/${jobId}${command === "cancel" ? "/cancel" : ""}`;
    const response = await fetch(url, {
      method: command === "start" || command === "cancel" ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: command === "start" ? JSON.stringify({ prompt, session: values.session, requestId: values["request-id"] }) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json();
    console.log(JSON.stringify(body, null, 2));
    if (!response.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
