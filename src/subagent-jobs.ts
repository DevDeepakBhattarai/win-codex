import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const MAX_JOBS = 2_000;
const RETAINED_COMPLETED_JOBS = 1_000;
export const MAX_ACTIVE_SUBAGENTS_PER_PARENT = 2;
const INTERRUPTED_STARTUP_ERROR = "Task startup was interrupted by a service restart. Inspect the browser, stop any running worker, then cancel this job if it is abandoned.";

export class SubagentAdmissionError extends Error {
  constructor(readonly reason: "capacity" | "nested", readonly activeJobIds: string[] = []) {
    super(reason === "nested"
      ? "Only root conversations can delegate. Execute the assignment and publish its report."
      : `This parent already has two active assignments: ${activeJobIds.join(", ")}. Wait for a report before another assignment.`);
  }
}

const subagentJobSchema = z.object({
  jobId: z.string().uuid(),
  parentThreadId: z.string(),
  parentConversationUrl: z.string().url().optional(),
  requestId: z.string().optional(),
  promptHash: z.string().optional(),
  childThreadId: z.string().optional(),
  childConversationUrl: z.string().url().optional(),
  title: z.string().optional(),
  resultPath: z.string(),
  specPath: z.string().optional(),
  state: z.enum(["pending", "complete", "cancelled"]),
  cancelledAt: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  preparationError: z.string().optional(),
  deliveryUncertain: z.boolean().optional(),
});

const subagentStoreSchema = z.object({
  version: z.literal(1),
  jobs: z.array(subagentJobSchema).max(MAX_JOBS),
});

type SubagentJob = z.infer<typeof subagentJobSchema>;
type SubagentStore = z.infer<typeof subagentStoreSchema>;

export class SubagentJobRegistry {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly changes = new EventEmitter().setMaxListeners(MAX_JOBS);
  private watcher?: FSWatcher;

  private constructor(
    private readonly filePath: string,
    private readonly resultDirectory: string,
    private state: SubagentStore,
  ) {}

  static async open(dataDirectory: string) {
    await mkdir(path.resolve(dataDirectory, "tasks"), { recursive: true });
    // Windows temporary paths can contain an 8.3 alias. libuv needs the real path.
    const resultDirectory = await realpath(path.resolve(dataDirectory, "tasks"));
    const filePath = path.join(resultDirectory, "jobs.json");
    let state: SubagentStore = { version: 1, jobs: [] };
    let needsPersist = false;
    try {
      state = subagentStoreSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      for (const legacyDirectory of ["reviews", "subagents"]) {
        try {
          state = subagentStoreSchema.parse(JSON.parse(await readFile(path.join(dataDirectory, legacyDirectory, "jobs.json"), "utf8")));
          needsPersist = true;
          break;
        } catch (legacyError) {
          if (!(legacyError instanceof Error && "code" in legacyError && legacyError.code === "ENOENT")) throw legacyError;
        }
      }
    }

    for (const job of state.jobs) {
      const nextResultPath = path.join(resultDirectory, `${job.jobId}.md`);
      if (path.resolve(job.resultPath) !== path.resolve(nextResultPath)) {
        try {
          await copyFile(job.resultPath, nextResultPath);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        job.resultPath = nextResultPath;
        needsPersist = true;
      }
      if (job.state === "pending" && !job.childThreadId && !job.preparationError) {
        job.preparationError = INTERRUPTED_STARTUP_ERROR;
        needsPersist = true;
      }
    }

    const unfinished = state.jobs.filter((job) => job.state === "pending");
    const completed = state.jobs
      .filter((job) => job.state !== "pending")
      .sort((left, right) => Date.parse(right.completedAt ?? right.createdAt) - Date.parse(left.completedAt ?? left.createdAt))
      .slice(0, RETAINED_COMPLETED_JOBS);
    const retained = [...unfinished, ...completed];
    if (retained.length !== state.jobs.length) needsPersist = true;
    state.jobs = retained;

    if (needsPersist) {
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, filePath);
    }
    const registry = new SubagentJobRegistry(filePath, resultDirectory, state);
    registry.watcher = watch(resultDirectory, (_event, filename) => {
      if (!filename) return;
      const job = registry.state.jobs.find((entry) => path.basename(entry.resultPath) === filename);
      if (job) void registry.collectReport(job.jobId).catch((error: unknown) => {
        console.error(`[tasks] Could not collect report ${job.jobId}:`, error);
      });
    });
    registry.watcher.unref();
    await Promise.all(state.jobs.filter((job) => job.state === "pending").map((job) => registry.collectReport(job.jobId)));
    return registry;
  }

  async create(parent: { threadId: string; conversationUrl?: string; requestId?: string; promptHash?: string; prompt?: string }) {
    return await this.update(async (state) => {
      const previous = parent.requestId && state.jobs.find((job) =>
        job.parentThreadId === parent.threadId && job.requestId === parent.requestId);
      if (previous) {
        if (previous.promptHash !== parent.promptHash) throw new Error("requestId already belongs to a different prompt.");
        return { ...previous, reused: true };
      }
      if (state.jobs.some((job) => job.childThreadId === parent.threadId)) {
        throw new SubagentAdmissionError("nested");
      }
      const active = state.jobs.filter((job) => job.parentThreadId === parent.threadId &&
        job.state === "pending");
      if (active.length >= MAX_ACTIVE_SUBAGENTS_PER_PARENT) {
        throw new SubagentAdmissionError("capacity", active.map((job) => job.jobId));
      }
      if (state.jobs.length >= MAX_JOBS) throw new Error("Task job limit reached.");
      const jobId = randomUUID();
      const job: SubagentJob = {
        jobId,
        parentThreadId: parent.threadId,
        parentConversationUrl: parent.conversationUrl,
        requestId: parent.requestId,
        promptHash: parent.promptHash,
        resultPath: path.join(this.resultDirectory, `${jobId}.md`),
        specPath: parent.prompt ? path.join(this.resultDirectory, `${jobId}.spec.md`) : undefined,
        state: "pending",
        createdAt: new Date().toISOString(),
      };
      if (job.specPath) await writeFile(job.specPath, `${parent.prompt?.trim()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      state.jobs.push(job);
      return { ...job, reused: false };
    });
  }

  async assignChild(jobId: string, child: { threadId: string; conversationUrl: string; title?: string }) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Task job not found.");
      job.childThreadId = child.threadId;
      job.childConversationUrl = child.conversationUrl;
      if (child.title) job.title = child.title;
      return { ...job };
    });
  }

  async cancel(jobId: string) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Task job not found.");
      if (job.state === "pending") {
        job.state = "cancelled";
        job.cancelledAt = new Date().toISOString();
      }
      return { ...job };
    });
  }

  async isWorker(threadId: string) {
    await this.queue;
    return this.state.jobs.some((job) => job.childThreadId === threadId);
  }

  async all() {
    await this.queue;
    return this.state.jobs.map((job) => ({ ...job }));
  }

  async blocksContinuation(threadId: string) {
    await this.queue;
    return this.blocksContinuationNow(threadId);
  }

  blocksContinuationNow(threadId: string) {
    return this.state.jobs.some((job) =>
      (job.childThreadId === threadId && job.state !== "pending") ||
      (job.parentThreadId === threadId && job.state === "pending"));
  }

  complete(jobId: string, result: string) {
    if (!result.trim() || result.length > 200_000) throw new Error("Report must contain 1 to 200000 characters.");
    const operation = this.queue.then(async () => {
      const current = this.state.jobs.find((entry) => entry.jobId === jobId);
      if (!current) throw new Error("Task job not found.");
      if (current.state === "cancelled") throw new Error("This task was cancelled. End this assignment.");
      if (current.state === "complete") return { job: { ...current }, newlyCompleted: false };

      const temporaryResultPath = `${current.resultPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryResultPath, `${result.trim()}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryResultPath, current.resultPath);

      const next = structuredClone(this.state);
      const target = next.jobs.find((entry) => entry.jobId === jobId);
      if (!target) throw new Error("Task job not found.");
      target.state = "complete";
      target.completedAt = new Date().toISOString();
      target.preparationError = undefined;
      target.deliveryUncertain = undefined;
      await this.persist(next);
      this.state = next;
      this.changes.emit("change");
      return { job: { ...target }, newlyCompleted: true };
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async recordPreparationFailure(jobId: string, error: string, deliveryUncertain = true) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Task job not found.");
      if (job.state !== "pending") return { ...job };
      job.preparationError = error.slice(0, 1_000);
      job.deliveryUncertain = deliveryUncertain;
      return { ...job };
    });
  }

  async job(jobId: string) {
    await this.queue;
    const job = this.state.jobs.find((entry) => entry.jobId === jobId);
    return job ? { ...job } : undefined;
  }

  async collectReport(jobId: string) {
    const job = await this.job(jobId);
    if (!job || job.state !== "pending") return;
    let result: string;
    try {
      result = await readFile(job.resultPath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (!result.trim() || result.length > 200_000) return;
    await this.complete(jobId, result);
  }

  waitForResult(jobId: string, signal: AbortSignal, returnStartupFailure: boolean) {
    return new Promise<SubagentJob | undefined>((resolve, reject) => {
      const finish = (error?: unknown) => {
        this.changes.off("change", changed);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else {
          const job = this.state.jobs.find((entry) => entry.jobId === jobId);
          resolve(job ? { ...job } : undefined);
        }
      };
      const changed = () => {
        const job = this.state.jobs.find((entry) => entry.jobId === jobId);
        if (!job || job.state !== "pending" || job.preparationError &&
            (returnStartupFailure || job.deliveryUncertain === false)) finish();
      };
      const aborted = () => finish(signal.reason ?? new Error("Wait cancelled."));
      this.changes.on("change", changed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else void this.queue.then(changed, finish);
    });
  }

  async forParent(parentThreadId: string) {
    await this.queue;
    return this.state.jobs
      .filter((entry) => entry.parentThreadId === parentThreadId)
      .map((entry) => ({ ...entry }));
  }

  async close() {
    this.watcher?.close();
    await this.queue;
  }

  private async persist(state: SubagentStore) {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private update<T>(operation: (state: SubagentStore) => T | Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const value = await operation(next);
      await this.persist(next);
      this.state = next;
      this.changes.emit("change");
      return value;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}
