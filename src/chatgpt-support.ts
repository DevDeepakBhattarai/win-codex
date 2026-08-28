import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Request, RequestHandler, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MAX_RALF_THREADS = 2_000;
const MAX_RALF_PROJECTS = 100;
const DEFAULT_RALF_INTERVAL_MS = 25 * 60 * 1000;
const LOADING_RETRY_MS = 60 * 1000;
const FAILURE_RETRY_MS = 2 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const CLAIM_WAIT_MS = 20_000;
const MAX_CONTINUATION_CHARS = 500;

export const supportFeatureSchema = z.enum(["ralf", "threadMessaging"]);
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
    feature: z.literal("ralf"),
    kind: z.literal("inspect_thread"),
    conversationUrl: z.string().url(),
  }),
  z.object({
    id: z.string(),
    feature: z.literal("ralf"),
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

const ralfThreadSchema = z.object({
  conversationUrl: z.string().url(),
  threadId: z.string(),
  registeredAt: z.string(),
  nextCheckAt: z.number(),
  state: z.enum(["active", "complete"]),
  lastCheckedAt: z.string().optional(),
  lastContinuationAt: z.string().optional(),
  lastError: z.string().optional(),
});
const ralfStoreV1Schema = z.object({
  version: z.literal(1),
  threads: z.array(ralfThreadSchema).max(MAX_RALF_THREADS),
  exclusions: z.array(z.object({
    conversationUrl: z.string().url(),
    threadId: z.string(),
    excludedAt: z.string(),
  })).max(MAX_RALF_THREADS),
});
const ralfStoreSchema = z.object({
  version: z.literal(2),
  projects: z.array(z.string()).max(MAX_RALF_PROJECTS),
  threads: z.array(ralfThreadSchema).max(MAX_RALF_THREADS),
});
type RalfStore = z.infer<typeof ralfStoreSchema>;

export class RalfRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private state: RalfStore,
    private readonly intervalMs: number,
  ) {}

  static async open(dataDirectory: string, intervalMs = DEFAULT_RALF_INTERVAL_MS) {
    await mkdir(dataDirectory, { recursive: true });
    const filePath = path.join(dataDirectory, "ralf.json");
    let state: RalfStore = { version: 2, projects: [], threads: [] };
    let migrated = false;
    try {
      const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
      const current = ralfStoreSchema.safeParse(raw);
      if (current.success) {
        state = current.data;
      } else if (ralfStoreV1Schema.safeParse(raw).success) {
        // Version 1 registered every synced thread and permanently excluded agent-created
        // threads. Neither behavior belongs in the project-scoped RALF model.
        migrated = true;
      } else {
        state = ralfStoreSchema.parse(raw);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (migrated) {
      await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    return new RalfRegistry(filePath, state, intervalMs);
  }

  async projects() {
    await this.queue;
    return [...this.state.projects];
  }

  async threads() {
    await this.queue;
    return this.state.threads.map((entry) => ({ ...entry }));
  }

  async setProjects(values: string[]) {
    const projects = [...new Set(values.map(parseRalfProjectId))];
    if (projects.length > MAX_RALF_PROJECTS) throw new Error(`RALF supports at most ${MAX_RALF_PROJECTS} projects.`);
    return this.update((state) => {
      state.projects = projects;
      const allowed = new Set(projects);
      state.threads = state.threads.filter((thread) => {
        const projectId = parseConversationUrl(thread.conversationUrl).projectId;
        return projectId !== undefined && allowed.has(projectId);
      });
      return [...projects];
    });
  }

  async register(conversationUrl: string) {
    const conversation = parseConversationUrl(conversationUrl);
    return this.update((state) => {
      if (!conversation.projectId || !state.projects.includes(conversation.projectId)) return false;
      const existing = state.threads.find((entry) => entry.threadId === conversation.threadId);
      if (existing) {
        if (existing.conversationUrl !== conversation.conversationUrl) {
          existing.conversationUrl = conversation.conversationUrl;
        }
        return existing.state === "active";
      }
      if (state.threads.length >= MAX_RALF_THREADS) throw new Error("RALF thread registration limit reached.");
      state.threads.push({
        conversationUrl: conversation.conversationUrl,
        threadId: conversation.threadId,
        registeredAt: new Date().toISOString(),
        nextCheckAt: Date.now() + this.intervalMs,
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

  async recordRunning(threadId: string) {
    await this.reschedule(threadId, this.intervalMs);
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
    await this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread) return;
      thread.state = "complete";
      thread.lastCheckedAt = new Date().toISOString();
      thread.lastError = undefined;
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
      thread.nextCheckAt = Date.now() + this.intervalMs;
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

  private update<T>(operation: (state: RalfStore) => T): Promise<T> {
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

export function parseRalfProjectId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("RALF project entries cannot be empty.");
  if (!trimmed.includes("://")) return canonicalProjectId(trimmed);

  const url = new URL(trimmed);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password) {
    throw new Error("RALF projects must use https://chatgpt.com.");
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

interface RalfControllerOptions {
  registry: RalfRegistry;
  commands: SupportCommandBus;
  apiKey?: string;
  model: string;
  checkEveryMs?: number;
}

export class RalfController {
  private readonly inFlight = new Set<string>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: RalfControllerOptions) {
    this.timer = setInterval(() => void this.tick(), options.checkEveryMs ?? 30_000);
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

  private async check(thread: z.infer<typeof ralfThreadSchema>) {
    try {
      const commandResult = await this.options.commands.execute({
        feature: "ralf",
        kind: "inspect_thread",
        conversationUrl: thread.conversationUrl,
      });
      if (!commandResult.ok) throw new Error(commandResult.error);
      if (commandResult.kind !== "inspect_thread") throw new Error("RALF received the wrong support command result.");

      const inspection = commandResult.result;
      if (inspection.status === "loading") {
        await this.options.registry.recordLoading(thread.threadId);
        return;
      }
      if (inspection.status === "running") {
        await this.options.registry.recordRunning(thread.threadId);
        return;
      }

      if (inspection.workedSeconds === null) {
        await this.options.registry.recordComplete(thread.threadId);
        return;
      }

      const decision = await decideRalfContinuation(inspection, this.options.apiKey, this.options.model);
      if (decision.complete) {
        await this.options.registry.recordComplete(thread.threadId);
        return;
      }

      const sendResult = await this.options.commands.execute({
        feature: "ralf",
        kind: "send_message",
        targetUrl: thread.conversationUrl,
        message: decision.instruction,
      });
      if (!sendResult.ok) throw new Error(sendResult.error);
      if (sendResult.kind !== "send_message") throw new Error("RALF received the wrong send-message result.");
      await this.options.registry.recordContinuation(thread.threadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ralf] thread=${JSON.stringify(thread.conversationUrl)} failed: ${message}`);
      await this.options.registry.recordFailure(thread.threadId, message);
    }
  }
}

async function decideRalfContinuation(inspection: Extract<ThreadInspection, { status: "idle" }>, apiKey: string | undefined, model: string) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for RALF continuation decisions.");
  const transcript = [
    ...inspection.users.map((message) => `USER:\n${message.text}`),
    `ASSISTANT:\n${inspection.assistant.text}`,
  ].join("\n\n");
  const instruction = [
    "You control a RALF loop for another ChatGPT thread.",
    "Decide whether the user's requested work is fully complete based only on all user messages and the final assistant message below.",
    "If complete, reply with exactly COMPLETE.",
    "If incomplete, reply with only a very short one or two sentence instruction telling the agent what to do next. Do not say generic 'continue'. Do not explain your reasoning.",
  ].join(" ");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 120,
      input: [
        { role: "system", content: [{ type: "input_text", text: instruction }] },
        { role: "user", content: [{ type: "input_text", text: transcript }] },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1_000);
    throw new Error(`OpenAI RALF decision failed with HTTP ${response.status}: ${body}`);
  }

  const text = extractResponsesText(await response.json()).trim();
  if (!text) throw new Error("OpenAI RALF decision returned no text.");
  if (/^COMPLETE\.?$/i.test(text)) return { complete: true as const };
  return { complete: false as const, instruction: compactContinuation(text) };
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
  if (!normalized) throw new Error("OpenAI RALF decision returned an empty continuation instruction.");
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

export function ralfRegistrationHandler(registry: RalfRegistry, extensionToken: string): RequestHandler {
  const bodySchema = z.object({ conversationUrl: z.string().max(2048) }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid RALF registration request." });
      return;
    }
    try {
      const registered = await registry.register(parsed.data.conversationUrl);
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: registered ? "registered" : "ignored" });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "RALF registration failed." });
    }
  };
}

export function ralfProjectsGetHandler(registry: RalfRegistry, extensionToken: string): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ projects: await registry.projects() });
  };
}

export function ralfThreadsGetHandler(registry: RalfRegistry, extensionToken: string): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ threads: await registry.threads() });
  };
}

export function ralfProjectsPutHandler(registry: RalfRegistry, extensionToken: string): RequestHandler {
  const bodySchema = z.object({
    projects: z.array(z.string().min(1).max(2048)).max(MAX_RALF_PROJECTS),
  }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid RALF projects request." });
      return;
    }
    try {
      const projects = await registry.setProjects(parsed.data.projects);
      res.setHeader("Cache-Control", "no-store");
      res.json({ projects });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not update RALF projects." });
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
