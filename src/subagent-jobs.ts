import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const MAX_JOBS = 2_000;
const RETAINED_NOTIFIED_JOBS = 1_000;

const subagentJobSchema = z.object({
  jobId: z.string().uuid(),
  parentThreadId: z.string(),
  parentConversationUrl: z.string().url(),
  childThreadId: z.string().optional(),
  childConversationUrl: z.string().url().optional(),
  title: z.string().optional(),
  resultPath: z.string(),
  state: z.enum(["pending", "complete"]),
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
    const resultDirectory = path.resolve(dataDirectory, "subagents");
    await mkdir(resultDirectory, { recursive: true });
    const filePath = path.join(resultDirectory, "jobs.json");
    let state: SubagentStore = { version: 1, jobs: [] };
    try {
      state = subagentStoreSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
      const unfinished = state.jobs.filter((job) => !job.notifiedAt);
      const notified = state.jobs
        .filter((job) => job.notifiedAt)
        .sort((left, right) => Date.parse(right.notifiedAt ?? right.createdAt) - Date.parse(left.notifiedAt ?? left.createdAt))
        .slice(0, RETAINED_NOTIFIED_JOBS);
      state.jobs = [...unfinished, ...notified];
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return new SubagentJobRegistry(filePath, resultDirectory, state);
  }

  async create(parent: { threadId: string; conversationUrl: string }) {
    return await this.update((state) => {
      if (state.jobs.length >= MAX_JOBS) throw new Error("Sub-agent job limit reached.");
      const jobId = randomUUID();
      const job: SubagentJob = {
        jobId,
        parentThreadId: parent.threadId,
        parentConversationUrl: parent.conversationUrl,
        resultPath: path.join(this.resultDirectory, `${jobId}.md`),
        state: "pending",
        createdAt: new Date().toISOString(),
        notificationAttempts: 0,
      };
      state.jobs.push(job);
      return { ...job };
    });
  }

  async assignChild(jobId: string, child: { threadId: string; conversationUrl: string; title?: string }) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Sub-agent job not found.");
      job.childThreadId = child.threadId;
      job.childConversationUrl = child.conversationUrl;
      if (child.title) job.title = child.title;
      return { ...job };
    });
  }

  async discard(jobId: string) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      state.jobs = state.jobs.filter((entry) => entry.jobId !== jobId);
      return job ? { ...job } : undefined;
    });
  }

  complete(jobId: string, result: string) {
    const operation = this.queue.then(async () => {
      const current = this.state.jobs.find((entry) => entry.jobId === jobId);
      if (!current) throw new Error("Sub-agent job not found.");
      if (current.state === "complete") return { job: { ...current }, newlyCompleted: false };

      const temporaryResultPath = `${current.resultPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryResultPath, `${result.trim()}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryResultPath, current.resultPath);

      const next = structuredClone(this.state);
      const target = next.jobs.find((entry) => entry.jobId === jobId);
      if (!target) throw new Error("Sub-agent job not found.");
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

  async markNotified(jobId: string) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Sub-agent job not found.");
      job.notifiedAt = new Date().toISOString();
      job.notificationAbandonedAt = undefined;
      job.notificationError = undefined;
      return { ...job };
    });
  }

  async recordNotificationFailure(jobId: string, error: string, maxAttempts: number) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Sub-agent job not found.");
      job.notificationAttempts += 1;
      job.notificationError = error.slice(0, 1_000);
      if (job.notificationAttempts >= maxAttempts) job.notificationAbandonedAt = new Date().toISOString();
      return { ...job };
    });
  }

  async recordPreparationFailure(jobId: string, error: string) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Sub-agent job not found.");
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
      .filter((entry) => !entry.notifiedAt && !entry.notificationAbandonedAt)
      .map((entry) => ({ ...entry }));
  }

  async markFileComplete(jobId: string) {
    return await this.update((state) => {
      const job = state.jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error("Sub-agent job not found.");
      if (job.state !== "complete") {
        job.state = "complete";
        job.completedAt = new Date().toISOString();
      }
      return { ...job };
    });
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
