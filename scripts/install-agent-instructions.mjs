import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = path.join(root, "docs", "delegation.md").replaceAll("\\", "/");
const marker = "<!-- local-codex-delegation -->";
const endMarker = "<!-- /local-codex-delegation -->";
const instruction = `${marker}\nFor test execution, browser checks, visual checks, or failure reproduction, read [the ChatGPT delegation workflow](${workflow}) and delegate a bounded specification. Keep planning and implementation in the parent. End the parent turn after dispatch and use the runner's completion notification. Do not poll with model calls. If you are the assigned ChatGPT worker with a job ID, execute and report through task_done without nested delegation.\n${endMarker}`;
const backupDirectory = path.join(root, ".data", "instruction-backups");
await mkdir(backupDirectory, { recursive: true });
for (const [directory, name] of [[".codex", "AGENTS.md"], [".claude", "CLAUDE.md"]]) {
	const target = path.join(os.homedir(), directory, name);
	await mkdir(path.dirname(target), { recursive: true });
	let existing = "";
	try {
		existing = await readFile(target, "utf8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	let next;
	if (existing.includes(marker)) {
		const start = existing.indexOf(marker);
		const end = existing.indexOf(endMarker, start);
		if (end < 0) throw new Error(`Unclosed delegation instruction in ${target}`);
		next = existing.slice(0, start) + instruction + existing.slice(end + endMarker.length);
	} else {
		next = `${existing.trimEnd()}\n\n${instruction}\n`;
	}
	if (next === existing) continue;
	if (existing) await copyFile(target, path.join(backupDirectory, `${directory.slice(1)}-${Date.now()}.md`));
	await writeFile(target, next, "utf8");
	console.log(`Installed delegation instructions: ${target}`);
}
