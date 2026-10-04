import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Router, type Response } from "express";
import { z } from "zod";
import { startSubagentJob, type SupportCommandBus, type RalphRegistry, type ThreadPreparationCoordinator } from "./chatgpt-support.js";
import { SubagentAdmissionError, type SubagentJobRegistry } from "./subagent-jobs.js";

const startSchema = z.object({
	prompt: z.string().trim().min(1).max(180_000),
	session: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).default("local"),
	requestId: z.string().min(1).max(100),
}).strict();

export function createAgentApi(input: {
	token: string;
	jobs: SubagentJobRegistry;
	commands: SupportCommandBus;
	registry: RalphRegistry;
	preparer: ThreadPreparationCoordinator;
	launchBrowser: () => Promise<void>;
	dataDirectory: string;
}) {
	const router = Router();
	const starting = new Set<string>();
	router.use((req, res, next) => {
		const provided = Buffer.from(req.get("authorization") ?? "");
		const expected = Buffer.from(`Bearer ${input.token}`);
		if (req.get("origin") || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
			res.status(401).json({ error: "Local API bearer token required. Browser-origin requests are not accepted." });
			return;
		}
		res.setHeader("Cache-Control", "no-store");
		next();
	});

	const readJob = async (job: NonNullable<Awaited<ReturnType<SubagentJobRegistry["job"]>>>) => {
		const directory = path.resolve(input.dataDirectory, "recordings", job.jobId);
		const files = await readdir(directory).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		});
		return { ...job, result: job.state === "complete" ? await readFile(job.resultPath, "utf8") : null,
			videos: files.filter((file) => file.endsWith(".webm") && !file.endsWith(".partial.webm")).map((file) => path.join(directory, file)),
			screenshots: files.filter((file) => file.endsWith(".png")).map((file) => path.join(directory, file)) };
	};

	const wait = async (jobId: string, res: Response, returnStartupFailure: boolean) => {
		if (res.destroyed) return;
		const controller = new AbortController();
		const disconnected = () => controller.abort(new Error("Caller disconnected."));
		res.once("close", disconnected);
		res.setHeader("Content-Type", "application/json");
		res.setHeader("X-Job-Id", jobId);
		res.flushHeaders();
		// JSON whitespace keeps one response alive during a long assignment.
		const heartbeat = setInterval(() => res.write("\n"), 15_000);
		try {
			const job = await input.jobs.waitForResult(jobId, controller.signal, returnStartupFailure);
			if (job && !controller.signal.aborted) res.end(JSON.stringify(await readJob(job)));
		} catch (error) {
			if (!controller.signal.aborted) res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), jobId }));
		} finally {
			clearInterval(heartbeat);
			res.off("close", disconnected);
		}
	};

	router.post("/", async (req, res) => {
		const parsed = startSchema.safeParse(req.body);
		if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
		const { prompt, session, requestId } = parsed.data;
		let job;
		try {
			job = await input.jobs.create({
				threadId: `api:${session}`, requestId,
				promptHash: createHash("sha256").update(prompt).digest("hex"), prompt,
			});
		} catch (error) {
			res.status(error instanceof SubagentAdmissionError ? 429 : 409).json({ error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (job.state === "pending" && !job.childThreadId && !job.preparationError && !starting.has(job.jobId)) {
			starting.add(job.jobId);
			void startSubagentJob(job, prompt, input).catch((error: unknown) => console.error("[agents] Worker startup failed:", error))
				.finally(() => starting.delete(job.jobId));
		}
		await wait(job.jobId, res, true);
	});

	router.get("/", async (req, res) => {
		const session = startSchema.shape.session.safeParse(req.query.session);
		if (!session.success) { res.status(400).json({ error: "Invalid session." }); return; }
		res.json({ jobs: await input.jobs.forParent(`api:${session.data}`) });
	});

	router.get("/:jobId/wait", async (req, res) => {
		const job = await input.jobs.job(req.params.jobId);
		if (!job || !job.parentThreadId.startsWith("api:")) { res.status(404).json({ error: "API job not found." }); return; }
		await wait(job.jobId, res, false);
	});

	router.get("/:jobId", async (req, res) => {
		const job = await input.jobs.job(req.params.jobId);
		if (!job || !job.parentThreadId.startsWith("api:")) { res.status(404).json({ error: "API job not found." }); return; }
		res.json(await readJob(job));
	});
	return router;
}
