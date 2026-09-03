import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Request, RequestHandler, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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
const RALPH_PREPARE_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_CONTINUATION_CHARS = 500;
const TOOL_REQUEST_REPLAY_TTL_MS = 30 * 60 * 1000;
const MAX_TOOL_REQUEST_REPLAYS = 1_000;

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
  "For delegated coding or research work, first call sync_current_thread and then get_current_thread_url so this parent conversation has a fresh binding.",
  "Use start_subagent to create a child. The server uses the configured Sub-agent project when present and otherwise starts from chatgpt.com. start_subagent automatically gives the child this parent thread URL and tells it to report back with send_thread_message.",
  "Use send_thread_message only to post into an existing ChatGPT conversation. Sub-agents are independent conversations and have no implicit return channel.",
  "Use list_subagents to inspect the children created by the current thread.",
].join(" ");
const CONTINUOUS_RALPH_INSTRUCTION = "Continue the continuous run toward the existing user goal. Re-read the conversation and current state, choose the next highest-value improvement, experiment, verification, or cleanup that advances that goal, execute it end to end, and keep working autonomously until this turn ends. Do not stop because the previous step appears complete and do not ask the user what to do next.";

export const supportFeatureSchema = z.enum(["ralph", "threadMessaging"]);
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
    feature: z.literal("ralph"),
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

  constructor(private readonly inspectClaimLeaseMs = INSPECT_CLAIM_LEASE_MS) {}

  execute(
    command: SupportCommandInput,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ) {
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

  claim(browserId: string, features: SupportFeature[], waitMs = CLAIM_WAIT_MS, signal?: AbortSignal) {
    const featureSet = new Set(features);
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
    "Its tool access expires after 25 minutes in each turn, and a new message starts a fresh turn with tool access restored.",
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
    features: z.array(supportFeatureSchema).max(2),
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

function prepareFreshRalphThread(commands: SupportCommandBus, conversationUrl: string) {
  void commands.execute({
    feature: "ralph",
    kind: "prepare_thread",
    conversationUrl: parseConversationUrl(conversationUrl).conversationUrl,
  }, RALPH_PREPARE_TIMEOUT_MS).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ralph] initial thread sync preparation failed thread=${JSON.stringify(conversationUrl)}: ${message}`);
  });
}

export function ralphRegistrationHandler(
  registry: RalphRegistry,
  commands: SupportCommandBus,
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
      if (registration === "registered") prepareFreshRalphThread(commands, parsed.data.conversationUrl);
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
}

function subagentPrompt(message: string, parentConversationUrl: string) {
  return [
    message.trim(),
    "",
    "You are a sub-agent working in a separate ChatGPT conversation.",
    "MANDATORY CALLBACK PROCEDURE:",
    "1. Complete the assigned task in this child conversation.",
    `2. BEFORE you produce your final assistant response here, you MUST call send_thread_message exactly once with targetUrl ${JSON.stringify(parentConversationUrl)}. Put your complete final report in the tool's message argument.`,
    "3. A normal assistant reply in this child conversation is NOT delivered to the parent and does NOT count as reporting back. Do not merely write the result here.",
    "4. After the send_thread_message call returns, do not call it again. If it reports an error or uncertain outcome, do not retry it because the first delivery may already have succeeded.",
    "5. Only after that tool call may you end this child turn with a brief acknowledgement.",
    "The callback message should contain the useful result, findings, changed files or commits, and verification status.",
  ].join("\n");
}

function subagentView(thread: z.infer<typeof ralphThreadSchema>) {
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
  };
}

const subagentOutputSchema = {
  parentConversationUrl: z.string().url(),
  subagents: z.array(z.object({
    conversationUrl: z.string().url(),
    threadId: z.string(),
    title: z.string().optional(),
    state: z.enum(["active", "complete"]),
    mode: z.enum(["normal", "continuous"]),
    registeredAt: z.string(),
    nextCheckAt: z.number(),
    lastCheckedAt: z.string().optional(),
    lastContinuationAt: z.string().optional(),
    lastError: z.string().optional(),
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
  ownerId: string,
  widgetHtml: string,
) {
  server.registerResource("subagent-widget", SUBAGENT_WIDGET_URI, { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{ uri: SUBAGENT_WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: widgetHtml, _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }],
  }));

  server.registerTool("start_subagent", {
    title: "Start Sub-agent",
    description: "Start an independent ChatGPT sub-agent. Transport retries of the same MCP request are deduplicated internally. The server uses the configured Sub-agent project when one is set and otherwise starts from chatgpt.com. Before calling this tool, call sync_current_thread and then get_current_thread_url so the parent thread is freshly bound. The child cannot implicitly return to this conversation, so this tool automatically appends the bound parent URL and instructs the child to report back with send_thread_message. The new child is registered for RALPH automatically.",
    inputSchema: {
      message: z.string().min(1).max(190_000).describe("Complete bounded task for the sub-agent. Do not include callback plumbing; it is added automatically."),
    },
    outputSchema: subagentOutputSchema,
    _meta: subagentToolMeta,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ message }, extra) => {
    const session = extra._meta?.["openai/session"];
    if (typeof session !== "string" || !session || session.length > 2048) {
      return {
        isError: true,
        content: [{ type: "text", text: "The client did not provide a valid openai/session. Call sync_current_thread, then get_current_thread_url, before starting a sub-agent." }],
      };
    }
    const parent = await bindings.binding({ ownerId, sessionId: session });
    if (!parent) {
      return {
        isError: true,
        content: [{ type: "text", text: "This parent conversation is not synced. Call sync_current_thread, then get_current_thread_url, and retry start_subagent." }],
      };
    }

    const fingerprint = createHash("sha256")
      .update(message)
      .digest("base64url");
    const replayKey = `start_subagent:${ownerId}:${session}:${String(extra.requestId)}:${fingerprint}`;
    return await replayToolRequest(replayKey, async () => {
      try {
        const { subagentProjectUrl } = await registry.settings();
        const result = await commands.execute({
          feature: "threadMessaging",
          kind: "send_message",
          targetUrl: subagentProjectUrl ?? "https://chatgpt.com/",
          message: subagentPrompt(message, parent.conversationUrl),
        });
        if (!result.ok) throw new Error(result.error);
        if (result.kind !== "send_message") throw new Error("Sub-agent creation received the wrong support command result.");
        const child = parseConversationUrl(result.result.conversationUrl);
        const registration = await registry.register(child.conversationUrl, {
          agentCreated: true,
          parentThreadId: parent.threadId,
          title: result.result.title,
        });
        if (registration === "registered") prepareFreshRalphThread(commands, child.conversationUrl);
        const structuredContent = {
          parentConversationUrl: parent.conversationUrl,
          subagents: (await registry.subagents(parent.threadId)).map(subagentView),
        };
        return {
          content: [{ type: "text", text: child.conversationUrl }],
          structuredContent,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "Sub-agent creation failed." }],
        };
      }
    });
  });

  server.registerTool("send_thread_message", {
    title: "Send Thread Message",
    description: "Send one message to an existing ChatGPT conversation. Transport retries of the same MCP request are deduplicated internally. This tool never creates a new thread.",
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
    description: "Show the sub-agents created by this ChatGPT conversation, including their title, RALPH state, continuous mode, last activity, and errors. The current parent thread must be synced.",
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
        content: [{ type: "text", text: "This conversation is not synced. Call sync_current_thread, then get_current_thread_url, and retry list_subagents." }],
      };
    }
    const structuredContent = {
      parentConversationUrl: parent.conversationUrl,
      subagents: (await registry.subagents(parent.threadId)).map(subagentView),
    };
    return {
      content: [{ type: "text", text: structuredContent.subagents.length === 0 ? "No sub-agents." : `${structuredContent.subagents.length} sub-agent(s).` }],
      structuredContent,
    };
  });
}
