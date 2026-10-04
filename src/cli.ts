#!/usr/bin/env node
import { config } from "dotenv";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const jobSchema = z.object({
	jobId: z.uuid(), state: z.enum(["pending", "complete", "cancelled"]),
	preparationError: z.string().optional(), result: z.string().nullable().optional(),
}).passthrough();
const installationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(installationDirectory, ".env"), quiet: true });

async function main() {
	const { values, positionals } = parseArgs({ allowPositionals: true, options: {
		prompt: { type: "string" }, file: { type: "string" }, session: { type: "string" },
		"request-id": { type: "string" }, help: { type: "boolean" },
	} });
	const [command, jobId] = positionals;
	if (values.help || !command) {
		console.log('win-codex-agent run --file spec.md [--session ID] [--request-id ID]\nwin-codex-agent wait JOB_ID\nwin-codex-agent status JOB_ID\nwin-codex-agent list [--session ID]');
		return;
	}
	if (!["run", "wait", "status", "list"].includes(command)) throw new Error(`Unknown command: ${command}`);
	const needsId = command === "wait" || command === "status";
	if (positionals.length !== (needsId ? 2 : 1)) throw new Error("Unexpected or missing positional argument.");
	if (needsId && !z.uuid().safeParse(jobId).success) throw new Error("A job UUID is required.");
	if (values.prompt && values.file) throw new Error("Use --prompt or --file, not both.");
	if (command !== "run" && (values.prompt || values.file || values["request-id"])) throw new Error("Assignment options require run.");
	const prompt = values.file ? await readFile(values.file, "utf8") : values.prompt;
	if (command === "run" && !prompt?.trim()) throw new Error("run requires --prompt or --file.");
	const workspace = await realpath(process.cwd());
	const session = values.session ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID
		?? `local-${createHash("sha256").update(process.platform === "win32" ? workspace.toLowerCase() : workspace).digest("hex").slice(0, 32)}`;
	const dataDirectory = path.resolve(installationDirectory, process.env.DATA_DIR ?? ".data");
	const token = (await readFile(path.join(dataDirectory, "support-extension-token"), "utf8")).trim();
	const base = `http://127.0.0.1:${process.env.THREAD_SYNC_PORT ?? 6002}/agents`;
	const url = command === "list" ? `${base}?session=${encodeURIComponent(session)}`
		: command === "run" ? base : `${base}/${jobId}${command === "wait" ? "/wait" : ""}`;
	const requestId = values["request-id"] ?? randomUUID();
	if (command === "run") console.error(`Assignment ${requestId}. Reuse this request ID if dispatch is interrupted.`);
	const response = await fetch(url, {
		method: command === "run" ? "POST" : "GET",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: command === "run" ? JSON.stringify({ prompt, session, requestId }) : undefined,
	});
	const assignedId = response.headers.get("x-job-id");
	if (assignedId) console.error(`Task ${assignedId}. Recover an interrupted connection with: win-codex-agent wait ${assignedId}`);
	const body: unknown = await response.json();
	console.log(JSON.stringify(body, null, 2));
	if (!response.ok) { process.exitCode = 1; return; }
	if (command === "run" || command === "wait") {
		const job = jobSchema.parse(body);
		if (job.state !== "complete" || !job.result?.trim() || job.preparationError) process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
