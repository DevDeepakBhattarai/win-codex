import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { authenticateSupportExtension, parseConversationUrl, type RalphRegistry,
	type SupportCommandBus, type ThreadPreparationCoordinator } from "./chatgpt-support.js";

const taskInput = z.object({
	prompt: z.string().trim().min(1).max(180_000),
	runAt: z.iso.datetime({ offset: true }),
	repeatIntervalSeconds: z.number().int().min(60).max(31_536_000).optional(),
}).strict();
const taskSchema = taskInput.extend({
	id: z.uuid(),
	createdAt: z.iso.datetime(),
	state: z.enum(["pending", "sending", "sent", "failed", "missed", "cancelled"]),
	conversationUrl: z.string().url().optional(),
	error: z.string().optional(),
	lastRunAt: z.iso.datetime().optional(),
	lastRunState: z.enum(["sent", "failed", "missed"]).optional(),
});
type ScheduledTask = z.infer<typeof taskSchema>;

function advanceRepeat(task: ScheduledTask, now: number) {
	if (task.repeatIntervalSeconds === undefined) return false;
	const intervalMs = task.repeatIntervalSeconds * 1000;
	const scheduledAt = Date.parse(task.runAt);
	const intervals = Math.max(1, Math.floor((now - scheduledAt) / intervalMs) + 1);
	task.runAt = new Date(scheduledAt + intervals * intervalMs).toISOString();
	task.state = "pending";
	return true;
}
const storeSchema = z.object({ version: z.literal(1), tasks: z.array(taskSchema).max(1000) });
type ScheduleServices = {
	commands: SupportCommandBus;
	registry: RalphRegistry;
	preparer: ThreadPreparationCoordinator;
	launchBrowser: () => Promise<void>;
};

export class ScheduledTasks {
	private queue: Promise<unknown> = Promise.resolve();
	private timer?: NodeJS.Timeout;
	private ticking = false;

	private constructor(private readonly filePath: string, private tasks: ScheduledTask[]) {}

	static async open(dataDirectory: string) {
		await mkdir(dataDirectory, { recursive: true });
		const filePath = path.join(dataDirectory, "scheduled-tasks.json");
		let tasks: ScheduledTask[] = [];
		try {
			tasks = storeSchema.parse(JSON.parse(await readFile(filePath, "utf8"))).tasks;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		const schedules = new ScheduledTasks(filePath, tasks);
		await schedules.update(entries => {
			for (const task of entries) {
				if (task.state === "sending") {
					task.state = "failed";
					task.lastRunState = "failed";
					task.error = "Server stopped during delivery. This occurrence was not retried. Inspect ChatGPT before sending the prompt again.";
					advanceRepeat(task, Date.now());
				} else if (task.state === "pending" && Date.parse(task.runAt) <= Date.now()) {
					task.state = "missed";
					task.lastRunState = "missed";
					task.error = "The server was off at the scheduled time. This occurrence was skipped.";
					advanceRepeat(task, Date.now());
				}
			}
		});
		return schedules;
	}

	start(services: ScheduleServices) {
		this.timer = setInterval(() => void this.tick(services).catch((error: unknown) =>
			console.error("[schedules] Task check failed:", error)), 1000);
		this.timer.unref();
	}

	close() { clearInterval(this.timer); }

	async all() {
		await this.queue;
		return structuredClone(this.tasks);
	}

	async create(input: z.infer<typeof taskInput>) {
		const parsed = taskInput.parse(input);
		if (Date.parse(parsed.runAt) <= Date.now()) throw new Error("Choose a future date and time.");
		return this.update(tasks => {
			if (tasks.length >= 1000) throw new Error("Remove old schedules before adding more tasks.");
			const task: ScheduledTask = { ...parsed, runAt: new Date(parsed.runAt).toISOString(),
				id: randomUUID(), createdAt: new Date().toISOString(), state: "pending" };
			tasks.push(task);
			return { ...task };
		});
	}

	async cancel(id: string) {
		return this.update(tasks => {
			const task = tasks.find(entry => entry.id === id);
			if (!task) throw new Error("Scheduled task not found.");
			if (task.state !== "pending" && !(task.state === "sending" && task.repeatIntervalSeconds !== undefined)) {
				throw new Error("Only pending schedules or a repeating schedule can be cancelled.");
			}
			task.state = "cancelled";
			return { ...task };
		});
	}

	async remove(id: string) {
		return this.update(tasks => {
			const index = tasks.findIndex(entry => entry.id === id);
			if (index === -1) throw new Error("Scheduled task not found.");
			if (["pending", "sending"].includes(tasks[index].state)) throw new Error("Cancel a pending schedule before removing it.");
			tasks.splice(index, 1);
		});
	}

	async tick(services: ScheduleServices) {
		if (this.ticking || services.commands.automationPausedUntil() || services.commands.messageCooldownUntil()) return;
		this.ticking = true;
		try {
			// Claim and persist before sending. A restart must never resend an uncertain delivery.
			const task = await this.update(tasks => {
				const due = tasks.filter(entry => entry.state === "pending" && Date.parse(entry.runAt) <= Date.now())
					.sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))[0];
				if (!due) return undefined;
				due.state = "sending";
				due.lastRunAt = new Date().toISOString();
				due.lastRunState = undefined;
				return { ...due };
			});
			if (!task) return;
			let conversationUrl: string | undefined;
			try {
				await services.commands.ensureBrowser("threadMessaging", services.launchBrowser);
				await this.queue;
				if (this.tasks.find(entry => entry.id === task.id)?.state !== "sending") return;
				const result = await services.commands.execute({ feature: "threadMessaging", kind: "send_message",
					targetUrl: "https://chatgpt.com/", temporary: true, message: task.prompt,
					connectorName: process.env.CHATGPT_WORKER_CONNECTOR_NAME ?? "Codex" });
				if (!result.ok) throw new Error(result.error);
				if (result.kind !== "send_message") throw new Error("Unexpected scheduled task result.");
				conversationUrl = parseConversationUrl(result.result.conversationUrl).conversationUrl;
				await services.registry.register(conversationUrl, { agentCreated: true, title: result.result.title });
				services.preparer.markPrepared(conversationUrl);
				await this.update(tasks => {
					const current = tasks.find(entry => entry.id === task.id);
					if (current) {
						if (conversationUrl) current.conversationUrl = conversationUrl;
						current.lastRunState = "sent";
						current.error = undefined;
						if (current.state !== "cancelled") {
							current.state = "sent";
							advanceRepeat(current, Date.now());
						}
					}
				});
			} catch (error) {
				await this.update(tasks => {
					const current = tasks.find(entry => entry.id === task.id);
					if (current) {
						if (conversationUrl) current.conversationUrl = conversationUrl;
						current.lastRunState = "failed";
						current.error = `${error instanceof Error ? error.message : String(error)} This occurrence was not retried. Inspect ChatGPT if delivery is uncertain.`.slice(0, 2000);
						if (current.state !== "cancelled") {
							current.state = "failed";
							advanceRepeat(current, Date.now());
						}
					}
				});
			}
		} finally { this.ticking = false; }
	}

	private update<T>(operation: (tasks: ScheduledTask[]) => T): Promise<T> {
		const result = this.queue.then(async () => {
			const next = structuredClone(this.tasks);
			const value = operation(next);
			if (JSON.stringify(next) !== JSON.stringify(this.tasks)) {
				await writeFile(`${this.filePath}.tmp`, `${JSON.stringify({ version: 1, tasks: next }, null, 2)}\n`, { mode: 0o600 });
				await rename(`${this.filePath}.tmp`, this.filePath);
				this.tasks = next;
			}
			return value;
		});
		this.queue = result.catch(() => undefined);
		return result;
	}
}

export function createScheduleApi(schedules: ScheduledTasks, token: string) {
	const router = Router();
	router.use((req, res, next) => {
		if (!authenticateSupportExtension(req, res, token)) return;
		res.setHeader("Cache-Control", "no-store");
		next();
	});
	router.get("/", async (_req, res) => { res.json({ tasks: await schedules.all() }); });
	router.post("/", async (req, res) => {
		const parsed = taskInput.safeParse(req.body);
		if (!parsed.success) { res.status(400).json({ error: "Enter a prompt and a valid date and time." }); return; }
		try { res.status(201).json({ task: await schedules.create(parsed.data) }); }
		catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
	});
	router.put("/:id/cancel", async (req, res) => {
		try { res.json({ task: await schedules.cancel(z.uuid().parse(req.params.id)) }); }
		catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
	});
	router.delete("/:id", async (req, res) => {
		try { await schedules.remove(z.uuid().parse(req.params.id)); res.json({ status: "removed" }); }
		catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
	});
	return router;
}
