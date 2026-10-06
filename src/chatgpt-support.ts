import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Request, RequestHandler, Response } from "express";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SubagentJobRegistry } from "./subagent-jobs.js";

const MAX_RALPH_THREADS = 2_000;
const MAX_RALPH_PROJECTS = 100;
const LEGACY_RALPH_DEFAULT_INTERVAL_MS = 25 * 60 * 1000;
const INTERIM_RALPH_DEFAULT_INTERVAL_MS = 10 * 1000;
const DEFAULT_RALPH_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const MIN_RALPH_INTERVAL_SECONDS = 2 * 60;
const MAX_RALPH_INTERVAL_SECONDS = 24 * 60 * 60;
const RALPH_SCHEDULER_TICK_MS = 1_000;
const FAILURE_RETRY_MS = 2 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const INSPECT_CLAIM_LEASE_MS = 5 * 60 * 1000;
const CLAIM_WAIT_MS = 20_000;
const RALPH_BROWSER_INSPECTION_TIMEOUT_MS = 3 * 60_000;
const SUPPORT_BROWSER_HEARTBEAT_GRACE_MS = 90_000;
const SUPPORT_BROWSER_LAUNCH_COOLDOWN_MS = 60_000;
const SUPPORT_BROWSER_CONNECT_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_THREAD_PREPARATIONS = 3;
const RALPH_PREPARE_TIMEOUT_MS = 3 * 60 * 1000;
const THREAD_PREPARATION_HOLD_MS = 2 * 60 * 1000;
const COMPLETED_THREAD_TAB_RETENTION_MS = 0;
const THREAD_TAB_CLEANUP_TICK_MS = 5 * 1000;
const TOOL_REQUEST_REPLAY_TTL_MS = 30 * 60 * 1000;
const MAX_TOOL_REQUEST_REPLAYS = 1_000;
const MESSAGE_COOLDOWN_MS = 10 * 60_000;
const MESSAGE_SEND_SPACING_MS = 5_000;
const RECOVERY_RESERVATION_MS = 9 * 60_000;

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

export const SUBAGENT_AGENT_INSTRUCTION = "For reviews, browser work, application testing, or bounded independent assignments in a large task, use the blocking local CLI with a specification file. Keep planning, implementation, diagnosis, reproduction, and evidence collection in the parent unless the user assigns them to a worker. Keep the parent turn active until the command returns and read the complete report. Assigned workers execute their specification themselves and publish their report through the supplied temporary file and rename.";

export const supportFeatureSchema = z.enum(["ralph", "threadMessaging", "threadPreparation", "threadLifecycle", "voice"]);
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

const stopThreadResultSchema = z.object({
  status: z.enum(["stopped", "idle"]),
  conversationUrl: z.string().url(),
});

const supportCommandSchema = z.union([
  z.object({
    id: z.string(),
    feature: z.literal("voice"),
    kind: z.enum(["voice_status", "voice_start", "voice_stop"]),
    targetUrl: z.string().url(),
  }),
  z.object({
    id: z.string(),
    refreshRevision: z.string().optional(),
    feature: z.enum(["ralph", "threadMessaging"]),
    kind: z.literal("inspect_thread"),
    conversationUrl: z.string().url(),
    executorOnly: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    refreshRevision: z.string().optional(),
    feature: z.literal("threadPreparation"),
    kind: z.literal("prepare_thread"),
    conversationUrl: z.string().url(),
  }),
  z.object({
    id: z.string(),
    refreshRevision: z.string().optional(),
    feature: z.literal("threadLifecycle"),
    kind: z.literal("close_thread"),
    conversationUrl: z.string().url(),
  }),
  z.object({
    id: z.string(),
    refreshRevision: z.string().optional(),
    feature: z.literal("ralph"),
    kind: z.literal("send_message"),
    targetUrl: z.string().url(),
    message: z.string(),
  }),
  z.object({
    id: z.string(),
    refreshRevision: z.string().optional(),
    feature: z.literal("threadMessaging"),
    kind: z.literal("send_message"),
    targetUrl: z.string().url(),
    message: z.string(),
    connectorName: z.string().min(1).optional(),
    temporary: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    refreshRevision: z.string().optional(),
    feature: z.literal("threadMessaging"),
    kind: z.literal("stop_thread"),
    targetUrl: z.string().url(),
  }),
]);
export type SupportCommand = z.infer<typeof supportCommandSchema>;
type WithoutCommandId<T> = T extends { id: string } ? Omit<T, "id"> : never;
type SupportCommandInput = WithoutCommandId<SupportCommand>;

const commandResultSchema = z.union([
  z.object({
    commandId: z.string(),
    browserId: z.string(),
    kind: z.enum(["voice_status", "voice_start", "voice_stop"]),
    ok: z.literal(true),
    result: z.object({
      status: z.enum(["closed", "active", "unavailable"]),
      conversationUrl: z.string().url(),
    }),
  }),
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
    kind: z.literal("close_thread"),
    ok: z.literal(true),
    result: z.object({
      status: z.enum(["closed", "not_owned"]),
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
    kind: z.literal("stop_thread"),
    ok: z.literal(true),
    result: stopThreadResultSchema,
  }),
  z.object({
    commandId: z.string(),
    browserId: z.string(),
    kind: z.enum(["inspect_thread", "prepare_thread", "close_thread", "send_message", "stop_thread", "voice_status", "voice_start", "voice_stop"]),
    ok: z.literal(false),
    error: z.string().min(1).max(2_000),
    deliveryUncertain: z.boolean().optional(),
  }),
]);
export type SupportCommandResult = z.infer<typeof commandResultSchema>;

interface PendingCommand {
  command: SupportCommand;
  resolve: (result: SupportCommandResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  timeoutMs: number;
  deadline: number;
  claimedBy?: string;
  claimedAt?: number;
  inspectionFallback?: NodeJS.Timeout;
  allowBrowserLaunch: boolean;
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
  private readonly browsers = new Map<string, { features: Set<SupportFeature>; lastSeenAt: number; openThreads: Set<string> }>();
  private launchInFlight?: Promise<void>;
  private lastLaunchAt = 0;
  private readonly backgroundLaunchPending = new Set<SupportFeature>();
  private cooldownUntil = 0;
  private nextMessageClaimAt = 0;
  private messagePacingActive = false;
  private pauseInFlight?: Promise<number>;
  private readonly recoveryReservations = new Map<string, { id: string; browserId: string; expiresAt: number }>();
  private readonly voiceConfigurations = new Set<string>();

  messageCooldownUntil() {
    return this.cooldownUntil > Date.now() ? this.cooldownUntil : 0;
  }

  automationPausedUntil() {
    return this.registry?.automationPausedUntil() ?? 0;
  }

  voiceConversationUrl() {
    return this.registry?.voiceConversationUrl();
  }

  hasPendingMessage(conversationUrl: string, exceptCommandId?: string) {
    const { threadId } = parseConversationUrl(conversationUrl);
    return [...this.pending.values()].some(({ command }) => {
      if (command.kind !== "send_message" || command.id === exceptCommandId) return false;
      try { return parseConversationUrl(command.targetUrl).threadId === threadId; } catch { return false; }
    });
  }

  private recoveryReservation(threadId: string) {
    const reservation = this.recoveryReservations.get(threadId);
    if (reservation && reservation.expiresAt <= Date.now()) this.recoveryReservations.delete(threadId);
    return this.recoveryReservations.get(threadId);
  }

  reserveRecovery(browserId: string, conversationUrl: string, commandId?: string) {
    const { threadId } = parseConversationUrl(conversationUrl);
    if (commandId) {
      const pending = this.pending.get(commandId);
      if (!pending || pending.claimedBy !== browserId || pending.command.kind !== "send_message" ||
          parseConversationUrl(pending.command.targetUrl).threadId !== threadId) {
        throw new Error("Recovery command does not belong to this browser and conversation.");
      }
    }
    if (this.pauseInFlight || this.automationPausedUntil() || this.registry?.isVoiceConversation(conversationUrl) || this.voiceConfigurations.has(threadId) ||
        this.recoveryReservation(threadId) || this.hasPendingMessage(conversationUrl, commandId)) {
      throw new Error("Recovery conflicts with Voice, a pending message, or another browser's recovery.");
    }
    const reservation = { id: randomUUID(), browserId, expiresAt: Date.now() + RECOVERY_RESERVATION_MS };
    this.recoveryReservations.set(threadId, reservation);
    return reservation;
  }

  releaseRecovery(browserId: string, conversationUrl: string, id: string) {
    const { threadId } = parseConversationUrl(conversationUrl);
    const reservation = this.recoveryReservation(threadId);
    if (reservation?.id === id && reservation.browserId === browserId) this.recoveryReservations.delete(threadId);
  }

  protectVoiceConfiguration(conversationUrl: string) {
    const { threadId } = parseConversationUrl(conversationUrl);
    const pendingAutomation = [...this.pending.values()].some(({ command }) => {
      if (command.feature === "voice") return false;
      const target = "conversationUrl" in command ? command.conversationUrl : command.targetUrl;
      try { return parseConversationUrl(target).threadId === threadId; } catch { return false; }
    });
    if (this.recoveryReservation(threadId) || pendingAutomation) {
      throw new Error("This conversation has recovery or thread automation in progress. Retry Voice configuration after it finishes.");
    }
    this.voiceConfigurations.add(threadId);
    return () => { this.voiceConfigurations.delete(threadId); };
  }

  async pauseAutomation(until?: number) {
    while (this.pauseInFlight) await this.pauseInFlight;
    const operation = this.persistAutomationPause(until);
    this.pauseInFlight = operation;
    try { return await operation; } finally { if (this.pauseInFlight === operation) this.pauseInFlight = undefined; }
  }

  private async persistAutomationPause(requestedUntil?: number) {
    if (!this.registry) throw new Error("Automation pause requires the persistent registry.");
    const previous = this.automationPausedUntil();
    const until = await this.registry.pauseAutomation(requestedUntil);
    const extension = until - Math.max(Date.now(), previous);
    if (extension > 0) {
      for (const pending of this.pending.values()) {
        if (pending.command.feature === "voice") continue;
        pending.deadline += extension;
        clearTimeout(pending.timeout);
        pending.timeout = setTimeout(() => {
          this.removePending(pending.command.id);
          pending.reject(new Error(`ChatGPT support command timed out: ${pending.command.kind}`));
        }, Math.max(1, pending.deadline - Date.now()));
        pending.timeout.unref();
      }
    }
    for (const waiter of [...this.waiters]) this.resolveWaiter(waiter, undefined);
    return until;
  }

  cancelThreadChecks(threadId: string, ralphOnly = false) {
    for (const pending of this.pending.values()) {
      const command = pending.command;
      const url = "conversationUrl" in command ? command.conversationUrl : command.targetUrl;
      if ((command.feature !== "ralph" && (ralphOnly || command.feature !== "threadPreparation")) || parseConversationUrl(url).threadId !== threadId) continue;
      this.removePending(command.id);
      pending.reject(new Error(ralphOnly ? "RALPH check was superseded." : "RALPH thread tab was closed."));
    }
  }

  constructor(
    private readonly inspectClaimLeaseMs = INSPECT_CLAIM_LEASE_MS,
    private readonly messageCooldownMs = MESSAGE_COOLDOWN_MS,
    private readonly messageSendSpacingMs = MESSAGE_SEND_SPACING_MS,
    private readonly launchBrowser?: () => Promise<void>,
    private readonly registry?: RalphRegistry,
    private readonly jobs?: SubagentJobRegistry,
    private readonly browserConnectWaitMs = SUPPORT_BROWSER_CONNECT_TIMEOUT_MS,
  ) {}

  async execute(
    command: SupportCommandInput,
    timeoutMs = COMMAND_TIMEOUT_MS,
    options: { allowBrowserLaunch?: boolean } = {},
  ) {
    const allowBrowserLaunch = options.allowBrowserLaunch !== false;
    while (command.feature !== "voice" && this.automationPausedUntil()) {
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(1000, this.automationPausedUntil() - Date.now())));
    }
    const targetUrl = "conversationUrl" in command ? command.conversationUrl : command.targetUrl;
    if (command.feature !== "voice" && this.registry?.isVoiceConversation(targetUrl)) {
      throw new Error("The dedicated Voice conversation is protected from thread automation.");
    }
    let targetThreadId: string | undefined;
    try { targetThreadId = parseConversationUrl(targetUrl).threadId; } catch { targetThreadId = undefined; }
    if (command.feature !== "voice" && targetThreadId &&
        (this.voiceConfigurations.has(targetThreadId) || (command.kind === "send_message" && this.recoveryReservation(targetThreadId)))) {
      throw new Error("The conversation has Voice configuration or recovery in progress. The command was not sent. Retry after it finishes.");
    }
    if (command.feature === "ralph" && targetThreadId && this.jobs?.blocksContinuationNow(targetThreadId)) {
      throw new Error("RALPH is paused for this task handoff.");
    }
    if (allowBrowserLaunch && (command.feature === "voice" || command.kind === "send_message" || command.kind === "stop_thread" || command.kind === "prepare_thread") && this.launchBrowser) {
      await this.ensureBrowser(command.feature, this.launchBrowser);
    }
    if (allowBrowserLaunch && command.kind === "inspect_thread" && this.launchBrowser) {
      const threadId = parseConversationUrl(targetUrl).threadId;
      if (command.executorOnly || !this.hasOpenThreadOwner(threadId)) {
        await this.ensureBrowser(command.feature, this.launchBrowser);
      }
    }
    const refreshRevision = this.registry ? await this.registry.externalRevision(targetUrl) : undefined;
    const fullCommand = supportCommandSchema.parse({ ...command, ...(refreshRevision ? { refreshRevision } : {}), id: randomUUID() });
    if (command.feature !== "voice" && targetThreadId &&
        (this.voiceConfigurations.has(targetThreadId) || this.registry?.isVoiceConversation(targetUrl) ||
          (command.kind === "send_message" && this.recoveryReservation(targetThreadId)))) {
      throw new Error("The conversation has Voice configuration or recovery in progress. The command was not sent. Retry after it finishes.");
    }
    return new Promise<SupportCommandResult>((resolve, reject) => {
      const pending: PendingCommand = {
        command: fullCommand,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removePending(fullCommand.id);
          reject(new Error(`ChatGPT support command timed out: ${fullCommand.kind}`));
        }, timeoutMs),
        timeoutMs,
        deadline: Date.now() + timeoutMs,
        allowBrowserLaunch,
      };
      pending.timeout.unref();
      this.pending.set(fullCommand.id, pending);

      const waiter = [...this.waiters].find((candidate) =>
        this.browserCanClaim(candidate.browserId, fullCommand) && this.canClaim(fullCommand));
      if (waiter) {
        this.markClaimed(pending, waiter.browserId);
        this.resolveWaiter(waiter, fullCommand);
        return;
      }

      this.queued.push(pending);
      this.scheduleInspectionFallback(pending);
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
      if (await this.waitForBrowser(feature)) return;
      throw this.executorUnavailableError(feature);
    }

    const sinceLastLaunch = Date.now() - this.lastLaunchAt;
    if (sinceLastLaunch < SUPPORT_BROWSER_LAUNCH_COOLDOWN_MS) {
      if (await this.waitForBrowser(feature)) return;
      throw this.executorUnavailableError(feature);
    }

    const launch = launchBrowser();
    this.launchInFlight = launch;
    try {
      await launch;
      this.lastLaunchAt = Date.now();
    } finally {
      if (this.launchInFlight === launch) this.launchInFlight = undefined;
    }
    if (await this.waitForBrowser(feature)) return;
    throw this.executorUnavailableError(feature);
  }

  private async waitForBrowser(feature: SupportFeature) {
    const deadline = Date.now() + this.browserConnectWaitMs;
    while (Date.now() < deadline) {
      if (this.hasBrowser(feature)) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    return this.hasBrowser(feature);
  }

  private executorUnavailableError(feature: SupportFeature) {
    return new Error(
      `Chrome is running, but Local Codex Support did not connect as a ${feature} executor. ` +
      'In the Chrome automation profile, reload the generated .data/support-extension and enable the designated preparation/automation executor plus the required support feature.',
    );
  }

  async ensureBackgroundBrowserOnce(feature: SupportFeature) {
    if (this.automationPausedUntil()) return;
    if (this.hasBrowser(feature)) {
      this.backgroundLaunchPending.delete(feature);
      return;
    }
    if (!this.launchBrowser || this.backgroundLaunchPending.has(feature)) return;
    this.backgroundLaunchPending.add(feature);
    try {
      if (this.launchInFlight) {
        await this.launchInFlight;
        return;
      }
      const launch = this.launchBrowser();
      this.launchInFlight = launch;
      try {
        await launch;
        this.lastLaunchAt = Date.now();
      } finally {
        if (this.launchInFlight === launch) this.launchInFlight = undefined;
      }
    } catch (error) {
      this.backgroundLaunchPending.delete(feature);
      throw error;
    }
  }

  browserHasFeature(browserId: string, feature: SupportFeature) {
    const browser = this.browsers.get(browserId);
    return Boolean(browser && Date.now() - browser.lastSeenAt <= SUPPORT_BROWSER_HEARTBEAT_GRACE_MS && browser.features.has(feature));
  }

  claim(browserId: string, features: SupportFeature[], waitMs = CLAIM_WAIT_MS, signal?: AbortSignal, openThreads: string[] = []) {
    for (const pending of [...this.queued]) {
      const command = pending.command;
      const target = "conversationUrl" in command ? command.conversationUrl : command.targetUrl;
      if (command.feature === "ralph" && this.jobs?.blocksContinuationNow(parseConversationUrl(target).threadId)) {
        this.removePending(command.id);
        pending.reject(new Error("RALPH command cancelled because this thread is paused for task."));
      }
    }
    const featureSet = new Set(features);
    for (const feature of featureSet) this.backgroundLaunchPending.delete(feature);
    this.browsers.set(browserId, {
      features: featureSet,
      lastSeenAt: Date.now(),
      openThreads: new Set(openThreads.map(url => parseConversationUrl(url).threadId)),
    });
    this.dispatchQueuedCommandsToWaiters();
    for (const pending of this.pending.values()) this.scheduleInspectionFallback(pending);
    const resumable = [...this.pending.values()].find((pending) =>
      (pending.command.kind === "inspect_thread" || pending.command.kind === "prepare_thread" || pending.command.kind === "close_thread") &&
      this.canClaim(pending.command) &&
      this.browserCanClaim(browserId, pending.command) &&
      (pending.claimedBy === browserId ||
        (pending.claimedAt !== undefined && Date.now() - pending.claimedAt >= this.inspectClaimLeaseMs)));
    if (resumable) {
      this.markClaimed(resumable, browserId);
      return Promise.resolve(resumable.command);
    }

    const queuedIndex = this.queued.findIndex((pending) =>
      this.browserCanClaim(browserId, pending.command) && this.canClaim(pending.command));
    if (queuedIndex >= 0) {
      const [pending] = this.queued.splice(queuedIndex, 1);
      this.markClaimed(pending, browserId);
      return Promise.resolve(pending.command);
    }

    if ((featureSet.size === 0 && openThreads.length === 0) || waitMs <= 0 || signal?.aborted) return Promise.resolve(undefined);

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

    if (!result.ok && /^CHATGPT_RATE_LIMITED(?:_RETRYABLE)?:/.test(result.error)) {
      if (!this.messageCooldownUntil()) this.cooldownUntil = Date.now() + this.messageCooldownMs;
      this.messagePacingActive = true;
      this.nextMessageClaimAt = Math.max(this.nextMessageClaimAt, this.cooldownUntil);
      console.warn(`[chatgpt-support] message_cooldown until=${new Date(this.cooldownUntil).toISOString()}`);
      const browser = this.browsers.get(result.browserId);
      if (browser) browser.lastSeenAt = Date.now();
      const retryableSend = result.kind === "send_message" && result.error.startsWith("CHATGPT_RATE_LIMITED_RETRYABLE:");
      if (!retryableSend) {
        this.removePending(result.commandId);
        pending.resolve(result);
        return;
      }
      pending.claimedBy = undefined;
      pending.claimedAt = undefined;
      clearTimeout(pending.timeout);
      pending.deadline = Date.now() + this.messageCooldownMs + pending.timeoutMs;
      pending.timeout = setTimeout(() => {
        this.removePending(pending.command.id);
        pending.reject(new Error(`ChatGPT support command timed out after rate-limit cooldown: ${pending.command.kind}`));
      }, this.messageCooldownMs + pending.timeoutMs);
      pending.timeout.unref();
      if (!this.queued.includes(pending)) this.queued.unshift(pending);
      return;
    }

    const browser = this.browsers.get(result.browserId);
    if (browser) browser.lastSeenAt = Date.now();
    this.removePending(result.commandId);
    if (this.messagePacingActive && ![...this.pending.values()].some((entry) => entry.command.kind === "send_message")) {
      this.messagePacingActive = false;
      this.nextMessageClaimAt = 0;
    }
    pending.resolve(result);
  }

  close() {
    for (const waiter of [...this.waiters]) this.resolveWaiter(waiter, undefined);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      if (pending.inspectionFallback) clearTimeout(pending.inspectionFallback);
      pending.reject(new Error("ChatGPT support service is shutting down."));
    }
    this.pending.clear();
    this.queued.length = 0;
    this.browsers.clear();
  }

  private browserCanClaim(browserId: string, command: SupportCommand) {
    const browser = this.browsers.get(browserId);
    if (!browser) return false;
    if (command.kind === "inspect_thread") {
      if (command.executorOnly) return browser.features.has(command.feature);
      const threadId = parseConversationUrl(command.conversationUrl).threadId;
      const owners = [...this.browsers.entries()].filter(([, candidate]) =>
        Date.now() - candidate.lastSeenAt <= SUPPORT_BROWSER_HEARTBEAT_GRACE_MS && candidate.openThreads.has(threadId));
      const owner = owners.find(([, candidate]) => candidate.features.size === 0) ?? owners[0];
      if (owner) return owner[0] === browserId;
    }
    return browser.features.has(command.feature);
  }

  hasOpenThreadOwner(threadId: string) {
    return [...this.browsers.values()].some((browser) =>
      Date.now() - browser.lastSeenAt <= SUPPORT_BROWSER_HEARTBEAT_GRACE_MS && browser.openThreads.has(threadId));
  }

  private dispatchQueuedCommandsToWaiters() {
    for (let index = 0; index < this.queued.length;) {
      const pending = this.queued[index];
      if (!this.canClaim(pending.command)) {
        index += 1;
        continue;
      }
      const waiter = [...this.waiters].find((candidate) => this.browserCanClaim(candidate.browserId, pending.command));
      if (!waiter) {
        index += 1;
        continue;
      }
      this.queued.splice(index, 1);
      this.markClaimed(pending, waiter.browserId);
      this.resolveWaiter(waiter, pending.command);
    }
  }

  private scheduleInspectionFallback(pending: PendingCommand) {
    if (pending.inspectionFallback) {
      clearTimeout(pending.inspectionFallback);
      pending.inspectionFallback = undefined;
    }
    if (this.automationPausedUntil()) return;
    if (!this.launchBrowser || pending.command.kind !== "inspect_thread" || !pending.allowBrowserLaunch) return;
    if (pending.command.executorOnly) {
      if (pending.claimedBy) return;
      this.dispatchQueuedCommandsToWaiters();
      if (!pending.claimedBy) void this.ensureBrowser(pending.command.feature, this.launchBrowser).catch(() => undefined);
      return;
    }

    const threadId = parseConversationUrl(pending.command.conversationUrl).threadId;
    const claimant = pending.claimedBy ? this.browsers.get(pending.claimedBy) : undefined;
    const observerClaim = Boolean(pending.claimedBy && !claimant?.features.has(pending.command.feature));
    if (pending.claimedBy && !observerClaim) return;

    const owners = [...this.browsers.entries()].filter(([, browser]) =>
      Date.now() - browser.lastSeenAt <= SUPPORT_BROWSER_HEARTBEAT_GRACE_MS && browser.openThreads.has(threadId));
    const claimantStillOwnsThread = Boolean(pending.claimedBy && owners.some(([browserId]) => browserId === pending.claimedBy));
    if (observerClaim && !claimantStillOwnsThread) {
      pending.claimedBy = undefined;
      pending.claimedAt = undefined;
      if (!this.queued.includes(pending)) this.queued.unshift(pending);
      this.dispatchQueuedCommandsToWaiters();
      if (pending.claimedBy) return;
    }
    if (owners.length === 0) {
      this.dispatchQueuedCommandsToWaiters();
      if (!pending.claimedBy) void this.ensureBrowser(pending.command.feature, this.launchBrowser).catch(() => undefined);
      return;
    }

    const nextExpiry = Math.max(...owners.map(([, browser]) => browser.lastSeenAt + SUPPORT_BROWSER_HEARTBEAT_GRACE_MS));
    pending.inspectionFallback = setTimeout(() => {
      pending.inspectionFallback = undefined;
      if (this.pending.has(pending.command.id)) this.scheduleInspectionFallback(pending);
    }, Math.max(1, nextExpiry - Date.now() + 1));
    pending.inspectionFallback.unref();
  }

  private canClaim(command: SupportCommand) {
    if (command.feature === "voice") return true;
    const target = "conversationUrl" in command ? command.conversationUrl : command.targetUrl;
    if (this.registry?.isVoiceConversation(target)) return false;
    if (this.automationPausedUntil()) return false;
    if (command.kind !== "send_message") return true;
    if (this.messageCooldownUntil()) return false;
    return !this.messagePacingActive || Date.now() >= this.nextMessageClaimAt;
  }

  private markClaimed(pending: PendingCommand, browserId: string) {
    pending.claimedBy = browserId;
    pending.claimedAt = Date.now();
    if (pending.command.kind === "send_message" && this.messagePacingActive) {
      this.nextMessageClaimAt = Date.now() + this.messageSendSpacingMs;
    }
    this.scheduleInspectionFallback(pending);
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
    if (pending.inspectionFallback) clearTimeout(pending.inspectionFallback);
    this.pending.delete(commandId);
    const queuedIndex = this.queued.indexOf(pending);
    if (queuedIndex >= 0) this.queued.splice(queuedIndex, 1);
  }
}

const ralphThreadSchema = z.object({
  conversationUrl: z.string().url(),
  threadId: z.string(),
  title: z.string().optional(),
  parentThreadId: z.union([z.uuid(), z.string().regex(/^api:[a-zA-Z0-9_-]{1,100}$/)]).optional(),
  manuallyRegistered: z.boolean().optional(),
  agentCreated: z.boolean().optional(),
  registeredAt: z.string(),
  nextCheckAt: z.number(),
  state: z.enum(["active", "complete"]),
  activity: z.enum(["running", "idle", "blocked"]).optional(),
  activityAt: z.string().optional(),
  attentionAt: z.string().optional(),
  settledAt: z.string().optional(),
  observedOnly: z.boolean().optional(),
  completionCheckEnabled: z.boolean().optional(),
  checkRevision: z.uuid().optional(),
  externalRevision: z.string().optional(),
  lastCheckedAt: z.string().optional(),
  lastContinuationAt: z.string().optional(),
  lastError: z.string().optional(),
  checkpointFingerprint: z.string().optional(),
  checkpointWakeAt: z.number().optional(),
  resumedFingerprint: z.string().optional(),
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
  loopIntervalMs: z.number().int().positive().max(MAX_RALPH_INTERVAL_SECONDS * 1000).default(DEFAULT_RALPH_CHECK_INTERVAL_MS),
  subagentProjectUrl: z.string().url().optional(),
  automationPausedUntil: z.number().int().nonnegative().optional(),
  voiceConversationUrl: z.string().url().optional(),
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
      loopIntervalMs: DEFAULT_RALPH_CHECK_INTERVAL_MS,
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
      if (thread.settledAt && thread.state === "active") {
        if (thread.activity === "running" || thread.activity === "blocked") thread.settledAt = undefined;
        else thread.state = "complete";
        migrated = true;
      }
      if (thread.state === "complete" && !thread.settledAt) {
        thread.settledAt = thread.lastCheckedAt ?? thread.registeredAt;
        migrated = true;
      }
      const title = normalizeThreadTitle(thread.title);
      if (title === thread.title) continue;
      migrated = true;
      if (title) thread.title = title;
      else delete thread.title;
    }
    if (intervalMs === undefined &&
        (state.loopIntervalMs === LEGACY_RALPH_DEFAULT_INTERVAL_MS ||
         state.loopIntervalMs === INTERIM_RALPH_DEFAULT_INTERVAL_MS ||
         state.loopIntervalMs === 3 * 60 * 1000)) {
      state.loopIntervalMs = DEFAULT_RALPH_CHECK_INTERVAL_MS;
      const nextCheckAt = Date.now() + DEFAULT_RALPH_CHECK_INTERVAL_MS;
      for (const thread of state.threads) {
        if (thread.state === "active") thread.nextCheckAt = nextCheckAt;
      }
      migrated = true;
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

  automationPausedUntil() {
    const until = this.state.automationPausedUntil ?? 0;
    return until > Date.now() ? until : 0;
  }

  async pauseAutomation(requestedUntil = Date.now() + 5 * 60_000) {
    return this.update(state => {
      const current = state.automationPausedUntil ?? 0;
      const until = current > Date.now() ? current : Math.min(requestedUntil, Date.now() + 5 * 60_000);
      state.automationPausedUntil = until;
      return until;
    });
  }

  async threads() {
    await this.queue;
    return this.state.threads.map((entry) => ({ ...entry }));
  }

  voiceConversationUrl() {
    return this.state.voiceConversationUrl;
  }

  isVoiceConversation(value: string) {
    const configured = this.state.voiceConversationUrl;
    if (!configured) return false;
    try { return parseConversationUrl(value).threadId === parseConversationUrl(configured).threadId; }
    catch { return false; }
  }

  private voiceConversationCandidate(value: string) {
    const conversation = parseConversationUrl(value);
    if (conversation.projectId || new URL(value).searchParams.get("temporary-chat") === "true") {
      throw new Error("Voice requires a regular saved ChatGPT conversation outside a project.");
    }
    if (this.state.threads.some(thread => thread.threadId === conversation.threadId && thread.parentThreadId)) {
      throw new Error("A delegated worker cannot be used as the Voice conversation.");
    }
    return conversation;
  }

  async validateVoiceConversation(value: string) {
    await this.queue;
    return this.voiceConversationCandidate(value);
  }

  async setVoiceConversation(value: string) {
    return this.update(state => {
      const conversation = this.voiceConversationCandidate(value);
      state.voiceConversationUrl = conversation.conversationUrl;
      state.threads = state.threads.filter(thread => thread.threadId !== conversation.threadId);
      return conversation.conversationUrl;
    });
  }

  async externalRevision(conversationUrl: string) {
    let threadId: string;
    try { threadId = parseConversationUrl(conversationUrl).threadId; }
    catch { return undefined; }
    await this.queue;
    return this.state.threads.find((thread) => thread.threadId === threadId)?.externalRevision;
  }

  async remove(threadId: string) {
    await this.update((state) => {
      state.threads = state.threads.filter(thread => thread.threadId !== threadId);
    });
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
        if (projectId !== undefined && allowed.has(projectId)) {
          if (thread.completionCheckEnabled !== undefined) {
            thread.completionCheckEnabled = undefined;
            thread.observedOnly = undefined;
            thread.checkRevision = randomUUID();
            thread.nextCheckAt = Date.now() + state.loopIntervalMs;
          }
          return true;
        }
        return thread.completionCheckEnabled !== undefined && (projectId === undefined || thread.completionCheckEnabled);
      });
      return [...projects];
    });
  }

  async register(
    conversationUrl: string,
    options: { externalUpdate?: boolean; manual?: boolean; checkForCompletion?: boolean; reactivate?: boolean; agentCreated?: boolean; title?: string; parentThreadId?: string; activity?: "running" | "idle" | "blocked" } = {},
  ): Promise<"ignored" | "registered" | "active" | "reactivated"> {
    const conversation = parseConversationUrl(conversationUrl);
    const title = normalizeThreadTitle(options.title);
    const explicitlyMarked = options.manual && !options.activity && options.checkForCompletion === undefined;
    return this.update((state) => {
      if (this.isVoiceConversation(conversation.conversationUrl)) return "ignored" as const;
      const projectAllowed = conversation.projectId && state.projects.includes(conversation.projectId);
      const existing = state.threads.find((entry) => entry.threadId === conversation.threadId);
      if (!options.manual && options.checkForCompletion === undefined && !options.agentCreated && !projectAllowed &&
          !existing?.manuallyRegistered && !existing?.agentCreated) return "ignored" as const;
      if (existing) {
        if (options.externalUpdate) existing.externalRevision = randomUUID();
        if (existing.conversationUrl !== conversation.conversationUrl) existing.conversationUrl = conversation.conversationUrl;
        if (title) existing.title = title;
        if (options.parentThreadId) existing.parentThreadId = options.parentThreadId;
        if (options.manual) existing.manuallyRegistered = true;
        if (options.agentCreated) existing.agentCreated = true;
        const settingManaged = !projectAllowed && !existing.agentCreated && !existing.parentThreadId &&
          (existing.observedOnly || existing.completionCheckEnabled !== undefined);
        if (settingManaged && options.checkForCompletion !== undefined) {
          if (options.checkForCompletion && existing.observedOnly) existing.nextCheckAt = Date.now() + state.loopIntervalMs;
          if (existing.completionCheckEnabled !== options.checkForCompletion) existing.checkRevision = randomUUID();
          existing.completionCheckEnabled = options.checkForCompletion;
          existing.observedOnly = options.checkForCompletion ? undefined : true;
        }
        if (explicitlyMarked || options.agentCreated || projectAllowed) {
          if (existing.observedOnly) {
            existing.checkRevision = randomUUID();
            existing.nextCheckAt = Date.now() + state.loopIntervalMs;
          }
          existing.observedOnly = undefined;
          existing.completionCheckEnabled = undefined;
        }
        if (options.activity === "running" && options.reactivate) {
          existing.checkRevision = randomUUID();
          existing.nextCheckAt = Date.now() + state.loopIntervalMs;
        }
        if (options.activity && options.activity !== existing.activity) {
          existing.checkRevision = randomUUID();
          const now = new Date().toISOString();
          if (options.activity !== "running") {
            existing.attentionAt = existing.activity ? now : existing.lastCheckedAt ?? existing.registeredAt;
          } else {
            existing.state = "active";
            existing.settledAt = undefined;
            existing.nextCheckAt = Date.now() + state.loopIntervalMs;
          }
          existing.activity = options.activity;
          existing.activityAt = now;
        }
        if (options.reactivate || explicitlyMarked) existing.settledAt = undefined;
        if ((explicitlyMarked || options.agentCreated || options.reactivate) && existing.state === "complete") {
          existing.state = "active";
          existing.lastError = undefined;
          existing.nextCheckAt = Date.now() + state.loopIntervalMs;
          return "reactivated" as const;
        }
        return "active" as const;
      }
      if (state.threads.length >= MAX_RALPH_THREADS) {
        state.threads = state.threads.filter((thread) => !thread.settledAt);
      }
      if (state.threads.length >= MAX_RALPH_THREADS) throw new Error("RALPH thread registration limit reached.");
      state.threads.push({
        conversationUrl: conversation.conversationUrl,
        threadId: conversation.threadId,
        checkRevision: randomUUID(),
        ...(title ? { title } : {}),
        ...(options.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
        ...(options.manual ? { manuallyRegistered: true } : {}),
        ...(options.agentCreated ? { agentCreated: true } : {}),
        ...(!options.agentCreated && !options.parentThreadId && !projectAllowed && options.checkForCompletion !== undefined
          ? { completionCheckEnabled: options.checkForCompletion, ...(options.checkForCompletion ? {} : { observedOnly: true }) }
          : options.activity && !options.agentCreated && !projectAllowed ? { observedOnly: true } : {}),
        ...(options.externalUpdate ? { externalRevision: randomUUID() } : {}),
        registeredAt: new Date().toISOString(),
        ...(options.activity ? { activity: options.activity, activityAt: new Date().toISOString(),
          ...(options.activity !== "running" ? { attentionAt: new Date().toISOString() } : {}) } : {}),
        nextCheckAt: Date.now() + state.loopIntervalMs,
        state: "active",
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

  async settle(threadId: string) {
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread || thread.activity === "running" || thread.activity === "blocked") return false;
      if (!thread.observedOnly && thread.state === "active") return false;
      thread.state = "complete";
      thread.settledAt = new Date().toISOString();
      return true;
    });
  }

  async due(now = Date.now()) {
    await this.queue;
    return this.state.threads
      .filter((entry) => entry.state === "active" && !entry.settledAt && !entry.observedOnly && !entry.parentThreadId && entry.nextCheckAt <= now)
      .map((entry) => ({ ...entry }));
  }

  async isActive(threadId: string) {
    await this.queue;
    return this.state.threads.some(thread => thread.threadId === threadId && thread.state === "active" && !thread.settledAt);
  }

  async isCheckCurrent(threadId: string, expected?: { checkRevision?: string }) {
    await this.queue;
    return this.state.threads.some(thread => thread.threadId === threadId && thread.state === "active" &&
      !thread.settledAt && !thread.observedOnly && (expected === undefined || thread.checkRevision === expected.checkRevision));
  }

  async scheduleNow(threadId: string): Promise<"scheduled" | "complete" | "missing"> {
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread) return "missing";
      if (thread.state === "complete") return "complete";
      thread.observedOnly = undefined;
      thread.settledAt = undefined;
      thread.nextCheckAt = Date.now();
      return "scheduled";
    });
  }

  async recordRunning(threadId: string) {
    await this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId && entry.state === "active");
      if (!thread) return;
      thread.lastCheckedAt = new Date().toISOString();
      if (thread.activity !== "running") thread.activityAt = thread.lastCheckedAt;
      thread.activity = "running";
      thread.settledAt = undefined;
      thread.lastError = undefined;
      thread.nextCheckAt = Date.now() + state.loopIntervalMs;
    });
  }

  async recordLoading(threadId: string) {
    await this.reschedule(threadId);
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

  async recordComplete(threadId: string) {
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread) return false;
      thread.state = "complete";
      thread.lastCheckedAt = new Date().toISOString();
      thread.attentionAt = thread.lastCheckedAt;
      thread.activity = "idle";
      thread.settledAt = thread.lastCheckedAt;
      thread.lastError = undefined;
      return true;
    });
  }

  async recordActive(threadId: string) {
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId);
      if (!thread) return false;
      thread.state = "active";
      thread.settledAt = undefined;
      thread.observedOnly = undefined;
      thread.completionCheckEnabled = undefined;
      thread.checkRevision = randomUUID();
      thread.lastError = undefined;
      thread.nextCheckAt = Date.now() + state.loopIntervalMs;
      return true;
    });
  }

  async checkpointReady(threadId: string, fingerprint: string, delayMs: number) {
    return this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId && entry.state === "active");
      if (!thread || thread.resumedFingerprint === fingerprint) return false;
      if (thread.checkpointFingerprint !== fingerprint) {
        thread.checkpointFingerprint = fingerprint;
        thread.checkpointWakeAt = Date.now() + delayMs;
      }
      const wakeAt = thread.checkpointWakeAt ?? 0;
      if (wakeAt > Date.now()) {
        thread.nextCheckAt = wakeAt;
        return false;
      }
      return true;
    });
  }

  async recordContinuation(threadId: string, fingerprint?: string) {
    await this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId && entry.state === "active");
      if (!thread) return;
      const now = new Date().toISOString();
      thread.lastCheckedAt = now;
      thread.lastContinuationAt = now;
      thread.activity = "running";
      thread.activityAt = now;
      thread.settledAt = undefined;
      if (fingerprint) thread.resumedFingerprint = fingerprint;
      thread.lastError = undefined;
      thread.nextCheckAt = Date.now() + state.loopIntervalMs;
    });
  }

  private async reschedule(threadId: string, delayMs?: number) {
    await this.update((state) => {
      const thread = state.threads.find((entry) => entry.threadId === threadId && entry.state === "active");
      if (!thread) return;
      thread.lastCheckedAt = new Date().toISOString();
      thread.lastError = undefined;
      thread.nextCheckAt = Date.now() + (delayMs ?? state.loopIntervalMs);
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
    conversationUrl: (projectId
      ? `https://chatgpt.com/g/${projectId}/c/${threadId}`
      : `https://chatgpt.com/c/${threadId}`) + (url.searchParams.get("temporary-chat") === "true" ? "?temporary-chat=true" : ""),
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
    if (this.options.commands.automationPausedUntil()) return;
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
      if (this.options.commands.automationPausedUntil()) return;
      if (this.options.commands.messageCooldownUntil() || await this.options.jobs?.blocksContinuation(thread.threadId)) {
        await this.options.registry.recordRunning(thread.threadId);
        return;
      }
      const commandResult = await this.options.commands.execute({
        feature: "ralph",
        kind: "inspect_thread",
        conversationUrl: thread.conversationUrl,
      }, RALPH_BROWSER_INSPECTION_TIMEOUT_MS);
      if (!commandResult.ok) throw new Error(commandResult.error);
      if (commandResult.kind !== "inspect_thread") throw new Error("RALPH received the wrong support command result.");
      if (!await this.options.registry.isCheckCurrent(thread.threadId, thread)) return;

      const observedInspection = commandResult.result;
      const observedByExecutor = this.options.commands.browserHasFeature(commandResult.browserId, "ralph");
      if (observedInspection.title) await this.options.registry.recordTitle(thread.threadId, observedInspection.title);
      if (observedInspection.status === "loading") {
        await this.options.registry.recordLoading(thread.threadId);
        return;
      }
      if (observedInspection.status === "running") {
        await this.options.registry.recordRunning(thread.threadId);
        return;
      }

      if (!await this.options.registry.isCheckCurrent(thread.threadId, thread)) return;
      if (await this.options.jobs?.blocksContinuation(thread.threadId)) {
        await this.options.registry.recordRunning(thread.threadId);
        return;
      }
      const inspection = observedByExecutor
        ? observedInspection
        : await this.inspectExecutorBeforeContinuation(thread);
      if (!inspection) return;
      if (!await this.options.registry.isCheckCurrent(thread.threadId, thread)) return;

      const checkpoint = inspection.assistant.text.trim().match(/(?:^|\n)RALPH_STATUS: (CONTINUE|WAIT_CI|BLOCKED|COMPLETE)$/)?.[1];
      if (checkpoint === "COMPLETE" || checkpoint === "BLOCKED") {
        await this.options.registry.recordComplete(thread.threadId);
        return;
      }
      if (checkpoint === "CONTINUE" || checkpoint === "WAIT_CI") {
        const fingerprint = createHash("sha256").update(JSON.stringify([
          inspection.users.at(-1), inspection.assistant,
        ])).digest("base64url");
        if (!await this.options.registry.checkpointReady(thread.threadId, fingerprint,
          checkpoint === "WAIT_CI" ? 5 * 60_000 : 0)) return;
        if (await this.options.jobs?.blocksContinuation(thread.threadId)) return;
        const resumed = await this.options.commands.execute({
          feature: "ralph", kind: "send_message", targetUrl: thread.conversationUrl,
          message: checkpoint === "WAIT_CI"
            ? "Resume the saved engineering checkpoint. Inspect CI once for the saved PR head, fix actionable failures, and continue the task and verification loop. If checks are still pending, save the checkpoint and end with RALPH_STATUS: WAIT_CI."
            : "Resume the saved checkpoint and continue the existing task. Preserve the sequential implementer and worker handoff. Do not start duplicate tasks or repeat completed work.",
        });
        if (!resumed.ok) throw new Error(resumed.error);
        if (resumed.kind !== "send_message") throw new Error("Unexpected checkpoint continuation result.");
        await this.options.registry.recordContinuation(thread.threadId, fingerprint);
        return;
      }
      if (!inspection.assistant.synthetic) {
        if (inspection.workedSeconds === null) {
          await this.options.registry.recordComplete(thread.threadId);
          return;
        }
        if (inspection.users.length === 0 || inspection.users.some((message) => !message.text.trim())) {
          throw new Error("RALPH could not extract every ChatGPT user message.");
        }
        if (!inspection.assistant.text.trim()) {
          throw new Error("RALPH could not extract the final ChatGPT assistant message.");
        }
        const decision = await decideRalphContinuation(
          inspection,
          this.options.apiKey,
          this.options.model,
          thread.conversationUrl,
          this.auditLog,
        );
        if (!await this.options.registry.isCheckCurrent(thread.threadId, thread)) return;
        if (decision.complete) {
          await this.options.registry.recordComplete(thread.threadId);
          return;
        }
      }
      if (!await this.options.registry.isCheckCurrent(thread.threadId, thread)) return;
      if (await this.options.jobs?.blocksContinuation(thread.threadId)) {
        await this.options.registry.recordRunning(thread.threadId);
        return;
      }
      if (!await this.options.registry.isCheckCurrent(thread.threadId, thread)) return;

      const sendResult = await this.options.commands.execute({
        feature: "ralph",
        kind: "send_message",
        targetUrl: thread.conversationUrl,
        message: "Continue the existing task from its current state. Do not repeat completed work.",
      });
      if (!sendResult.ok) throw new Error(sendResult.error);
      if (sendResult.kind !== "send_message") throw new Error("RALPH received the wrong send-message result.");
      if (await this.options.registry.isCheckCurrent(thread.threadId, thread)) {
        await this.options.registry.recordContinuation(thread.threadId);
      }
    } catch (error) {
      if (!await this.options.registry.isCheckCurrent(thread.threadId, thread)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out/i.test(message)) {
        await this.options.registry.recordLoading(thread.threadId);
        return;
      }
      console.error(`[ralph] thread=${JSON.stringify(thread.conversationUrl)} failed: ${message}`);
      await this.options.registry.recordFailure(thread.threadId, message);
    }
  }

  private async inspectExecutorBeforeContinuation(thread: z.infer<typeof ralphThreadSchema>) {
    const result = await this.options.commands.execute({
      feature: "ralph",
      kind: "inspect_thread",
      conversationUrl: thread.conversationUrl,
      executorOnly: true,
    }, RALPH_BROWSER_INSPECTION_TIMEOUT_MS);
    if (!result.ok) throw new Error(result.error);
    if (result.kind !== "inspect_thread") throw new Error("RALPH received the wrong pre-send inspection result.");
    if (!await this.options.registry.isCheckCurrent(thread.threadId, thread)) return undefined;
    if (result.result.title) await this.options.registry.recordTitle(thread.threadId, result.result.title);
    if (result.result.status === "loading") {
      await this.options.registry.recordLoading(thread.threadId);
      return undefined;
    }
    if (result.result.status === "running") {
      await this.options.registry.recordRunning(thread.threadId);
      return undefined;
    }
    return result.result;
  }
}

export class ThreadTabCleanupController {
  private readonly inFlight = new Set<string>();
  private readonly closed = new Set<string>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: {
    commands: SupportCommandBus;
    registry: RalphRegistry;
    retentionMs?: number;
    checkEveryMs?: number;
  }) {
    this.timer = setInterval(() => void this.tick(), options.checkEveryMs ?? THREAD_TAB_CLEANUP_TICK_MS);
    this.timer.unref();
  }

  async tick(now = Date.now()) {
    if (this.options.commands.automationPausedUntil()) return;
    const retentionMs = this.options.retentionMs ?? COMPLETED_THREAD_TAB_RETENTION_MS;
    const threads = await this.options.registry.threads();
    for (const thread of threads) {
      if (thread.state === "active" || !thread.parentThreadId) {
        this.closed.delete(thread.threadId);
        continue;
      }
      if (this.closed.has(thread.threadId) || this.inFlight.has(thread.threadId) || !thread.lastCheckedAt) continue;
      const completedAt = Date.parse(thread.lastCheckedAt);
      if (!Number.isFinite(completedAt) || completedAt + retentionMs > now) continue;

      this.inFlight.add(thread.threadId);
      void this.closeThread(thread.threadId, thread.conversationUrl, thread.lastCheckedAt)
        .finally(() => this.inFlight.delete(thread.threadId));
    }
  }

  close() {
    clearInterval(this.timer);
  }

  private async closeThread(threadId: string, conversationUrl: string, expectedCompletedAt: string) {
    try {
      // Never launch Chrome just to close a tab. If the automation browser is gone, its tabs are gone too.
      if (!this.options.commands.hasBrowser("threadLifecycle")) return;
      const current = (await this.options.registry.threads()).find((thread) => thread.threadId === threadId);
      if (!current || current.state !== "complete" || current.lastCheckedAt !== expectedCompletedAt) return;
      const result = await this.options.commands.execute({
        feature: "threadLifecycle",
        kind: "close_thread",
        conversationUrl,
      }, 60_000);
      if (!result.ok) throw new Error(result.error);
      if (result.kind !== "close_thread") throw new Error("Thread cleanup received the wrong support command result.");
      this.closed.add(threadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[chatgpt-support] thread_tab_cleanup_failed thread=${JSON.stringify(conversationUrl)}: ${message}`);
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
    "If work remains, reply with exactly CONTINUE. Do not write a continuation prompt. The working agent decides what to do next.",
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
    if (!/^(?:COMPLETE|CONTINUE)\.?$/i.test(text)) throw new Error("OpenAI RALPH decision must be COMPLETE or CONTINUE.");
    const decision = { complete: /^COMPLETE\.?$/i.test(text) };
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

export function authenticateSupportExtension(req: Request, res: Response, extensionToken: string) {
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
    features: z.array(supportFeatureSchema).max(5),
    conversationUnavailable: z.boolean().optional(),
    automationPausedUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    statusOnly: z.boolean().optional(),
    recoveryConversationUrl: z.string().max(2048).refine(value => {
      try { parseConversationUrl(value); return true; } catch { return false; }
    }).optional(),
    recoveryReservation: z.discriminatedUnion("action", [
      z.object({ action: z.literal("acquire"), commandId: z.string().uuid().optional() }).strict(),
      z.object({ action: z.literal("release"), id: z.string().uuid() }).strict(),
    ]).optional(),
    openThreads: z.array(z.string().max(2048).refine(value => {
      try { parseConversationUrl(value); return true; } catch { return false; }
    })).max(2000).optional(),
  }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid support command claim." });
      return;
    }
    if (parsed.data.recoveryReservation && (!parsed.data.statusOnly || !parsed.data.recoveryConversationUrl)) {
      res.status(400).json({ error: "A recovery reservation requires a status-only conversation request." });
      return;
    }
    const abortController = new AbortController();
    const onDisconnect = () => abortController.abort();
    req.once("aborted", onDisconnect);
    res.once("close", onDisconnect);
    try {
      if (parsed.data.conversationUnavailable) await commands.pauseAutomation(parsed.data.automationPausedUntil);
      if (parsed.data.statusOnly) {
        if (parsed.data.recoveryReservation) {
          const url = parsed.data.recoveryConversationUrl;
          if (!url) { res.status(400).json({ error: "Recovery requires a conversation URL." }); return; }
          const reservation = parsed.data.recoveryReservation;
          if (reservation.action === "release") {
            commands.releaseRecovery(parsed.data.browserId, url, reservation.id);
            res.status(204).end();
          } else {
            try { res.json(commands.reserveRecovery(parsed.data.browserId, url, reservation.commandId)); }
            catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
          }
          return;
        }
        res.setHeader("X-Automation-Paused-Until", String(commands.automationPausedUntil()));
        res.setHeader("X-Voice-Conversation-Url", commands.voiceConversationUrl() ?? "");
        if (parsed.data.recoveryConversationUrl) {
          res.setHeader("X-Recovery-Message-Pending", String(commands.hasPendingMessage(parsed.data.recoveryConversationUrl)));
        }
        res.status(204).end();
        return;
      }
      const command = await commands.claim(parsed.data.browserId, parsed.data.features, CLAIM_WAIT_MS, abortController.signal, parsed.data.openThreads);
      if (abortController.signal.aborted) return;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Automation-Paused-Until", String(commands.automationPausedUntil()));
      res.setHeader("X-Voice-Conversation-Url", commands.voiceConversationUrl() ?? "");
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
  commands?: SupportCommandBus,
): RequestHandler {
  const bodySchema = z.object({
    conversationUrl: z.string().max(2048),
    manual: z.boolean().optional(),
    checkForCompletion: z.boolean().optional(),
    reactivate: z.boolean().optional(),
    externalUpdate: z.boolean().optional(),
    agentCreated: z.boolean().optional(),
    title: z.string().max(300).optional(),
    removed: z.boolean().optional(),
    settled: z.boolean().optional(),
    activity: z.enum(["running", "idle", "blocked"]).optional(),
  }).strict();
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid RALPH registration request." });
      return;
    }
    try {
      if (parsed.data.settled) {
        const { threadId } = parseConversationUrl(parsed.data.conversationUrl);
        const settled = await registry.settle(threadId);
        res.json({ status: settled ? "settled" : "working" });
        return;
      }
      if (parsed.data.removed) {
        const { threadId } = parseConversationUrl(parsed.data.conversationUrl);
        await registry.remove(threadId);
        commands?.cancelThreadChecks(threadId);
        res.json({ status: "removed" });
        return;
      }
      const registration = await registry.register(parsed.data.conversationUrl, {
        manual: parsed.data.manual === true,
        checkForCompletion: parsed.data.checkForCompletion,
        reactivate: parsed.data.reactivate === true,
        externalUpdate: parsed.data.externalUpdate === true,
        agentCreated: parsed.data.agentCreated === true,
        title: parsed.data.title,
        activity: parsed.data.activity,
      });
      const { threadId } = parseConversationUrl(parsed.data.conversationUrl);
      if (parsed.data.activity === "running" ||
          (parsed.data.checkForCompletion === false && !await registry.isCheckCurrent(threadId))) {
        commands?.cancelThreadChecks(threadId, true);
      }
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

export function ralphThreadsGetHandler(registry: RalphRegistry, extensionToken: string, jobs?: SubagentJobRegistry, continuationEnabled = true): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    res.setHeader("Cache-Control", "no-store");
    const threads = await registry.threads();
    const tasks = await jobs?.all() ?? [];
    res.json({ threads: threads.map((thread) => ({
      ...thread,
      waitingForTask: tasks.some((job) => job.parentThreadId === thread.threadId &&
        job.state === "pending"),
    })), tasks, continuationEnabled, automationPausedUntil: registry.automationPausedUntil() });
  };
}

export function taskActionHandler(
  jobs: SubagentJobRegistry, registry: RalphRegistry, commands: SupportCommandBus,
  launchBrowser: () => Promise<void>, extensionToken: string,
): RequestHandler {
  return async (req, res) => {
    if (!authenticateSupportExtension(req, res, extensionToken)) return;
    const input = z.object({ action: z.literal("cancel"), confirmedStopped: z.boolean().optional() }).strict().safeParse(req.body);
    const id = z.string().uuid().safeParse(req.params.jobId);
    if (!input.success || !id.success) { res.status(400).json({ error: "Invalid task action." }); return; }
    try {
      const job = await jobs.job(id.data);
      if (!job) { res.status(404).json({ error: "Task not found." }); return; }
      if (job.state === "pending") {
        if (job.childConversationUrl) {
          await commands.ensureBrowser("threadMessaging", launchBrowser);
          const stopped = await commands.execute({ feature: "threadMessaging", kind: "stop_thread", targetUrl: job.childConversationUrl });
          if (!stopped.ok) throw new Error(stopped.error);
          if (stopped.kind !== "stop_thread") throw new Error("Unexpected worker stop result.");
        } else if (!job.preparationError || input.data.confirmedStopped !== true) {
          throw new Error("Startup is unresolved. Inspect the automation browser and confirm any untracked worker has stopped before cancelling.");
        }
        if (job.childThreadId) await registry.recordComplete(job.childThreadId);
        await jobs.cancel(job.jobId);
      } else {
        throw new Error("Only pending tasks can be cancelled.");
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: "accepted" });
    } catch (error) { res.status(409).json({ error: String(error) }); }
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

  markPrepared(conversationUrl: string) {
    this.prepared.add(parseConversationUrl(conversationUrl).threadId);
  }

  markBound(threadId: string) {
    this.boundWaiters.get(threadId)?.();
  }

  async schedule(conversationUrl: string, observerCanPrepare = false): Promise<"preparing" | "prepared"> {
    const conversation = parseConversationUrl(conversationUrl);
    if (this.prepared.has(conversation.threadId)) return "prepared";
    if (this.inFlight.has(conversation.threadId)) return "preparing";

    this.start(conversation.conversationUrl, conversation.threadId, observerCanPrepare);
    return "preparing";
  }

  async ensurePrepared(conversationUrl: string, observerCanPrepare = false): Promise<"prepared"> {
    const conversation = parseConversationUrl(conversationUrl);
    if (this.prepared.has(conversation.threadId)) return "prepared";

    const task = this.inFlight.get(conversation.threadId)
      ?? this.start(conversation.conversationUrl, conversation.threadId, observerCanPrepare);
    await task.ready;
    if (this.prepared.has(conversation.threadId)) return "prepared";
    throw new Error("Thread preparation finished without opening the thread in the automation browser.");
  }

  private start(conversationUrl: string, threadId: string, observerCanPrepare: boolean) {
    let slotHeld = false;
    const ready = (async () => {
      await this.acquireSlot();
      slotHeld = true;
      if (!observerCanPrepare) await this.commands.ensureBrowser("threadPreparation", this.launchBrowser);

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
  registry: RalphRegistry,
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
      if (parsed.data.canPrepare === false) {
        res.setHeader("Cache-Control", "no-store");
        res.json({ status: "observed" });
        return;
      }
      const conversation = parseConversationUrl(parsed.data.conversationUrl);
      const managed = (await registry.threads()).some((thread) =>
        thread.threadId === conversation.threadId && thread.state === "active" && !thread.observedOnly && !thread.settledAt);
      if (!managed) {
        res.setHeader("Cache-Control", "no-store");
        res.json({ status: "ignored" });
        return;
      }
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

function agentPrompt(message: string, jobId: string, resultPath: string) {
  return [
    message.trim(),
    "",
    "ROLE: ChatGPT worker. The specification above is your complete assignment. The parent handles planning and implementation.",
    "Execute this bounded assignment yourself. Use terminal for specified commands and this server's browser_* tools for browser work. Change files only when the specification authorizes it. Submit a blocker if the specification or access is insufficient. Do not delegate again. The service resumes interrupted work every 30 minutes until you publish the report.",
    `For browser work, save important evidence with browser_screenshot and jobId ${JSON.stringify(jobId)}. When recording is requested, start browser_recording before interacting, stop it before releasing the tab, and include the video path.`,
    "Inspect a fresh browser_snapshot before interacting and verify the observed result after each meaningful action. Never report an unperformed check as passed.",
    "Write the report with the tested workspace and revision, each check's expected and observed result, pass or fail, reproduction steps, evidence paths, and any blocker. An unsuccessful test or missing login is a reportable result.",
    `When finished, write your complete report to ${JSON.stringify(resultPath + ".tmp")} with terminal, then rename that file to ${JSON.stringify(resultPath)}. The rename marks the assignment done and releases the waiting parent request.`,
    "Publish a report even if checks fail or access is blocked. Include observed progress and the exact blocker. After the rename succeeds, end the turn. No thread binding or completion tool is required.",
  ].join("\n");
}


type SubagentJob = NonNullable<Awaited<ReturnType<SubagentJobRegistry["job"]>>>;
type AgentServices = {
  commands: SupportCommandBus;
  registry: RalphRegistry;
  jobs: SubagentJobRegistry;
  launchBrowser: () => Promise<void>;
};

export async function startSubagentJob(job: SubagentJob, message: string,
  { commands, registry, jobs, preparer, launchBrowser }: AgentServices & { preparer: ThreadPreparationCoordinator }) {
  let deliveryUncertain = false;
  try {
    await commands.ensureBrowser("threadMessaging", launchBrowser);
    deliveryUncertain = true;
    const result = await commands.execute({
      feature: "threadMessaging", kind: "send_message", targetUrl: "https://chatgpt.com/", temporary: true,
      message: agentPrompt(message, job.jobId, job.resultPath),
      connectorName: process.env.CHATGPT_WORKER_CONNECTOR_NAME ?? "Codex",
    });
    if (!result.ok) {
      deliveryUncertain = result.deliveryUncertain ?? true;
      throw new Error(result.error);
    }
    if (result.kind !== "send_message") throw new Error("Sub-agent creation received the wrong support command result.");
    const child = parseConversationUrl(result.result.conversationUrl);
    await jobs.assignChild(job.jobId, { ...child, title: result.result.title });
    await registry.register(child.conversationUrl, { agentCreated: true, parentThreadId: job.parentThreadId, title: result.result.title });
    preparer.markPrepared(child.conversationUrl);
  } catch (error) {
    await jobs.recordPreparationFailure(job.jobId, error instanceof Error ? error.message : String(error), deliveryUncertain);
    throw error;
  }
}

export function registerChatGptAgents(
  server: McpServer,
  commands: SupportCommandBus,
  bindings: ThreadBindingLookup,
  jobs: SubagentJobRegistry,
  preparer: ThreadPreparationCoordinator,
  launchBrowser: () => Promise<void>,
  ownerId: string,
) {
  server.registerTool("start_thread", {
    title: "Start thread",
    description: "Create a new ChatGPT conversation only when the user explicitly requests a new thread. This creates no task job or parent callback. Do not use it for automatic delegation. Transport retries of the same request are deduplicated. Inspect uncertain delivery before making a new request.",
    inputSchema: {
      message: z.string().trim().min(1).max(190_000),
      projectUrl: z.string().url().optional().describe("Optional ChatGPT project URL ending in /project."),
    },
    outputSchema: { conversationUrl: z.string().url() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ message, projectUrl }, extra) => {
    const session = extra.mcpReq._meta?.["openai/session"];
    const current = typeof session === "string" ? await bindings.binding({ ownerId, sessionId: session }) : undefined;
    if (current && await jobs.isWorker(current.threadId)) {
      return { isError: true, content: [{ type: "text", text: "Workers must execute their assignment and publish the report at its supplied path." }] };
    }
    try {
      const targetUrl = projectUrl ? normalizeSubagentProjectUrl(projectUrl) : "https://chatgpt.com/";
      const fingerprint = createHash("sha256").update(targetUrl).update("\0").update(message).digest("base64url");
      return await replayToolRequest(`start_thread:${ownerId}:${String(session)}:${String(extra.mcpReq.id)}:${fingerprint}`, async () => {
        await commands.ensureBrowser("threadMessaging", launchBrowser);
        const result = await commands.execute({ feature: "threadMessaging", kind: "send_message", targetUrl, message });
        if (!result.ok) throw new Error(result.error);
        if (result.kind !== "send_message") throw new Error("Unexpected thread creation result.");
        const { conversationUrl } = parseConversationUrl(result.result.conversationUrl);
        preparer.markPrepared(conversationUrl);
        return { content: [{ type: "text", text: conversationUrl }], structuredContent: { conversationUrl } };
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error) }] };
    }
  });

  server.registerTool("send_thread_message", {
    title: "Send Thread Message",
    description: "Send one message to an existing ChatGPT conversation only when the user explicitly requests that post. Transport retries of the same MCP request are deduplicated internally. This tool never creates a new thread. A rate limit known to occur before Send is clicked stays queued and may resume after cooldown with global send pacing. If a provider notice appears after Send is clicked, delivery is uncertain and the command is never replayed automatically; inspect the target before making a new send request.",
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
    const session = typeof extra.mcpReq._meta?.["openai/session"] === "string"
      ? extra.mcpReq._meta["openai/session"]
      : "";
    const replayKey = `send_thread_message:${ownerId}:${session}:${String(extra.mcpReq.id)}:${fingerprint}`;
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

}

export class SubagentResultController {
  private readonly inFlight = new Set<string>();
  private readonly completedThreads = new Set<string>();
  private readonly inspectionAfter = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly jobs: SubagentJobRegistry,
    private readonly commands: SupportCommandBus,
    private readonly launchBrowser: () => Promise<void>,
    private readonly registry: RalphRegistry,
    checkEveryMs = 5_000,
  ) {
    this.timer = setInterval(() => void this.tick().catch((error: unknown) => console.error("[tasks] Report check failed:", error)), checkEveryMs);
    this.timer.unref();
  }

  async tick() {
    const now = Date.now();
    const intervalMs = (await this.registry.settings()).loopIntervalSeconds * 1000;
    for (const job of await this.jobs.all()) {
      if (job.state !== "pending") {
        if (job.childThreadId && !this.completedThreads.has(job.childThreadId)) {
          await this.registry.recordComplete(job.childThreadId);
          this.completedThreads.add(job.childThreadId);
        }
        continue;
      }
      await this.jobs.collectReport(job.jobId).catch((error: unknown) => console.error("[tasks] Report read failed:", error));
      if ((await this.jobs.job(job.jobId))?.state !== "pending") continue;
      if (job.preparationError || !job.childConversationUrl || this.commands.automationPausedUntil() || this.commands.messageCooldownUntil()) continue;
      if (this.inFlight.has(job.jobId) || (this.inspectionAfter.get(job.jobId) ?? Date.parse(job.createdAt) + intervalMs) > now) continue;
      this.inFlight.add(job.jobId);
      void this.inspectUnreportedWorker(job.jobId, job.childConversationUrl).catch((error: unknown) => {
        console.error(`[tasks] worker_inspection_failed job=${job.jobId} error=${String(error)}`);
      }).finally(() => {
        this.inspectionAfter.set(job.jobId, Date.now() + intervalMs);
        this.inFlight.delete(job.jobId);
      });
    }
  }

  close() {
    clearInterval(this.timer);
  }

  private async inspectUnreportedWorker(jobId: string, conversationUrl: string) {
    await this.commands.ensureBrowser("threadMessaging", this.launchBrowser);
    const inspection = await this.commands.execute({ feature: "threadMessaging", kind: "inspect_thread", conversationUrl });
    if (!inspection.ok) throw new Error(inspection.error);
    if (inspection.kind !== "inspect_thread") throw new Error("Unexpected worker inspection result.");
    if (inspection.result.status !== "idle") return;
    await this.jobs.collectReport(jobId);
    const current = await this.jobs.job(jobId);
    if (current?.state !== "pending") return;
    const resumed = await this.commands.execute({
      feature: "threadMessaging", kind: "send_message", targetUrl: conversationUrl,
      message: `Resume your existing assignment from its current state. Do not repeat completed checks. If work remains, continue it. If you are finished or blocked, publish your complete report, including observed failures and blockers. Write it to ${JSON.stringify(current.resultPath + ".tmp")}, then rename it to ${JSON.stringify(current.resultPath)}. The report file is the completion signal.`,
    });
    if (!resumed.ok) throw new Error(resumed.error);
    if (resumed.kind !== "send_message") throw new Error("Unexpected worker continuation result.");
    if (current.childThreadId) await this.registry.recordContinuation(current.childThreadId);
  }
}
