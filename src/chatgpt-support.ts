import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Request, RequestHandler, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SubagentAdmissionError, SubagentJobRegistry } from "./subagent-jobs.js";

const MAX_RALPH_THREADS = 2_000;
const MAX_RALPH_PROJECTS = 100;
const DEFAULT_RALPH_INITIAL_DELAY_MS = 25 * 60 * 1000;
const RALPH_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const MIN_RALPH_INTERVAL_SECONDS = 1;
const MAX_RALPH_INTERVAL_SECONDS = 24 * 60 * 60;
const RALPH_SCHEDULER_TICK_MS = 1_000;
const LOADING_RETRY_MS = 60 * 1000;
const FAILURE_RETRY_MS = 2 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const INSPECT_CLAIM_LEASE_MS = 5 * 60 * 1000;
const CLAIM_WAIT_MS = 20_000;
const SUPPORT_BROWSER_HEARTBEAT_GRACE_MS = CLAIM_WAIT_MS + 5_000;
const SUPPORT_BROWSER_LAUNCH_COOLDOWN_MS = 5_000;
const SUBAGENT_RESULT_MISSING_RETRY_MS = 30_000;
const MAX_SUBAGENT_NOTIFICATION_ATTEMPTS = 5;
const MAX_SUBAGENT_NOTIFICATION_RETRY_MS = 10 * 60_000;
const MAX_CONCURRENT_THREAD_PREPARATIONS = 3;
const RALPH_PREPARE_TIMEOUT_MS = 3 * 60 * 1000;
const THREAD_PREPARATION_HOLD_MS = 2 * 60 * 1000;
const MAX_CONTINUATION_CHARS = 500;
const TOOL_REQUEST_REPLAY_TTL_MS = 30 * 60 * 1000;
const MAX_TOOL_REQUEST_REPLAYS = 1_000;
const MESSAGE_COOLDOWN_MS = 15 * 60_000;

type ToolRequestReplay = {
  expiresAt: number;
  result: Promise<CallToolResult>;
};
const toolRequestReplays = new Map<string, ToolRequestReplay>();

function replayToolRequest(replayKey: string, createResult: () => Promise<CallToolResult>) {
  const now = Date.now();
  for (const [key, entry] of toolRequestReplays) {
    if (entry.expiresAt <= now) toolRequestReplays.delete(key);
  }
  const replay = toolRequestReplays.get(replayKey);
  if (replay) return replay.result;

  const result = createResult();
  toolRequestReplays.set(replayKey, {
    expiresAt: now + TOOL_REQUEST_REPLAY_TTL_MS,
    result,
  });
  while (toolRequestReplays.size > MAX_TOOL_REQUEST_REPLAYS) {
    const oldest = toolRequestReplays.keys().next().value;
    if (oldest === undefined) break;
    toolRequestReplays.delete(oldest);
  }
  return result;
}

export const SUBAGENT_WIDGET_URI = "ui://local-codex/subagents-v1.html";
export const SUBAGENT_AGENT_INSTRUCTION = [
  "Keep implementation in the root conversation. Use one independent reviewer by default; add a second only for a distinct concern. After fixes, review the affected behavior instead of launching another group.",
  "Only synced root conversations can call start_subagent. The service permits two pending children total, including startups across all parents. Nested delegation is disabled.",
  "If capacity is full, continue independent work or end the turn while waiting for results. Do not retry starts or poll list_subagents for capacity. Use list_subagents only when a status snapshot changes your next decision.",
  "Read all local resultPath files named in a result-ready notice before continuing. Notifications may combine several results. Reports stay in local files.",
  "For an abandoned job, stop any running child in the browser before calling cancel_subagent. Cancellation releases its slot and disables future RALPH continuation; it cannot interrupt a running browser turn.",
  "A child completes its bounded assignment without delegation and calls submit_subagent_result exactly once. Reviewers remain read-only. If a submit response is lost, inspect job status before resubmitting.",
  "Use send_thread_message only when the user explicitly asks to post into an existing conversation. Respect message cooldowns. After uncertain delivery, inspect the target before deciding whether to send again.",
].join(" ");
const CONTINUOUS_RALPH_INSTRUCTION = "Continue the authorized continuous run toward the existing user goal. Read the conversation and current state, choose useful unfinished work, and verify the result. Use completed child reports before requesting further review. If progress depends on a pending child, user input, or a message cooldown, state the blocker and end this turn. Otherwise continue within the agreed scope.";

export const supportFeatureSchema = z.enum(["ralph", "threadMessaging", "threadPreparation"]);
export type SupportFeature = z.infer<typeof supportFeatureSchema>;

const threadMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
});

export const threadInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("loading"), title: z.string().optional() }),
  z.object({ status: z.literal("running"), title: z.string().optional() }),
  z.object({
    status: z.literal("idle"),
    title: z.string().optional(),
    workedSeconds: z.number().int().nonnegative().nullable(),
    users: z.array(threadMessageSchema),
    assistant: z.object({
      synthetic: z.boolean(),
      id: z.string().nullable().optional(),
      text: z.string(),
    }),
  }),
]);
export type ThreadInspection = z.infer<typeof threadInspectionSchema>;

const sendMessageResultSchema = z.object({
  status: z.literal("sent"),
  conversationUrl: z.string().url(),
  title: z.string().optional(),
});
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>;

const supportCommandSchema = z.union([
  z.object({
    id: z.string(),
    feature: z.literal("ralph"),
    kind: z.literal("inspect_thread"),
    conversationUrl: z.string().url(),
  }),
  z.object({
    id: z.string(),
    feature: z.literal("threadPreparation"),
    kind: z.literal("prepare_thread"),
    conversationUrl: z.string().url(),
  }),
  z.object({
    id: z.string(),
    feature: z.literal("ralph"),
    kind: z.literal("send_message"),
    targetUrl: z.string().url(),
    message: z.string(),
  }),
  z.object({
    id: z.string(),
    feature: z.literal("threadMessaging"),
    kind: z.literal("send_message"),
    targetUrl: z.string().url(),
    message: z.string(),
  }),
]);
export type SupportCommand = z.infer<typeof supportCommandSchema>;
type SupportCommandInput =
  | Omit<Extract<SupportCommand, { kind: "inspect_thread" }>, "id">
  | Omit<Extract<SupportCommand, { kind: "prepare_thread" }>, "id">
  | Omit<Extract<SupportCommand, { kind: "send_message" }>, "id">;

const commandResultSchema = z.union([
  z.object({
    commandId: z.string(),
    browserId: z.string(),
    kind: z.literal("inspect_thread"),
    ok: z.literal(true),
    result: threadInspectionSchema,
  }),
  z.object({
    commandId: z.string(),
    browserId: z.string(),
    kind: z.literal("prepare_thread"),
    ok: z.literal(true),
    result: z.object({
      status: z.literal("prepared"),
      conversationUrl: z.string().url(),
    }),
  }),
  z.object({
    commandId: z.string(),
    browserId: z.string(),
    kind: z.literal("send_message"),
    ok: z.literal(true),
    result: sendMessageResultSchema,
  }),
  z.object({
    commandId: z.string(),
    browserId: z.string(),
    kind: z.union([z.literal("inspect_thread"), z.literal("prepare_thread"), z.literal("send_message")]),
    ok: z.literal(false),
    error: z.string().min(1).max(2_000),
  }),
]);
export type SupportCommandResult = z.infer<typeof commandResultSchema>;

interface PendingCommand {
  command: SupportCommand;
  resolve: (result: SupportCommandResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  claimedBy?: string;
  claimedAt?: number;
}

interface ClaimWaiter {
  browserId: string;
  features: Set<SupportFeature>;
  resolve: (command: SupportCommand | undefined) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export class SupportCommandBus {
  private readonly queued: PendingCommand[] = [];
  private readonly pending = new Map<string, PendingCommand>();
  private readonly waiters = new Set<ClaimWaiter>();
  private readonly browsers = new Map<string, { features: Set<SupportFeature>; lastSeenAt: number }>();
  private launchInFlight?: Promise<void>;
  private lastLaunchAt = 0;
  private cooldownUntil = 0;

  messageCooldownUntil() {
    return this.cooldownUntil > Date.now() ? this.cooldownUntil : 0;
  }

  constructor(private readonly inspectClaimLeaseMs = INSPECT_CLAIM_LEASE_MS) {}

  execute(
    command: SupportCommandInput,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ) {
    if (command.kind === "send_message" && this.messageCooldownUntil()) {
      return Promise.reject(new Error(`ChatGPT message cooldown until ${new Date(this.cooldownUntil).toISOString()}. Wait for the cooldown; do not retry now.`));
    }
    const fullCommand = supportCommandSchema.parse({ ...command, id: randomUUID() });
    return new Promise<SupportCommandResult>((resolve, reject) => {
      const pending: PendingCommand = {
        command: fullCommand,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removePending(fullCommand.id);
          reject(new Error(`ChatGPT support command timed out: ${fullCommand.kind}`));
        }, timeoutMs),
      };
      pending.timeout.unref();
      this.pending.set(fullCommand.id, pending);

      const waiter = [...this.waiters].find((candidate) => candidate.features.has(fullCommand.feature));
      if (waiter) {
        pending.claimedBy = waiter.browserId;
        pending.claimedAt = Date.now();
        this.resolveWaiter(waiter, fullCommand);
        return;
      }

      this.queued.push(pending);
    });
  }

  hasBrowser(feature: SupportFeature) {
    const now = Date.now();
    for (const [browserId, browser] of this.browsers) {
      const hasClaimedCommand = [...this.pending.values()].some((pending) => pending.claimedBy === browserId);
      if (now - browser.lastSeenAt > SUPPORT_BROWSER_HEARTBEAT_GRACE_MS && !hasClaimedCommand) {
        this.browsers.delete(browserId);
        continue;
      }
      if (browser.features.has(feature) && (hasClaimedCommand || now - browser.lastSeenAt <= SUPPORT_BROWSER_HEARTBEAT_GRACE_MS)) {
        return true;
      }
    }
    return false;
  }

  async ensureBrowser(feature: SupportFeature, launchBrowser: () => Promise<void>) {
    if (this.hasBrowser(feature)) return;
    if (this.launchInFlight) {
      await this.launchInFlight;
      return;
    }
    if (Date.now() - this.lastLaunchAt < SUPPORT_BROWSER_LAUNCH_COOLDOWN_MS) return;

    const launch = launchBrowser();
    this.launchInFlight = launch;
    try {
      await launch;
      this.lastLaunchAt = Date.now();
    } finally {
      if (this.launchInFlight === launch) this.launchInFlight = undefined;
    }
  }

  claim(browserId: string, features: SupportFeature[], waitMs = CLAIM_WAIT_MS, signal?: AbortSignal) {
    const featureSet = new Set(features);
    this.browsers.set(browserId, { features: featureSet, lastSeenAt: Date.now() });
    const resumable = [...this.pending.values()].find((pending) =>
      (pending.command.kind === "inspect_thread" || pending.command.kind === "prepare_thread") &&
      featureSet.has(pending.command.feature) &&
      (pending.claimedBy === browserId ||
        (pending.claimedAt !== undefined && Date.now() - pending.claimedAt >= this.inspectClaimLeaseMs)));
    if (resumable) {
      resumable.claimedBy = browserId;
      resumable.claimedAt = Date.now();
      return Promise.resolve(resumable.command);
    }

    const queuedIndex = this.queued.findIndex((pending) => featureSet.has(pending.command.feature));
    if (queuedIndex >= 0) {
      const [pending] = this.queued.splice(queuedIndex, 1);
      pending.claimedBy = browserId;
      pending.claimedAt = Date.now();
      return Promise.resolve(pending.command);
    }

    if (featureSet.size === 0 || waitMs <= 0 || signal?.aborted) return Promise.resolve(undefined);

    return new Promise<SupportCommand | undefined>((resolve) => {
      let waiter: ClaimWaiter;
      const timeout = setTimeout(() => this.resolveWaiter(waiter, undefined), waitMs);
      waiter = { browserId, features: featureSet, resolve, timeout, signal };
      if (signal) {
        waiter.abortHandler = () => this.resolveWaiter(waiter, undefined);
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      waiter.timeout.unref();
      this.waiters.add(waiter);
    });
  }

  complete(input: unknown) {
    const result = commandResultSchema.parse(input);
    const pending = this.pending.get(result.commandId);
    if (!pending) throw new Error("Support command is unknown or already finished.");
    if (pending.claimedBy !== result.browserId) throw new Error("Support command belongs to another browser instance.");
    if (pending.command.kind !== result.kind) throw new Error("Support command result kind does not match the request.");

    if (!result.ok && result.error.startsWith("CHATGPT_RATE_LIMITED:")) {
      this.cooldownUntil = Date.now() + MESSAGE_COOLDOWN_MS;
      console.warn(`[chatgpt-support] message_cooldown until=${new Date(this.cooldownUntil).toISOString()}`);
      for (const queued of [...this.queued]) {
        if (queued.command.kind !== "send_message") continue;
        this.removePending(queued.command.id);
        queued.reject(new Error(`ChatGPT message cooldown until ${new Date(this.cooldownUntil).toISOString()}. Wait before sending again.`));
      }
    }

    const browser = this.browsers.get(result.browserId);
    if (browser) browser.lastSeenAt = Date.now();
    this.removePending(result.commandId);
    pending.resolve(result);
  }

  close() {
    for (const waiter of [...this.waiters]) this.resolveWaiter(waiter, undefined);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("ChatGPT support service is shutting down."));
    }
    this.pending.clear();
    this.queued.length = 0;
    this.browsers.clear();
  }

  private resolveWaiter(waiter: ClaimWaiter, command: SupportCommand | undefined) {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abortHandler) waiter.signal.removeEventListener("abort", waiter.abortHandler);
    waiter.resolve(command);
  }

  private removePending(commandId: string) {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(commandId);
    const queuedIndex = this.queued.indexOf(pending);
    if (queuedIndex >= 0) this.queued.splice(queuedIndex, 1);
  }
}

const ralphThreadSchema = z.object({
  conversationUrl: z.string().url(),
  threadId: z.string(),
  title: z.string().optional(),
  parentThreadId: z.string().uuid().optional(),
  manuallyRegistered: z.boolean().optional(),
  agentCreated: z.boolean().optional(),
  registeredAt: z.string(),
  nextCheckAt: z.number(),
  state: z.enum(["active", "complete"]),
  mode: z.enum(["normal", "continuous"]).default("normal"),
  lastCheckedAt: z.string().optional(),
  lastContinuationAt: z.string().optional(),
  lastError: z.string().optional(),
});
const ralphStoreV1Schema = z.object({
  version: z.literal(1),
  threads: z.array(ralphThreadSchema).max(MAX_RALPH_THREADS),
  exclusions: z.array(z.object({
    conversationUrl: z.string().url(),
    threadId: z.string(),
    excludedAt: z.string(),
  })).max(MAX_RALPH_THREADS),
});
const ralphStoreSchema = z.object({
  version: z.literal(2),
  projects: z.array(z.string()).max(MAX_RALPH_PROJECTS),
  threads: z.array(ralphThreadSchema).max(MAX_RALPH_THREADS),
  loopIntervalMs: z.number().int().positive().max(MAX_RALPH_INTERVAL_SECONDS * 1000).default(DEFAULT_RALPH_INITIAL_DELAY_MS),
  subagentProjectUrl: z.string().url().optional(),
});
type RalphStore = z.infer<typeof ralphStoreSchema>;
const ralphLoopIntervalSecondsSchema = z.number().int()
  .min(MIN_RALPH_INTERVAL_SECONDS)
  .max(MAX_RALPH_INTERVAL_SECONDS);

export class RalphRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private state: RalphStore,
  ) {}

  static async open(dataDirectory: string, intervalMs?: number) {
    await mkdir(dataDirectory, { recursive: true });
    const filePath = path.join(dataDirectory, "ralph.json");
    let state: RalphStore = {
      version: 2,
      projects: [],
      threads: [],
      loopIntervalMs: DEFAULT_RALPH_INITIAL_DELAY_MS,
    };
    let migrated = false;
    try {
      const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
      const current = ralphStoreSchema.safeParse(raw);
      if (current.success) {
        state = current.data;
      } else if (ralphStoreV1Schema.safeParse(raw).success) {
        // Version 1 registered every synced thread and permanently excluded agent-created
        // threads. Neither behavior belongs in the project-scoped RALPH model.
        migrated = true;
      } else {
        state = ralphStoreSchema.parse(raw);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const thread of state.threads) {
      const title = normalizeThreadTitle(thread.title);
      if (title === thread.title) continue;
      migrated = true;
      if (title) thread.title = title;
      else delete thread.title;
    }
    if (migrated) {
      await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    if (intervalMs !== undefined) {
      if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new Error("RALPH interval must be a positive integer.");
      state.loopIntervalMs = intervalMs;
    }
    return new RalphRegistry(filePath, state);
  }

  async projects() {
    await this.queue;
    return [...this.state.projects];
  }

  async threads() {
    await this.queue;
    return this.state.threads.map((entry) => ({ ...entry }));
  }

  async settings() {
    await this.queue;
    return {
      loopIntervalSeconds: this.state.loopIntervalMs / 1000,
      subagentProjectUrl: this.state.subagentProjectUrl,
    };
  }

  async setSubagentProjectUrl(value: string | null) {
    const subagentProjectUrl = value === null ? undefined : normalizeSubagentProjectUrl(value);
    return this.update((state) => {
      state.subagentProjectUrl = subagentProjectUrl;
      return { subagentProjectUrl };
    });
  }

  async setLoopIntervalSeconds(value: number) {
    const loopIntervalSeconds = ralphLoopIntervalSecondsSchema.parse(value);
    const loopIntervalMs = loopIntervalSeconds * 1000;
    return this.update((state) => {
      state.loopIntervalMs = loopIntervalMs;
      const nextCheckAt = Date.now() + loopIntervalMs;
      for (const thread of state.threads) {
        if (thread.state === "active") thread.nextCheckAt = nextCheckAt;
      }
      return { loopIntervalSeconds };
    });
  }

  async setProjects(values: string[]) {
    const projects = [...new Set(values.map(parseRalphProjectId))];
    if (projects.length > MAX_RALPH_PROJECTS) throw new Error(`RALPH supports at most ${MAX_RALPH_PROJECTS} projects.`);
    return this.update((state) => {
      state.projects = projects;
      const allowed = new Set(projects);
      state.threads = state.threads.filter((thread) => {
        if (thread.manuallyRegistered || thread.agentCreated) return true;
        const projectId = parseConversationUrl(thread.conversationUrl).projectId;
        return projectId !== undefined && allowed.has(projectId);
      });
      return [...projects];
    });
  }

  async register(
    conversationUrl: string,
    options: { manual?: boolean; reactivate?: boolean; agentCreated?: boolean; title?: string; parentThreadId?: string } = {},
  ): Promise<"ignored" | "registered" | "active" | "reactivated"> {
    const conversation = parseConversationUrl(conversationUrl);
    const title = normalizeThreadTitle(options.title);
    return this.update((state) => {
      const projectAllowed = conversation.projectId && state.projects.includes(conversation.projectId);
      const existing = state.threads.find((entry) => entry.threadId === conversation.threadId);
      if (!options.manual && !options.agentCreated && !projectAllowed && !existing?.manuallyRegistered && !existing?.agentCreated) return "ignored" as const;
      if (existing) {
        if (existing.conversationUrl !== conversation.conversationUrl) existing.conversationUrl = conversation.conversationUrl;
        if (title) existing.title = title;
        if (options.parentThreadId) existing.parentThreadId = options.parentThreadId;
        if (options.manual) existing.manuallyRegistered = true;
        if (options.agentCreated) existing.agentCreated = true;
        if ((options.manual || options.agentCreated || options.reactivate) && existing.state === "complete") {
          existing.state = "active";
          existing.lastError = undefined;
          existing.nextCheckAt = Date.now() + state.loopIntervalMs;
          return "reactivated" as const;
        }
        return "active" as const;
      }
      if (state.threads.length >= MAX_RALPH_THREADS) throw new Error("RALPH thread registration limit reached.");
      state.threads.push({
        conversationUrl: conversation.conversationUrl,
        threadId: conversation.threadId,
        ...(title ? { title } : {}),
        ...(options.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
        ...(options.manual ? { manuallyRegistered: true } : {}),
        ...(options.agentCreated ? { agentCreated: true } : {}),
        registeredAt: new Date().toISOString(),
        nextCheckAt: Date.now() + state.loopIntervalMs,
        state: "active",
        mode: "normal",
      });
      return "registered" as const;
    });
  }

  async subagents(parentThreadId: string) {
    await this.queue;
    return this.state.threads
      .filter((entry) => entry.parentThreadId === parentThreadId)
      .map((entry) => ({ ...entry }));
  }

  async due(now = Date.now()) {
    await this.queue;
    return this.state.threads
      .filter((entry) => entry.state === "active" && entry.nextCheckAt <= now)
      .map((entry) => ({ ...entry }));
  }

  async isActive(threadId: string) {
    return (await this.activeMode(threadId)) !== undefined;
  }

  async activeMode(threadId: string) {
    await this.queue;
    const thread = this.state.threads.find((entry) => entry.threadId === threadId && entry.state === "active");
    return thread?.mode;
  }

  async scheduleNow(threadId: string): Promise<"scheduled" | "complete" | "missing"> {
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread) return "missing";
      if (thread.state === "complete") return "complete";
      thread.nextCheckAt = Date.now();
      return "scheduled";
    });
  }

  async recordRunning(threadId: string) {
    await this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId && entry.state === "active");
      if (!thread) return;
      thread.lastCheckedAt = new Date().toISOString();
      thread.lastError = undefined;
      thread.nextCheckAt = Date.now() + RALPH_RECHECK_INTERVAL_MS;
    });
  }

  async recordLoading(threadId: string) {
    await this.reschedule(threadId, LOADING_RETRY_MS);
  }

  async recordFailure(threadId: string, error: string) {
    await this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId && entry.state === "active");
      if (!thread) return;
      thread.lastCheckedAt = new Date().toISOString();
      thread.lastError = error.slice(0, 1_000);
      thread.nextCheckAt = Date.now() + FAILURE_RETRY_MS;
    });
  }

  async recordTitle(threadId: string, value: string | undefined) {
    const title = normalizeThreadTitle(value);
    if (!title) return false;
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread) return false;
      thread.title = title;
      return true;
    });
  }

  async setMode(threadId: string, mode: "normal" | "continuous") {
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread) return undefined;
      thread.mode = mode;
      thread.lastError = undefined;
      if (mode === "continuous") {
        thread.state = "active";
        thread.nextCheckAt = Date.now() + state.loopIntervalMs;
      }
      return { ...thread };
    });
  }

  async recordComplete(threadId: string) {
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread) return false;
      thread.state = "complete";
      thread.lastCheckedAt = new Date().toISOString();
      thread.lastError = undefined;
      return true;
    });
  }

  async recordActive(threadId: string) {
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread) return false;
      thread.state = "active";
      thread.lastError = undefined;
      thread.nextCheckAt = Date.now() + state.loopIntervalMs;
      return true;
    });
  }

  async recordContinuation(threadId: string) {
    await this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId && entry.state === "active");
      if (!thread) return;
      const now = new Date().toISOString();
      thread.lastCheckedAt = now;
      thread.lastContinuationAt = now;
      thread.lastError = undefined;
      thread.nextCheckAt = Date.now() + RALPH_RECHECK_INTERVAL_MS;
    });
  }

  private async reschedule(threadId: string, delayMs: number) {
    await this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId && entry.state === "active");
      if (!thread) return;
      thread.lastCheckedAt = new Date().toISOString();
      thread.lastError = undefined;
      thread.nextCheckAt = Date.now() + delayMs;
    });
  }

  private update<T>(operation: (state: RalphStore) => T): Promise<T> {
    const result = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const value = operation(next);
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      this.state = next;
      return value;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

const canonicalProjectPattern = /^(g-p-[0-9a-f]{32})(?:-[A-Za-z0-9_-]+)?$/i;

function canonicalProjectId(value: string) {
  const known = value.match(canonicalProjectPattern);
  if (known) return known[1].toLowerCase();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid ChatGPT project id.");
  return value;
}

export function normalizeSubagentProjectUrl(value: string) {
  const url = new URL(value.trim());
  if (url.origin !== "https://chatgpt.com" || url.username || url.password ||
      !/^\/g\/[A-Za-z0-9_-]+\/project\/?$/.test(url.pathname)) {
    throw new Error("Use a ChatGPT project URL ending in /project.");
  }
  return `https://chatgpt.com${url.pathname.replace(/\/$/, "")}`;
}

export function parseRalphProjectId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("RALPH project entries cannot be empty.");
  if (!trimmed.includes("://")) return canonicalProjectId(trimmed);

  const url = new URL(trimmed);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password) {
    throw new Error("RALPH projects must use https://chatgpt.com.");
  }
  const match = url.pathname.match(/^\/g\/([^/]+)\/(?:project|c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
  if (!match) throw new Error("Expected a ChatGPT project home or project conversation URL.");
  return canonicalProjectId(match[1]);
}

export function parseConversationUrl(value: string) {
  const url = new URL(value);
  const match = url.pathname.match(/^(?:\/g\/([A-Za-z0-9_-]+))?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password || !match) {
    throw new Error("Expected a saved https://chatgpt.com conversation URL.");
  }
  const projectId = match[1] ? canonicalProjectId(match[1]) : undefined;
  const threadId = match[2].toLowerCase();
  return {
    threadId,
    ...(projectId ? { projectId } : {}),
    conversationUrl: projectId
      ? `https://chatgpt.com/g/${projectId}/c/${threadId}`
      : `https://chatgpt.com/c/${threadId}`,
  };
}

function normalizeThreadTitle(value: string | undefined) {
  if (typeof value !== "string") return undefined;
  const title = value.trim().replace(/\s+-\s+ChatGPT$/i, "").trim();
  if (!title || /^ChatGPT(?:\s+[\u002d\u2013\u2014]\s+.+)?$/i.test(title)) return undefined;
  const parts = title.split(/\s+[\u002d\u2013\u2014]\s+/).map((part) => part.trim());
  if (parts.some((part) => /^New chat$/i.test(part))) return undefined;
  return title.slice(0, 200);
}
interface RalphControllerOptions {
  registry: RalphRegistry;
  commands: SupportCommandBus;
  apiKey?: string;
  model: string;
  auditLogPath: string;
  checkEveryMs?: number;
  jobs?: SubagentJobRegistry;
}

class RalphOpenAiAuditLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async write(
    event: string,
    details: Record<string, unknown>,
    level: "info" | "error" = "info",
    required = false,
  ) {
    const record = JSON.stringify({ timestamp: new Date().toISOString(), event, ...details });
    const terminalMessage = `[ralph/openai] ${record}`;
    if (level === "error") console.error(terminalMessage);
    else console.log(terminalMessage);

    const pending = this.queue.then(() => appendFile(this.filePath, `${record}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }));
    this.queue = pending.catch(() => undefined);
    try {
      await pending;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ralph/openai] audit_write_failed path=${JSON.stringify(this.filePath)} error=${JSON.stringify(message)}`);
      if (required) throw new Error(`Cannot persist the RALPH OpenAI audit log: ${message}`);
    }
  }
}

export class RalphController {
  private readonly inFlight = new Set<string>();
  private readonly timer: NodeJS.Timeout;
  private readonly auditLog: RalphOpenAiAuditLog;

  constructor(private readonly options: RalphControllerOptions) {
    this.auditLog = new RalphOpenAiAuditLog(options.auditLogPath);
    this.timer = setInterval(() => void this.tick(), options.checkEveryMs ?? RALPH_SCHEDULER_TICK_MS);
    this.timer.unref();
  }

  async tick() {
    const due = await this.options.registry.due();
    for (const thread of due) {
      if (this.inFlight.has(thread.threadId)) continue;
      this.inFlight.add(thread.threadId);
      void this.check(thread).finally(() => this.inFlight.delete(thread.threadId));
    }
  }

  close() {
    clearInterval(this.timer);
  }

  private async check(thread: z.infer<typeof ralphThreadSchema>) {
    try {
      if (this.options.commands.messageCooldownUntil() || await this.options.jobs?.blocksContinuation(thread.threadId)) {
        await this.options.registry.recordRunning(thread.threadId);
        return;
      }
      const commandResult = await this.options.commands.execute({
        feature: "ralph",
        kind: "inspect_thread",
        conversationUrl: thread.conversationUrl,
      });
      if (!commandResult.ok) throw new Error(commandResult.error);
      if (commandResult.kind !== "inspect_thread") throw new Error("RALPH received the wrong support command result.");
      if (!await this.options.registry.isActive(thread.threadId)) return;

      const inspection = commandResult.result;
      if (inspection.title) await this.options.registry.recordTitle(thread.threadId, inspection.title);
      if (inspection.status === "loading") {
        await this.options.registry.recordLoading(thread.threadId);
        return;
      }
      if (inspection.status === "running") {
        await this.options.registry.recordRunning(thread.threadId);
        return;
      }

      if (inspection.users.length === 0 || inspection.users.some((message) => !message.text.trim())) {
        throw new Error("RALPH could not extract every ChatGPT user message.");
      }
      if (!inspection.assistant.text.trim()) {
        throw new Error("RALPH could not extract the final ChatGPT assistant message.");
      }

      const currentMode = await this.options.registry.activeMode(thread.threadId);
      if (currentMode === undefined) return;
      if (await this.options.jobs?.blocksContinuation(thread.threadId)) {
        await this.options.registry.recordRunning(thread.threadId);
        return;
      }
      if (currentMode === "continuous") {
        if (await this.options.registry.activeMode(thread.threadId) !== "continuous") return;
        const sendResult = await this.options.commands.execute({
          feature: "ralph",
          kind: "send_message",
          targetUrl: thread.conversationUrl,
          message: CONTINUOUS_RALPH_INSTRUCTION,
        });
        if (!sendResult.ok) throw new Error(sendResult.error);
        if (sendResult.kind !== "send_message") throw new Error("RALPH received the wrong send-message result.");
        await this.options.registry.recordContinuation(thread.threadId);
        return;
      }

      if (inspection.workedSeconds === null) {
        await this.options.registry.recordComplete(thread.threadId);
        return;
      }

      const decision = await decideRalphContinuation(
        inspection,
        this.options.apiKey,
        this.options.model,
        thread.conversationUrl,
        this.auditLog,
      );
      if (decision.complete) {
        await this.options.registry.recordComplete(thread.threadId);
        return;
      }
      const modeBeforeSend = await this.options.registry.activeMode(thread.threadId);
      if (modeBeforeSend === undefined) return;
      const continuation = modeBeforeSend === "continuous"
        ? CONTINUOUS_RALPH_INSTRUCTION
        : decision.instruction;
      if (await this.options.registry.activeMode(thread.threadId) !== modeBeforeSend) return;
      if (await this.options.jobs?.blocksContinuation(thread.threadId)) {
        await this.options.registry.recordRunning(thread.threadId);
        return;
      }

      const sendResult = await this.options.commands.execute({
        feature: "ralph",
        kind: "send_message",
        targetUrl: thread.conversationUrl,
        message: continuation,
      });
      if (!sendResult.ok) throw new Error(sendResult.error);
      if (sendResult.kind !== "send_message") throw new Error("RALPH received the wrong send-message result.");
      await this.options.registry.recordContinuation(thread.threadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ralph] thread=${JSON.stringify(thread.conversationUrl)} failed: ${message}`);
      await this.options.registry.recordFailure(thread.threadId, message);
    }
  }
}

function responseTokenUsage(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const usage = Reflect.get(value, "usage");
  if (!usage || typeof usage !== "object") return {};
  const tokenCount = (key: string) => {
    const count = Reflect.get(usage, key);
    return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined;
  };
  return {
    input_tokens: tokenCount("input_tokens"),
    output_tokens: tokenCount("output_tokens"),
    total_tokens: tokenCount("total_tokens"),
  };
}

async function decideRalphContinuation(
  inspection: Extract<ThreadInspection, { status: "idle" }>,
  apiKey: string | undefined,
  model: string,
  conversationUrl: string,
  auditLog: RalphOpenAiAuditLog,
) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for RALPH continuation decisions.");
  const transcript = [
    ...inspection.users.map((message) => `USER:\n${message.text}`),
    `ASSISTANT:\n${inspection.assistant.text}`,
  ].join("\n\n");
  const instruction = [
    "You classify whether another agent has finished the user's request.",
    "An idle turn may be finished or waiting for input. Judge the transcript without assuming a fixed tool-access time limit.",
    "The working agent is more capable than you and already has the full conversation, so do not plan or choose how it should work.",
    "Based only on all user messages and the final assistant message below, reply with exactly COMPLETE if the request is finished.",
    "If work remains, reply in English with one short sentence that tells the agent to continue and names only the unfinished work stated or clearly implied by the transcript.",
    "Do not explain, add steps, or repeat completed work.",
  ].join(" ");
  const requestBody = {
    model,
    reasoning: { effort: "low" },
    input: [
      { role: "system", content: [{ type: "input_text", text: instruction }] },
      { role: "user", content: [{ type: "input_text", text: transcript }] },
    ],
  };

  const startedAt = Date.now();
  await auditLog.write("request_started", {
    thread: conversationUrl,
    model,
    worked_seconds: inspection.workedSeconds,
    request: requestBody,
  }, "info", true);

  let response: globalThis.Response | undefined;
  let responseBody: unknown;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60_000),
    });
    const requestId = response.headers.get("x-request-id");
    if (!response.ok) {
      const rawBody = await response.text();
      try {
        responseBody = JSON.parse(rawBody);
      } catch {
        responseBody = rawBody;
      }
      throw new Error(`OpenAI RALPH decision failed with HTTP ${response.status}: ${rawBody.slice(0, 1_000)}`);
    }

    responseBody = await response.json();
    const text = extractResponsesText(responseBody).trim();
    if (!text) throw new Error("OpenAI RALPH decision returned no text.");
    const decision = /^COMPLETE\.?$/i.test(text)
      ? { complete: true as const }
      : { complete: false as const, instruction: compactContinuation(text) };
    await auditLog.write("request_succeeded", {
      thread: conversationUrl,
      model,
      request_id: requestId,
      http_status: response.status,
      duration_ms: Date.now() - startedAt,
      ...responseTokenUsage(responseBody),
      action: decision.complete ? "complete" : "continue",
      response_text: text,
    });
    return decision;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditLog.write("request_failed", {
      thread: conversationUrl,
      model,
      request_id: response?.headers.get("x-request-id"),
      http_status: response?.status,
      duration_ms: Date.now() - startedAt,
      error: message,
      response: responseBody,
    }, "error");
    throw error;
  }
}

function extractResponsesText(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const output = Reflect.get(value, "output");
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Reflect.get(item, "content");
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (Reflect.get(part, "type") === "output_text" && typeof Reflect.get(part, "text") === "string") {
        parts.push(Reflect.get(part, "text") as string);
      }
    }
  }
  return parts.join("\n");
}

function compactContinuation(value: string) {
  const normalized = value.replace(/\s+/g, " ").replace(/^['"]|['"]$/g, "").trim();
  if (!normalized) throw new Error("OpenAI RALPH decision returned an empty continuation instruction.");
  return normalized.length <= MAX_CONTINUATION_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_CONTINUATION_CHARS - 1).trimEnd()}…`;
}

function authenticateSupportExtension(req: Request, res: Response, extensionToken: string) {
  const authorization = req.get("authorization");
  const candidate = Buffer.from(authorization?.startsWith("Bearer ") ? authorization.slice(7) : "");
  const expected = Buffer.from(extensionToken);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    res.status(401).json({ error: "Local Codex Support extension authentication failed." });
    return false;
  }
  const origin = req.get("origin");
  if (origin && !/^(?:chrome-extension|moz-extension):\/\/[A-Za-z0-9_-]+$/.test(origin)) {
    res.status(403).json({ error: "Only the Local Codex Support extension may use this endpoint." });
    return false;
  }
  return true;
}

export function supportCommandClaimHandler(commands: SupportCommandBus, extensionToken: string): RequestHandler {
  const bodySchema = z.object({
    browserId: z.string().min(1).max(200),
    features: z.array(supportFeatureSchema).max(3),
  }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid support command claim." });
      return;
    }
    const abortController = new AbortController();
    const onDisconnect = () => abortController.abort();
    req.once("aborted", onDisconnect);
    res.once("close", onDisconnect);
    try {
      const command = await commands.claim(parsed.data.browserId, parsed.data.features, CLAIM_WAIT_MS, abortController.signal);
      if (abortController.signal.aborted) return;
      res.setHeader("Cache-Control", "no-store");
      if (!command) {
        res.status(204).end();
        return;
      }
      res.json(command);
    } finally {
      req.off("aborted", onDisconnect);
      res.off("close", onDisconnect);
    }
  };
}

export function ralphRegistrationHandler(
  registry: RalphRegistry,
  extensionToken: string,
): RequestHandler {
  const bodySchema = z.object({
    conversationUrl: z.string().max(2048),
    manual: z.boolean().optional(),
    reactivate: z.boolean().optional(),
    agentCreated: z.boolean().optional(),
    title: z.string().max(300).optional(),
  }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid RALPH registration request." });
      return;
    }
    try {
      const registration = await registry.register(parsed.data.conversationUrl, {
        manual: parsed.data.manual === true,
        reactivate: parsed.data.reactivate === true,
        agentCreated: parsed.data.agentCreated === true,
        title: parsed.data.title,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: registration === "ignored" ? "ignored" : "registered" });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "RALPH registration failed." });
    }
  };
}

export function ralphProjectsGetHandler(registry: RalphRegistry, extensionToken: string): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ projects: await registry.projects() });
  };
}

export function ralphThreadsGetHandler(registry: RalphRegistry, extensionToken: string): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ threads: await registry.threads() });
  };
}

export function ralphThreadCompleteHandler(registry: RalphRegistry, extensionToken: string): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = z.string().uuid().safeParse(req.params.threadId);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid RALPH thread id." });
      return;
    }
    const completed = await registry.recordComplete(parsed.data);
    if (!completed) {
      res.status(404).json({ error: "RALPH thread not found." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ threadId: parsed.data, state: "complete" });
  };
}

export function ralphThreadActiveHandler(registry: RalphRegistry, extensionToken: string): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = z.string().uuid().safeParse(req.params.threadId);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid RALPH thread id." });
      return;
    }
    const activated = await registry.recordActive(parsed.data);
    if (!activated) {
      res.status(404).json({ error: "RALPH thread not found." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ threadId: parsed.data, state: "active" });
  };
}

export function ralphThreadModeHandler(registry: RalphRegistry, extensionToken: string): RequestHandler {
  const bodySchema = z.object({ mode: z.enum(["normal", "continuous"]) }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const threadId = z.string().uuid().safeParse(req.params.threadId);
    const body = bodySchema.safeParse(req.body);
    if (!threadId.success || !body.success) {
      res.status(400).json({ error: "Invalid RALPH thread mode request." });
      return;
    }
    const thread = await registry.setMode(threadId.data, body.data.mode);
    if (!thread) {
      res.status(404).json({ error: "RALPH thread not found." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ thread });
  };
}

export function ralphThreadCheckHandler(
  registry: RalphRegistry,
  controller: RalphController,
  extensionToken: string,
): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = z.string().uuid().safeParse(req.params.threadId);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid RALPH thread id." });
      return;
    }
    const result = await registry.scheduleNow(parsed.data);
    if (result === "missing") {
      res.status(404).json({ error: "RALPH thread not found." });
      return;
    }
    if (result === "complete") {
      res.status(409).json({ error: "Mark this RALPH thread active before checking it again." });
      return;
    }
    await controller.tick();
    res.setHeader("Cache-Control", "no-store");
    res.status(202).json({ threadId: parsed.data, status: "scheduled" });
  };
}

export function ralphSettingsGetHandler(registry: RalphRegistry, extensionToken: string): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(await registry.settings());
  };
}

export function ralphSettingsPutHandler(registry: RalphRegistry, extensionToken: string): RequestHandler {
  const bodySchema = z.object({
    loopIntervalSeconds: ralphLoopIntervalSecondsSchema.optional(),
    subagentProjectUrl: z.string().max(2048).nullable().optional(),
  }).strict().refine((value) => value.loopIntervalSeconds !== undefined || value.subagentProjectUrl !== undefined);
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid Local Codex support settings." });
      return;
    }
    try {
      if (parsed.data.loopIntervalSeconds !== undefined) {
        await registry.setLoopIntervalSeconds(parsed.data.loopIntervalSeconds);
      }
      if (parsed.data.subagentProjectUrl !== undefined) {
        await registry.setSubagentProjectUrl(parsed.data.subagentProjectUrl);
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(await registry.settings());
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not update Local Codex support settings." });
    }
  };
}

export function ralphProjectsPutHandler(registry: RalphRegistry, extensionToken: string): RequestHandler {
  const bodySchema = z.object({
    projects: z.array(z.string().min(1).max(2048)).max(MAX_RALPH_PROJECTS),
  }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid RALPH projects request." });
      return;
    }
    try {
      const projects = await registry.setProjects(parsed.data.projects);
      res.setHeader("Cache-Control", "no-store");
      res.json({ projects });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not update RALPH projects." });
    }
  };
}

export function supportCommandResultHandler(commands: SupportCommandBus, extensionToken: string): RequestHandler {
  return (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    try {
      commands.complete(req.body);
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: "accepted" });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Support command result failed." });
    }
  };
}

interface ThreadBindingLookup {
  binding(identity: { ownerId: string; sessionId: string }): Promise<{
    threadId: string;
    conversationUrl: string;
    boundAt: string;
  } | undefined>;
  hasThread(threadId: string): Promise<boolean>;
}

export class ThreadPreparationCoordinator {
  private readonly inFlight = new Map<string, { ready: Promise<void>; done: Promise<void> }>();
  private readonly prepared = new Set<string>();
  private readonly boundWaiters = new Map<string, () => void>();
  private readonly slotWaiters: Array<() => void> = [];
  private activePreparations = 0;

  constructor(
    private readonly commands: SupportCommandBus,
    private readonly bindings: ThreadBindingLookup,
    private readonly launchBrowser: () => Promise<void>,
  ) {}

  markBound(threadId: string) {
    this.boundWaiters.get(threadId)?.();
  }

  async schedule(conversationUrl: string, observerCanPrepare = false): Promise<"synced" | "preparing" | "prepared"> {
    const conversation = parseConversationUrl(conversationUrl);
    if (await this.bindings.hasThread(conversation.threadId)) return "synced";
    if (this.prepared.has(conversation.threadId)) return "prepared";
    if (this.inFlight.has(conversation.threadId)) return "preparing";

    this.start(conversation.conversationUrl, conversation.threadId, observerCanPrepare);
    return "preparing";
  }

  async ensurePrepared(conversationUrl: string, observerCanPrepare = false): Promise<"synced" | "prepared"> {
    const conversation = parseConversationUrl(conversationUrl);
    if (await this.bindings.hasThread(conversation.threadId)) return "synced";
    if (this.prepared.has(conversation.threadId)) return "prepared";

    const task = this.inFlight.get(conversation.threadId)
      ?? this.start(conversation.conversationUrl, conversation.threadId, observerCanPrepare);
    await task.ready;
    if (await this.bindings.hasThread(conversation.threadId)) return "synced";
    if (this.prepared.has(conversation.threadId)) return "prepared";
    throw new Error("Thread preparation finished without creating a parked sync tab.");
  }

  private start(conversationUrl: string, threadId: string, observerCanPrepare: boolean) {
    let slotHeld = false;
    const ready = (async () => {
      await this.acquireSlot();
      slotHeld = true;
      if (!observerCanPrepare) await this.commands.ensureBrowser("threadPreparation", this.launchBrowser);
      if (await this.bindings.hasThread(threadId)) return;

      const result = await this.commands.execute({
        feature: "threadPreparation",
        kind: "prepare_thread",
        conversationUrl,
      }, RALPH_PREPARE_TIMEOUT_MS);
      if (!result.ok) throw new Error(result.error);
      if (result.kind !== "prepare_thread") throw new Error("Thread preparation received the wrong support command result.");
      this.prepared.add(threadId);
    })();

    const done = ready
      .then(async () => {
        if (!this.prepared.has(threadId) || await this.bindings.hasThread(threadId)) return;
        await this.waitForBindingRelease(threadId);
      })
      .finally(() => {
        if (slotHeld) this.releaseSlot();
        this.inFlight.delete(threadId);
      });

    void done.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[thread-sync] preparation failed thread=${JSON.stringify(conversationUrl)}: ${message}`);
    });
    const task = { ready, done };
    this.inFlight.set(threadId, task);
    return task;
  }

  private acquireSlot() {
    if (this.activePreparations < MAX_CONCURRENT_THREAD_PREPARATIONS) {
      this.activePreparations += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.slotWaiters.push(resolve));
  }

  private releaseSlot() {
    const next = this.slotWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.activePreparations -= 1;
  }

  private async waitForBindingRelease(threadId: string) {
    let timeout: NodeJS.Timeout;
    const released = new Promise<void>((resolve) => {
      const finish = () => {
        if (this.boundWaiters.get(threadId) !== finish) return;
        this.boundWaiters.delete(threadId);
        clearTimeout(timeout);
        resolve();
      };
      timeout = setTimeout(finish, THREAD_PREPARATION_HOLD_MS);
      timeout.unref();
      this.boundWaiters.set(threadId, finish);
    });
    if (await this.bindings.hasThread(threadId)) this.markBound(threadId);
    await released;
  }
}

export function threadObservationHandler(
  preparer: ThreadPreparationCoordinator,
  extensionToken: string,
): RequestHandler {
  const bodySchema = z.object({
    conversationUrl: z.string().max(2048),
    canPrepare: z.boolean().optional(),
  }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid thread observation request." });
      return;
    }
    try {
      const status = await preparer.schedule(
        parsed.data.conversationUrl,
        parsed.data.canPrepare === true,
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({ status });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Thread observation failed." });
    }
  };
}

function subagentPrompt(message: string, jobId: string, resultPath: string) {
  return [
    message.trim(),
    "",
    "You are a sub-agent working in a separate ChatGPT conversation.",
    "Your first MCP action must be sync_current_thread. If it reports syncing, follow it with get_current_thread_url; if it reports synced, do not sync again.",
    "Complete only the bounded task above. Nested delegation is disabled. Perform the work yourself. If assigned a review, remain read-only and report actionable defects with evidence.",
    "Your parent does not expect a browser message from you. Do not call send_thread_message to report back.",
    `When your work is complete, call submit_subagent_result exactly once with jobId ${JSON.stringify(jobId)} and put your complete final report in its result argument.`,
    `The application stores that report locally at ${JSON.stringify(resultPath)} and wakes the parent automatically.`,
    "After submit_subagent_result succeeds, end this child turn with only a brief acknowledgement.",
  ].join("\n");
}

async function subagentViews(
  parentThreadId: string,
  registry: RalphRegistry,
  jobs: SubagentJobRegistry,
) {
  const [threads, parentJobs] = await Promise.all([
    registry.subagents(parentThreadId),
    jobs.forParent(parentThreadId),
  ]);
  const jobsByChild = new Map(parentJobs.flatMap((job) => job.childThreadId ? [[job.childThreadId, job] as const] : []));
  const views = threads.map((thread) => {
    const job = jobsByChild.get(thread.threadId);
    return {
      conversationUrl: thread.conversationUrl,
      threadId: thread.threadId,
      title: thread.title,
      state: thread.state,
      mode: thread.mode,
      registeredAt: thread.registeredAt,
      nextCheckAt: thread.nextCheckAt,
      lastCheckedAt: thread.lastCheckedAt,
      lastContinuationAt: thread.lastContinuationAt,
      lastError: thread.lastError,
      ...(job ? {
        jobId: job.jobId,
        resultPath: job.resultPath,
        resultState: job.state,
        notifiedAt: job.notifiedAt,
        notificationAttempts: job.notificationAttempts,
        notificationAbandonedAt: job.notificationAbandonedAt,
        notificationError: job.notificationError,
        preparationError: job.preparationError,
      } : {}),
    };
  });
  return [...views, ...parentJobs.filter((job) => !job.childThreadId || !threads.some((thread) => thread.threadId === job.childThreadId)).map((job) => ({
    conversationUrl: job.childConversationUrl,
    threadId: job.childThreadId,
    title: job.title ?? "Child startup unconfirmed",
    state: job.state === "pending" ? "active" as const : "complete" as const,
    mode: "normal" as const,
    registeredAt: job.createdAt,
    nextCheckAt: 0,
    jobId: job.jobId,
    resultPath: job.resultPath,
    resultState: job.state,
    preparationError: job.preparationError,
  }))];
}

const subagentOutputSchema = {
  parentConversationUrl: z.string().url(),
  subagents: z.array(z.object({
    conversationUrl: z.string().url().optional(),
    threadId: z.string().optional(),
    title: z.string().optional(),
    state: z.enum(["active", "complete"]),
    mode: z.enum(["normal", "continuous"]),
    registeredAt: z.string(),
    nextCheckAt: z.number(),
    lastCheckedAt: z.string().optional(),
    lastContinuationAt: z.string().optional(),
    lastError: z.string().optional(),
    jobId: z.string().uuid().optional(),
    resultPath: z.string().optional(),
    resultState: z.enum(["pending", "complete", "cancelled"]).optional(),
    notifiedAt: z.string().optional(),
    notificationAttempts: z.number().int().nonnegative().optional(),
    notificationAbandonedAt: z.string().optional(),
    notificationError: z.string().optional(),
    preparationError: z.string().optional(),
  })),
};

const subagentToolMeta = {
  ui: { resourceUri: SUBAGENT_WIDGET_URI },
  "openai/outputTemplate": SUBAGENT_WIDGET_URI,
};

export function registerChatGptAgents(
  server: McpServer,
  commands: SupportCommandBus,
  bindings: ThreadBindingLookup,
  registry: RalphRegistry,
  jobs: SubagentJobRegistry,
  preparer: ThreadPreparationCoordinator,
  launchBrowser: () => Promise<void>,
  ownerId: string,
  widgetHtml: string,
) {
  server.registerResource("subagent-widget", SUBAGENT_WIDGET_URI, { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: SUBAGENT_WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: widgetHtml, _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }],
  }));

  server.registerTool("start_subagent", {
    title: "Start Sub-agent",
    description: "Start an independent ChatGPT sub-agent from a synced root. Use one reviewer by default. Two pending children are allowed service-wide, with slots reserved before startup; nested delegation is disabled. On capacity refusal, continue independent work or wait for a result notice without polling or retrying. The configured Sub-agent project is used, or chatgpt.com otherwise. Complete one-time thread sync first. Transport retries of the same MCP request are deduplicated internally; a new logical call creates another job. Reports are stored in a local file and parent notices may be batched. An unconfirmed startup keeps its slot until resolved through cancel_subagent.",
    inputSchema: {
      message: z.string().min(1).max(190_000).describe("Complete bounded task for the sub-agent. Do not include result transport or parent callback instructions; the server adds them."),
    },
    outputSchema: subagentOutputSchema,
    _meta: subagentToolMeta,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ message }, extra) => {
    const session = extra._meta?.["openai/session"];
    if (typeof session !== "string" || !session || session.length > 2048) {
      return {
        isError: true,
        content: [{ type: "text", text: "The client did not provide a valid openai/session. Call sync_current_thread at the start of this conversation before starting a sub-agent." }],
      };
    }
    const parent = await bindings.binding({ ownerId, sessionId: session });
    if (!parent) {
      return {
        isError: true,
        content: [{ type: "text", text: "This parent conversation is not synced. Call sync_current_thread first. If it reports syncing, finish with get_current_thread_url, then retry start_subagent." }],
      };
    }

    const fingerprint = createHash("sha256")
      .update(message)
      .digest("base64url");
    const replayKey = `start_subagent:${ownerId}:${session}:${String(extra.requestId)}:${fingerprint}`;
    return await replayToolRequest(replayKey, async () => {
      let job: Awaited<ReturnType<SubagentJobRegistry["create"]>>;
      try {
        if ((await registry.threads()).some((thread) => thread.threadId === parent.threadId && thread.parentThreadId)) {
          throw new SubagentAdmissionError("nested");
        }
        if (commands.messageCooldownUntil()) {
          throw new Error(`ChatGPT message cooldown until ${new Date(commands.messageCooldownUntil()).toISOString()}. Wait before starting a child.`);
        }
        job = await jobs.create(parent);
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
      let result: SupportCommandResult;
      try {
        const { subagentProjectUrl } = await registry.settings();
        await commands.ensureBrowser("threadMessaging", launchBrowser);
        result = await commands.execute({
          feature: "threadMessaging",
          kind: "send_message",
          targetUrl: subagentProjectUrl ?? "https://chatgpt.com/",
          message: subagentPrompt(message, job.jobId, job.resultPath),
        });
        if (!result.ok) throw new Error(result.error);
        if (result.kind !== "send_message") throw new Error("Sub-agent creation received the wrong support command result.");
      } catch (error) {
        // Delivery can fail after Send was clicked. Keep the reservation until the parent resolves it.
        await jobs.recordPreparationFailure(job.jobId, error instanceof Error ? error.message : String(error));
        return {
          isError: true,
          content: [{ type: "text", text: `Child startup could not be confirmed. Job ${job.jobId} still reserves a slot. ${error instanceof Error ? error.message : "Sub-agent creation failed."} Inspect the browser before using cancel_subagent to release it. Do not repeat the start request.` }],
        };
      }

      const child = parseConversationUrl(result.result.conversationUrl);
      await jobs.assignChild(job.jobId, {
        threadId: child.threadId,
        conversationUrl: child.conversationUrl,
        title: result.result.title,
      });
      await registry.register(child.conversationUrl, {
        agentCreated: true,
        parentThreadId: parent.threadId,
        title: result.result.title,
      });
      let preparationError: string | undefined;
      try {
        await preparer.ensurePrepared(child.conversationUrl);
      } catch (error) {
        preparationError = error instanceof Error ? error.message : String(error);
        await jobs.recordPreparationFailure(job.jobId, preparationError);
      }
      const structuredContent = {
        parentConversationUrl: parent.conversationUrl,
        subagents: await subagentViews(parent.threadId, registry, jobs),
      };
      return {
        content: [{ type: "text", text: preparationError
          ? `${child.conversationUrl}\nResult file: ${job.resultPath}\nAutomatic thread preparation failed: ${preparationError}`
          : `${child.conversationUrl}\nResult file: ${job.resultPath}` }],
        structuredContent,
      };
    });
  });

  server.registerTool("submit_subagent_result", {
    title: "Submit Sub-agent Result",
    description: "Finish this child's job by storing its complete report in the local result file. This releases its slot and stops future RALPH continuation. This does not message the parent directly; the application sends a delayed, possibly batched result notice. Submit once. A cancelled job rejects late results.",
    inputSchema: {
      jobId: z.string().uuid(),
      result: z.string().trim().min(1).max(200_000),
    },
    outputSchema: {
      resultPath: z.string(),
      status: z.literal("stored"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ jobId, result }, extra) => {
    const session = extra._meta?.["openai/session"];
    if (typeof session !== "string" || !session || session.length > 2048) {
      return {
        isError: true,
        content: [{ type: "text", text: "The client did not provide a valid openai/session. Sync this child conversation before submitting its result." }],
      };
    }
    const child = await bindings.binding({ ownerId, sessionId: session });
    if (!child) {
      return {
        isError: true,
        content: [{ type: "text", text: "This child conversation is not synced. Call sync_current_thread first, then finish the one-time sync before submitting the result." }],
      };
    }
    const job = await jobs.job(jobId);
    if (!job || job.childThreadId !== child.threadId) {
      return {
        isError: true,
        content: [{ type: "text", text: "This sub-agent job does not belong to the current child conversation." }],
      };
    }
    const completed = await jobs.complete(jobId, result);
    await registry.recordComplete(child.threadId);
    const structuredContent = { resultPath: completed.job.resultPath, status: "stored" as const };
    return {
      content: [{ type: "text", text: completed.job.resultPath }],
      structuredContent,
    };
  });

  server.registerTool("cancel_subagent", {
    title: "Cancel Sub-agent",
    description: "Release an abandoned pending job owned by this synced parent and disable its RALPH continuation. First stop any running child in the browser and confirm it is no longer working. This tool does not stop an already running browser turn. Use the job ID from start_subagent or list_subagents. Cancellation is permanent; late results are rejected.",
    inputSchema: { jobId: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ jobId }, extra) => {
    const session = extra._meta?.["openai/session"];
    const parent = typeof session === "string" ? await bindings.binding({ ownerId, sessionId: session }) : undefined;
    const job = await jobs.job(jobId);
    if (!parent || !job || job.parentThreadId !== parent.threadId) {
      return { isError: true, content: [{ type: "text", text: "This job does not belong to the current synced parent." }] };
    }
    if (job.state === "pending" && !job.childThreadId && !job.preparationError) {
      return { isError: true, content: [{ type: "text", text: "Child startup is still in progress. Wait for its startup result before cancelling this job." }] };
    }
    if (job.childThreadId) await registry.recordComplete(job.childThreadId);
    const cancelled = await jobs.cancel(jobId);
    return { content: [{ type: "text", text: `Job ${jobId}: ${cancelled.state}.` }] };
  });

  server.registerTool("send_thread_message", {
    title: "Send Thread Message",
    description: "Send one message to an existing ChatGPT conversation only when the user explicitly requests that post. Transport retries of the same MCP request are deduplicated internally. This tool never creates a new thread. Respect a returned cooldown. If delivery is uncertain, inspect the target before making a new send request.",
    inputSchema: {
      targetUrl: z.string().url().describe("Exact existing ChatGPT /c/... conversation URL."),
      message: z.string().min(1).max(200_000).describe("Message to send to that conversation."),
    },
    outputSchema: { conversationUrl: z.string().url() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ targetUrl, message }, extra) => {
    let normalizedTarget: string;
    try {
      normalizedTarget = parseConversationUrl(targetUrl).conversationUrl;
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : "Invalid ChatGPT conversation URL." }],
      };
    }

    const fingerprint = createHash("sha256")
      .update(normalizedTarget)
      .update("\0")
      .update(message)
      .digest("base64url");
    const session = typeof extra._meta?.["openai/session"] === "string"
      ? extra._meta["openai/session"]
      : "";
    const replayKey = `send_thread_message:${ownerId}:${session}:${String(extra.requestId)}:${fingerprint}`;
    return await replayToolRequest(replayKey, async (): Promise<CallToolResult> => {
      try {
        await commands.ensureBrowser("threadMessaging", launchBrowser);
        const result = await commands.execute({
          feature: "threadMessaging",
          kind: "send_message",
          targetUrl: normalizedTarget,
          message,
        });
        if (!result.ok) throw new Error(result.error);
        if (result.kind !== "send_message") throw new Error("Thread messaging received the wrong support command result.");
        const conversation = parseConversationUrl(result.result.conversationUrl);
        const structuredContent = { conversationUrl: conversation.conversationUrl };
        return {
          content: [{ type: "text", text: conversation.conversationUrl }],
          structuredContent,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "ChatGPT thread messaging failed." }],
        };
      }
    });
  });

  server.registerTool("list_subagents", {
    title: "List Sub-agents",
    description: "Inspect jobs owned by this synced parent, including pending or cancelled jobs, unconfirmed startups, local result paths, RALPH state, and notification errors. Use a snapshot when it changes your next action. This is not a waiting mechanism; wait for result notices instead of polling.",
    inputSchema: {},
    outputSchema: subagentOutputSchema,
    _meta: subagentToolMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (_input, extra) => {
    const session = extra._meta?.["openai/session"];
    if (typeof session !== "string" || !session || session.length > 2048) {
      return {
        isError: true,
        content: [{ type: "text", text: "The client did not provide a valid openai/session, so sub-agents cannot be resolved for this conversation." }],
      };
    }
    const parent = await bindings.binding({ ownerId, sessionId: session });
    if (!parent) {
      return {
        isError: true,
        content: [{ type: "text", text: "This conversation is not synced. Call sync_current_thread first. If it reports syncing, finish the one-time binding with get_current_thread_url, then retry list_subagents." }],
      };
    }
    const structuredContent = {
      parentConversationUrl: parent.conversationUrl,
      subagents: await subagentViews(parent.threadId, registry, jobs),
    };
    return {
      content: [{ type: "text", text: structuredContent.subagents.length === 0 ? "No sub-agents." : `${structuredContent.subagents.length} sub-agent(s).` }],
      structuredContent,
    };
  });
}

export class SubagentResultController {
  private readonly inFlight = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly batchAfter = new Map<string, number>();
  private readonly fileRetryAfter = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly jobs: SubagentJobRegistry,
    private readonly commands: SupportCommandBus,
    private readonly launchBrowser: () => Promise<void>,
    checkEveryMs = 1_000,
    private readonly batchWindowMs = 1_000,
  ) {
    this.timer = setInterval(() => void this.tick(), checkEveryMs);
    this.timer.unref();
  }

  async tick() {
    if (this.commands.messageCooldownUntil()) return;
    const jobs = await this.jobs.jobsNeedingNotification();
    const now = Date.now();
    for (const parentId of new Set(jobs.map((job) => job.parentThreadId))) {
      if (this.inFlight.has(parentId) || (this.retryAfter.get(parentId) ?? 0) > now) continue;
      this.inFlight.add(parentId);
      void this.check(parentId).catch((error: unknown) => {
        console.error(`[subagents] notification_check_failed parent=${parentId} error=${String(error)}`);
        this.retryAfter.set(parentId, Date.now() + SUBAGENT_RESULT_MISSING_RETRY_MS);
      }).finally(() => this.inFlight.delete(parentId));
    }
  }

  close() {
    clearInterval(this.timer);
  }

  private async check(parentId: string) {
    const ready: Awaited<ReturnType<SubagentJobRegistry["forParent"]>> = [];
    for (const job of await this.jobs.forParent(parentId)) {
      if (job.state === "cancelled" || job.notifiedAt || job.notificationAbandonedAt) continue;
      if ((this.fileRetryAfter.get(job.jobId) ?? 0) > Date.now()) continue;
      try {
        if (!(await readFile(job.resultPath, "utf8")).trim()) continue;
        if (job.state === "pending") await this.jobs.markFileComplete(job.jobId);
        if ((await this.jobs.job(job.jobId))?.state === "complete") ready.push(job);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        const failed = await this.jobs.recordNotificationFailure(job.jobId, String(error), MAX_SUBAGENT_NOTIFICATION_ATTEMPTS);
        this.fileRetryAfter.set(job.jobId, Date.now() + Math.min(
          SUBAGENT_RESULT_MISSING_RETRY_MS * 2 ** Math.max(0, failed.notificationAttempts - 1),
          MAX_SUBAGENT_NOTIFICATION_RETRY_MS,
        ));
      }
    }
    if (!ready.length) return;
    const batchAfter = this.batchAfter.get(parentId) ?? Date.now() + this.batchWindowMs;
    this.batchAfter.set(parentId, batchAfter);
    if (Date.now() < batchAfter || this.commands.messageCooldownUntil()) return;
    try {
      await this.commands.ensureBrowser("threadMessaging", this.launchBrowser);
      const wake = await this.commands.execute({
        feature: "threadMessaging",
        kind: "send_message",
        targetUrl: ready[0].parentConversationUrl,
        message: `Sub-agent results ready. Read these local files and continue the parent task:\n${ready.map((job) => `Job ${job.jobId}: ${JSON.stringify(job.resultPath)}`).join("\n")}\nThe files contain the reports. Use these results before deciding whether further review is needed.`,
      });
      if (!wake.ok) throw new Error(wake.error);
      if (wake.kind !== "send_message") throw new Error("Sub-agent wake-up received the wrong support command result.");
      await this.jobs.markNotified(ready.map((job) => job.jobId));
      this.retryAfter.delete(parentId);
      this.batchAfter.delete(parentId);
    } catch (error) {
      if (this.commands.messageCooldownUntil()) {
        if (error instanceof Error && error.message.startsWith("CHATGPT_RATE_LIMITED:")) {
          for (const job of ready) await this.jobs.recordNotificationFailure(job.jobId, error.message, MAX_SUBAGENT_NOTIFICATION_ATTEMPTS);
        }
        this.retryAfter.set(parentId, this.commands.messageCooldownUntil());
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const failures = [];
      for (const job of ready) failures.push(await this.jobs.recordNotificationFailure(job.jobId, message, MAX_SUBAGENT_NOTIFICATION_ATTEMPTS));
      const retryMs = Math.min(
        SUBAGENT_RESULT_MISSING_RETRY_MS * 2 ** Math.max(0, ...failures.map((job) => job.notificationAttempts - 1)),
        MAX_SUBAGENT_NOTIFICATION_RETRY_MS,
      );
      this.retryAfter.set(parentId, Date.now() + retryMs);
    }
  }
}
