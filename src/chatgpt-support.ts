import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Request, RequestHandler, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
const CLAIM_WAIT_MS = 20_000;
const MAX_CONTINUATION_CHARS = 500;

export const supportFeatureSchema = z.enum(["ralph", "threadMessaging"]);
export type SupportFeature = z.infer<typeof supportFeatureSchema>;

const threadMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
});

export const threadInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("loading") }),
  z.object({ status: z.literal("running") }),
  z.object({
    status: z.literal("idle"),
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
    kind: z.literal("send_message"),
    targetUrl: z.string().url(),
    message: z.string(),
  }),
  z.object({
    id: z.string(),
    feature: z.literal("threadMessaging"),
    kind: z.literal("send_message"),
    targetUrl: z.string().url().optional(),
    message: z.string(),
  }),
]);
export type SupportCommand = z.infer<typeof supportCommandSchema>;
type SupportCommandInput =
  | Omit<Extract<SupportCommand, { kind: "inspect_thread" }>, "id">
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
    kind: z.literal("send_message"),
    ok: z.literal(true),
    result: sendMessageResultSchema,
  }),
  z.object({
    commandId: z.string(),
    browserId: z.string(),
    kind: z.union([z.literal("inspect_thread"), z.literal("send_message")]),
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
        this.resolveWaiter(waiter, fullCommand);
        return;
      }

      this.queued.push(pending);
    });
  }

  claim(browserId: string, features: SupportFeature[], waitMs = CLAIM_WAIT_MS, signal?: AbortSignal) {
    const featureSet = new Set(features);
    const resumable = [...this.pending.values()].find((pending) =>
      pending.claimedBy === browserId &&
      pending.command.kind === "inspect_thread" &&
      featureSet.has(pending.command.feature));
    if (resumable) return Promise.resolve(resumable.command);

    const queuedIndex = this.queued.findIndex((pending) => featureSet.has(pending.command.feature));
    if (queuedIndex >= 0) {
      const [pending] = this.queued.splice(queuedIndex, 1);
      pending.claimedBy = browserId;
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
  manuallyRegistered: z.boolean().optional(),
  registeredAt: z.string(),
  nextCheckAt: z.number(),
  state: z.enum(["active", "complete"]),
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
    return { loopIntervalSeconds: this.state.loopIntervalMs / 1000 };
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
        if (thread.manuallyRegistered) return true;
        const projectId = parseConversationUrl(thread.conversationUrl).projectId;
        return projectId !== undefined && allowed.has(projectId);
      });
      return [...projects];
    });
  }

  async register(conversationUrl: string, options: { manual?: boolean; reactivate?: boolean } = {}) {
    const conversation = parseConversationUrl(conversationUrl);
    return this.update((state) => {
      const projectAllowed = conversation.projectId && state.projects.includes(conversation.projectId);
      const existing = state.threads.find((entry) => entry.threadId === conversation.threadId);
      if (!options.manual && !projectAllowed && !existing?.manuallyRegistered) return false;
      if (existing) {
        if (existing.conversationUrl !== conversation.conversationUrl) {
          existing.conversationUrl = conversation.conversationUrl;
        }
        if (options.manual) existing.manuallyRegistered = true;
        if ((options.manual || options.reactivate) && existing.state === "complete") {
          existing.state = "active";
          existing.lastError = undefined;
          existing.nextCheckAt = Date.now() + state.loopIntervalMs;
        }
        return existing.state === "active";
      }
      if (state.threads.length >= MAX_RALPH_THREADS) throw new Error("RALPH thread registration limit reached.");
      state.threads.push({
        conversationUrl: conversation.conversationUrl,
        threadId: conversation.threadId,
        ...(options.manual ? { manuallyRegistered: true } : {}),
        registeredAt: new Date().toISOString(),
        nextCheckAt: Date.now() + state.loopIntervalMs,
        state: "active",
      });
      return true;
    });
  }

  async due(now = Date.now()) {
    await this.queue;
    return this.state.threads
      .filter((entry) => entry.state === "active" && entry.nextCheckAt <= now)
      .map((entry) => ({ ...entry }));
  }

  async isActive(threadId: string) {
    await this.queue;
    return this.state.threads.some((entry) => entry.threadId === threadId && entry.state === "active");
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

export function normalizeChatGptMessageTarget(value: string) {
  const url = new URL(value);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password) {
    throw new Error("ChatGPT message targets must use https://chatgpt.com.");
  }
  if (url.pathname === "/") {
    throw new Error("New agent threads must target a ChatGPT project URL.");
  }
  if (/^\/g\/[A-Za-z0-9_-]+\/project\/?$/.test(url.pathname)) {
    return `${url.origin}${url.pathname}${url.search}`;
  }
  return parseConversationUrl(value).conversationUrl;
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
      if (!await this.options.registry.isActive(thread.threadId)) return;

      const sendResult = await this.options.commands.execute({
        feature: "ralph",
        kind: "send_message",
        targetUrl: thread.conversationUrl,
        message: decision.instruction,
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

export function ralphRegistrationHandler(registry: RalphRegistry, extensionToken: string): RequestHandler {
  const bodySchema = z.object({
    conversationUrl: z.string().max(2048),
    manual: z.boolean().optional(),
    reactivate: z.boolean().optional(),
  }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid RALPH registration request." });
      return;
    }
    try {
      const registered = await registry.register(parsed.data.conversationUrl, {
        manual: parsed.data.manual === true,
        reactivate: parsed.data.reactivate === true,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: registered ? "registered" : "ignored" });
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
  const bodySchema = z.object({ loopIntervalSeconds: ralphLoopIntervalSecondsSchema }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `RALPH initial check delay must be a whole number from ${MIN_RALPH_INTERVAL_SECONDS} to ${MAX_RALPH_INTERVAL_SECONDS} seconds.` });
      return;
    }
    const settings = await registry.setLoopIntervalSeconds(parsed.data.loopIntervalSeconds);
    res.setHeader("Cache-Control", "no-store");
    res.json(settings);
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

export function registerChatGptMessaging(
  server: McpServer,
  commands: SupportCommandBus,
) {
  server.registerTool("chatgpt_message", {
    title: "Send ChatGPT Message",
    description: "Start a new ChatGPT thread or send a message to an existing ChatGPT thread through the Local Codex Support extension. Omit targetUrl to start a new sub-agent in the project configured in the extension popup. Provide an existing /c/... conversation URL to message that thread instead.",
    inputSchema: {
      targetUrl: z.string().url().optional().describe("Optional ChatGPT project new-chat URL or existing conversation URL. Omit this to use the extension's configured Sub-agent project."),
      message: z.string().min(1).max(200_000).describe("Message to send."),
    },
    outputSchema: {
      conversationUrl: z.string().url(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ targetUrl, message }) => {
    let normalizedTarget: string | undefined;
    try {
      normalizedTarget = targetUrl === undefined ? undefined : normalizeChatGptMessageTarget(targetUrl);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : "Invalid ChatGPT target URL." }],
      };
    }

    try {
      const result = await commands.execute({
        feature: "threadMessaging",
        kind: "send_message",
        ...(normalizedTarget ? { targetUrl: normalizedTarget } : {}),
        message,
      });
      if (!result.ok) throw new Error(result.error);
      if (result.kind !== "send_message") throw new Error("ChatGPT messaging received the wrong support command result.");
      const conversation = parseConversationUrl(result.result.conversationUrl);
      const structuredContent = { conversationUrl: conversation.conversationUrl };
      return {
        content: [{ type: "text", text: conversation.conversationUrl }],
        structuredContent,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : "ChatGPT message automation failed." }],
      };
    }
  });
}
