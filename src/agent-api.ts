import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { startSubagentJob, cancelSubagentJob, type SupportCommandBus, type RalphRegistry, type ThreadPreparationCoordinator } from "./chatgpt-support.js";
import { SubagentAdmissionError, type SubagentJobRegistry } from "./subagent-jobs.js";

const startSchema = z.object({
  prompt: z.string().trim().min(1).max(180_000),
  session: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).default("claude"),
  requestId: z.string().min(1).max(100).optional(),
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

  router.post("/", async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    const { prompt, session, requestId } = parsed.data;
    try {
      const job = await input.jobs.create({
        threadId: `api:${session}`, requestId,
        promptHash: createHash("sha256").update(prompt).digest("hex"),
      });
      if (job.state === "pending" && !job.childThreadId && !job.preparationError && !starting.has(job.jobId)) {
        starting.add(job.jobId);
        const task = [
          prompt,
          "",
          "For browser testing, use this server's browser_* tools through the installed Local Codex browser extension.",
          "Open the requested site, inspect a fresh snapshot, and verify the actual result after each meaningful action.",
          `Before interacting with each test tab, start browser_recording with its tabId and jobId ${JSON.stringify(job.jobId)}.`,
          "Use browser_snapshot with includeScreenshot=true to inspect the actual rendered image, especially for visual checks.",
          `Save important evidence with browser_screenshot and jobId ${JSON.stringify(job.jobId)}. Use fullPage or clip when helpful.`,
          "Keep recording through the test. Stop each recording before releasing its tab and include the returned video paths in your report.",
          "Report the steps performed, expected and observed outcomes, failures, and artifact paths. If a tool, login, or recording is unavailable, report the exact blocker. Never claim unperformed checks passed.",
        ].join("\n");
        void startSubagentJob(job, task, input).catch(async (error: unknown) => {
          await input.jobs.recordPreparationFailure(job.jobId, error instanceof Error ? error.message : String(error));
        }).catch((error: unknown) => console.error("[agents] Could not persist startup failure:", error))
          .finally(() => starting.delete(job.jobId));
      }
      res.status(202).json(job);
    } catch (error) {
      res.status(error instanceof SubagentAdmissionError ? 429 : 409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/", async (req, res) => {
    const session = startSchema.shape.session.safeParse(req.query.session);
    if (!session.success) { res.status(400).json({ error: "Invalid session." }); return; }
    res.json({ jobs: await input.jobs.forParent(`api:${session.data}`) });
  });

  router.get("/:jobId", async (req, res) => {
    const job = await input.jobs.job(req.params.jobId);
    if (!job || job.parentConversationUrl) { res.status(404).json({ error: "API job not found." }); return; }
    const directory = path.resolve(input.dataDirectory, "recordings", job.jobId);
    const files = await readdir(directory).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    res.json({ ...job, result: job.state === "complete" ? await readFile(job.resultPath, "utf8") : null,
      videos: files.filter((file) => file.endsWith(".webm") && !file.endsWith(".partial.webm")).map((file) => path.join(directory, file)),
      screenshots: files.filter((file) => file.endsWith(".png")).map((file) => path.join(directory, file)) });
  });

  router.post("/:jobId/cancel", async (req, res) => {
    const job = await input.jobs.job(req.params.jobId);
    if (!job || job.parentConversationUrl) { res.status(404).json({ error: "API job not found." }); return; }
    try {
      if (starting.has(job.jobId)) throw new Error("Child startup is still in progress. Wait for its startup result before cancelling.");
      res.json(await cancelSubagentJob(job, input));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}
