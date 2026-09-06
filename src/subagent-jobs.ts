import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const MAX_JOBS = 2_000;
const RETAINED_NOTIFIED_JOBS = 1_000;
export const MAX_ACTIVE_SUBAGENTS_PER_PARENT = 1;
const INTERRUPTED_STARTUP_ERROR = "Reviewer startup was interrupted by a service restart. Inspect the browser, stop any running reviewer, then cancel this job if it is abandoned.";

export class SubagentAdmissionError extends Error {
  constructor(readonly reason: "capacity" | "nested", readonly activeJobIds: string[] = []) {
    super(reason === "nested"
      ? "A reviewer conversation cannot start another reviewer. Complete this review and call review_done."
      : `This implementer already has an unfinished review. Reviews: ${activeJobIds.join(", ")}. End this turn and wait for the completion notice. Do not retry or poll.`);
  }
}

const subagentJobSchema = z.object({
  jobId: z.string().uuid(),
  parentThreadId: z.string(),
  parentConversationUrl: z.string().url(),
  childThreadId: z.string().optional(),
  childConversationUrl: z.string().url().optional(),
  title: z.string().optional(),
  resultPath: z.string(),
  taskFingerprint: z.string().optional(),
  state: z.enum(["pending", "complete", "cancelled"]),
  cancelledAt: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  notifiedAt: z.string().optional(),
  notificationAttempts: z.number().int().nonnegative().default(0),
  notificationAbandonedAt: z.string().optional(),
  notificationError: z.string().optional(),
  preparationError: z.string().optional(),
});

const subagentStoreSchema = z.object({
  version: z.literal(1),
  jobs: z.array(subagentJobSchema).max(MAX_JOBS),
});

type SubagentJob = z.infer<typeof subagentJobSchema>;
type SubagentStore = z.infer<typeof subagentStoreSchema>;

export class SubagentJobRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly resultDirectory: string,
    private state: SubagentStore,
  ) {}

  static async open(dataDirectory: string) {
    const resultDirectory = path.resolve(dataDirectory, "reviews");
    const legacyResultDirectory = path.resolve(dataDirectory, "subagents");
    await mkdir(resultDirectory, { recursive: true });
    const filePath = path.join(resultDirectory, "jobs.json");
    const legacyFilePath = path.join(legacyResultDirectory, "jobs.json");
    let state: SubagentStore = { version: 1, jobs: [] };
    let needsPersist = false;
    try {
      state = subagentStoreSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      try {
        state = subagentStoreSchema.parse(JSON.parse(await readFile(legacyFilePath, "utf8")));
        needsPersist = true;
      } catch (legacyError) {
        if (!(legacyError instanceof Error && "code" in legacyError && legacyError.code === "ENOENT")) throw legacyError;
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

    const unfinished = state.jobs.filter((job) => !job.notifiedAt);
    const notified = state.jobs
      .filter((job) => job.notifiedAt)
      .sort((left, right) => Date.parse(right.notifiedAt ?? right.createdAt) - Date.parse(left.notifiedAt ?? left.createdAt))
      .slice(0, RETAINED_NOTIFIED_JOBS);
    const retained = [...unfinished, ...notified];
    if (retained.length !== state.jobs.length) needsPersist = true;
    state.jobs = retained;

    if (needsPersist) {
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, filePath);
    }
    return new SubagentJobRegistry(filePath, resultDirectory, state);
  }

  async create(parent: { threadId: string; conversationUrl: string }, taskFingerprint?: string) {
    return await this.update((state) => {
      if (state.jobs.some((job) => job.childThreadId === parent.threadId)) {
        throw new SubagentAdmissionError("nested");
      }
      const existing = taskFingerprint && state.jobs.find((job) =>
        job.parentThreadId === parent.threadId && job.taskFingerprint === taskFingerprint);
      if (existing) return { ...existing, reused: true };
      const active = state.jobs.filter((job) => job.parentThreadId === parent.threadId &&
        (job.state === "pending" || (job.state === "complete" && !job.notifiedAt)));
      if (active.length >= MAX_ACTIVE_SUBAGENTS_PER_PARENT) {
        throw new SubagentAdmissionError("capacity", active.map((job) => job.jobId));
      }
      if (state.jobs.length >= MAX_JOBS) throw new Error("Reviewer job limit reached.");
      const jobId = randomUUID();
      const job: SubagentJob = {
        jobId,
        taskFingerprint,
        parentThreadId: parent.threadId,
        parentConversationUrl: parent.conversationUrl,
        resultPath: path.join(this.resultDirectory, `${jobId}.md`),
        state: "pending",
        createdAt: new Date().toISOString(),
        notificationAttempts: 0,
      };
      state.jobs.push(job);
      return { ...job, reused: false };
    });
  }

  async assignChild(jobId: string, child: { threadId: string; conversationUrl: string; title?: string }) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Reviewer job not found.");
      job.childThreadId = child.threadId;
      job.childConversationUrl = child.conversationUrl;
      if (child.title) job.title = child.title;
      return { ...job };
    });
  }

  async cancel(jobId: string) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Reviewer job not found.");
      if (job.state === "pending") {
        job.state = "cancelled";
        job.cancelledAt = new Date().toISOString();
        job.notifiedAt = job.cancelledAt;
      }
      return { ...job };
    });
  }

  async isReviewer(threadId: string) {
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
      (job.parentThreadId === threadId && (job.state === "pending" ||
        (job.state === "complete" && !job.notifiedAt))));
  }

  complete(jobId: string, result: string) {
    const operation = this.queue.then(async () => {
      const current = this.state.jobs.find((entry) => entry.jobId === jobId);
      if (!current) throw new Error("Reviewer job not found.");
      if (current.state === "cancelled") throw new Error("This reviewer job was cancelled. End this review.");
      if (current.state === "complete") return { job: { ...current }, newlyCompleted: false };

      const temporaryResultPath = `${current.resultPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryResultPath, `${result.trim()}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryResultPath, current.resultPath);

      const next = structuredClone(this.state);
      const target = next.jobs.find((entry) => entry.jobId === jobId);
      if (!target) throw new Error("Reviewer job not found.");
      target.state = "complete";
      target.completedAt = new Date().toISOString();
      target.preparationError = undefined;
      target.notificationError = undefined;
      await this.persist(next);
      this.state = next;
      return { job: { ...target }, newlyCompleted: true };
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async markNotified(jobId: string | string[]) {
    return await this.update((state) => {
      const ids = new Set(typeof jobId === "string" ? [jobId] : jobId);
      for (const job of state.jobs.filter((entry) => ids.has(entry.jobId))) {
        job.notifiedAt = new Date().toISOString();
        job.notificationAbandonedAt = undefined;
        job.notificationError = undefined;
      }
    });
  }

  async recordNotificationFailure(jobId: string, error: string, maxAttempts: number) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Reviewer job not found.");
      job.notificationAttempts += 1;
      job.notificationError = error.slice(0, 1_000);
      if (job.notificationAttempts >= maxAttempts) job.notificationAbandonedAt = new Date().toISOString();
      return { ...job };
    });
  }

  async retryNotification(jobId: string) {
    return this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job || job.state !== "complete" || job.notifiedAt) throw new Error("No undelivered review report for this job.");
      job.notificationAttempts = 0;
      job.notificationAbandonedAt = undefined;
      job.notificationError = undefined;
    });
  }

  async recordPreparationFailure(jobId: string, error: string) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Reviewer job not found.");
      job.preparationError = error.slice(0, 1_000);
      return { ...job };
    });
  }

  async job(jobId: string) {
    await this.queue;
    const job = this.state.jobs.find((entry) => entry.jobId === jobId);
    return job ? { ...job } : undefined;
  }

  async jobsNeedingNotification() {
    await this.queue;
    return this.state.jobs
      .filter((entry) => entry.state === "complete" && !entry.notifiedAt && !entry.notificationAbandonedAt)
      .map((entry) => ({ ...entry }));
  }

  async forParent(parentThreadId: string) {
    await this.queue;
    return this.state.jobs
      .filter((entry) => entry.parentThreadId === parentThreadId)
      .map((entry) => ({ ...entry }));
  }

  async close() {
    await this.queue;
  }

  private async persist(state: SubagentStore) {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private update<T>(operation: (state: SubagentStore) => T): Promise<T> {
    const result = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const value = operation(next);
      await this.persist(next);
      this.state = next;
      return value;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}
