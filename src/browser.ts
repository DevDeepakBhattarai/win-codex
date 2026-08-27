import { randomBytes, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { getPlaywrightInstallExpression } from "./browser-playwright.js";
import { launchChrome } from "./browser-launch.js";

const BRIDGE_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const MAX_ACTION_TIMEOUT_MS = 30_000;
const MAX_INTERACTIVE_ELEMENTS = 160;
const MAX_AX_NODES = 250;
const MAX_VISIBLE_TEXT = 25_000;
const MAX_DIAGNOSTIC_ENTRIES = 40;
const MAX_ACTION_TIMELINE = 30;
const MAX_UPLOAD_FILES = 20;
const CLAIM_LISTING_TTL_MS = 60_000;
const CONTROL_OVERLAY_MOVE_DELAY_MS = 180;
const BROWSER_CONNECT_TIMEOUT_MS = 15_000;

export type BrowserTab = {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  pinned: boolean;
  highlighted: boolean;
  openerTabId?: number;
  groupId?: number;
  lastAccessed?: number;
  discarded?: boolean;
  autoDiscardable?: boolean;
  status?: string;
  title?: string;
  url?: string;
  ownership?: "user" | "agent" | "claimed";
  controlled?: boolean;
  mark?: "deliverable" | "handoff";
  parentTabId?: number;
};

export type BrowserInteractiveElement = {
  ref: string;
  locator: string;
  tag: string;
  role?: string;
  name?: string;
  type?: string;
  value?: string;
  disabled: boolean;
  checked?: boolean;
  selected?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserAxNode = {
  nodeId: string;
  parentId?: string;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  properties?: Record<string, string | number | boolean>;
};

export type BrowserDiagnosticEntry = {
  at: string;
  kind: string;
  text: string;
  url?: string;
  status?: number;
};

export type BrowserActionEvent = {
  at: string;
  action: string;
  detail?: string;
};

export type BrowserSnapshot = {
  tabId: number;
  snapshotId: string;
  epoch: number;
  url: string;
  title: string;
  loading: boolean;
  visibleText: string;
  interactiveElements: BrowserInteractiveElement[];
  accessibilityTree: BrowserAxNode[];
  consoleEntries: BrowserDiagnosticEntry[];
  networkEntries: BrowserDiagnosticEntry[];
  actionTimeline: BrowserActionEvent[];
  relatedTabs: BrowserTab[];
  screenshot?: {
    mimeType: "image/png";
    width?: number;
    height?: number;
    bytes: number;
  };
};

export type BrowserSnapshotResult = {
  snapshot: BrowserSnapshot;
  screenshotData?: string;
};

export type BrowserActionInput = {
  tabId?: number;
  action: "navigate" | "back" | "forward" | "reload" | "click" | "dblclick" | "type" | "press" | "scroll" | "wait" | "activate" | "close";
  url?: string;
  ref?: string;
  locator?: string;
  x?: number;
  y?: number;
  text?: string;
  clear?: boolean;
  key?: string;
  modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  deltaX?: number;
  deltaY?: number;
  waitForText?: string;
  waitForUrlIncludes?: string;
  timeoutMs?: number;
  bypassCache?: boolean;
  button?: "left" | "middle" | "right";
  force?: boolean;
};

export type BrowserOwnershipActionInput = {
  action: "claim" | "release" | "mark_deliverable" | "mark_handoff" | "cleanup";
  tabId?: number;
  title?: string;
  url?: string;
};

export type BrowserDownload = {
  id: number;
  tabId?: number;
  url?: string;
  finalUrl?: string;
  filename?: string;
  mime?: string;
  state?: "in_progress" | "interrupted" | "complete";
  paused?: boolean;
  canResume?: boolean;
  bytesReceived?: number;
  totalBytes?: number;
  fileSize?: number;
  error?: string;
  exists?: boolean;
  startTime?: string;
  endTime?: string;
};

export type BrowserDownloadInput = {
  action: "list" | "trigger" | "wait" | "cancel";
  tabId?: number;
  downloadId?: number;
  ref?: string;
  locator?: string;
  timeoutMs?: number;
  waitForCompletion?: boolean;
};

export type BrowserServiceStatus = {
  connected: boolean;
  bridgeUrl: string;
  extensionDirectory: string;
  extensionId?: string;
  extensionVersion?: string;
  userAgent?: string;
};

type BridgeHello = {
  type: "hello";
  protocolVersion: number;
  extensionId: string;
  extensionVersion: string;
  userAgent?: string;
};

type BridgeResponse = {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { message?: string };
};

type BridgeEvent = {
  type: "event";
  event: string;
  tabId?: number;
  method?: string;
  params?: Record<string, unknown>;
  changeInfo?: Record<string, unknown>;
  reason?: string;
  tab?: BrowserTab;
  download?: BrowserDownload;
  downloadId?: number;
};

type PendingBridgeRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type FileChooserEvent = {
  mode?: "selectSingle" | "selectMultiple";
  backendNodeId?: number;
};

type PendingFileChooser = {
  resolve: (event: FileChooserEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingDownload = {
  tabId?: number;
  downloadId?: number;
  resolve: (download: BrowserDownload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  completed: boolean;
};

type BrowserTabState = {
  ownership: "agent" | "claimed";
  parentTabId?: number;
  mark?: "deliverable" | "handoff";
  epoch: number;
  attached: boolean;
  attaching?: Promise<void>;
  snapshotSequence: number;
  latestSnapshotId?: string;
  refs: Map<string, { locator: string; epoch: number; snapshotId: string }>;
  consoleEntries: BrowserDiagnosticEntry[];
  networkEntries: BrowserDiagnosticEntry[];
  actionTimeline: BrowserActionEvent[];
  requestUrls: Map<string, string>;
  popupTabIds: Set<number>;
};

type CdpRuntimeResult = {
  result?: { value?: unknown; description?: string; objectId?: string; subtype?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

type CdpAxNode = {
  nodeId?: string;
  parentId?: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  description?: { value?: unknown };
  backendDOMNodeId?: number;
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
};

class BrowserBridge {
  private readonly server: WebSocketServer;
  private socket: WebSocket | undefined;
  private hello: BridgeHello | undefined;
  private sequence = 0;
  private readonly pending = new Map<string, PendingBridgeRequest>();
  private readonly eventListeners = new Set<(event: BridgeEvent) => void>();

  private constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly token: string,
    server: WebSocketServer,
  ) {
    this.server = server;
    this.server.on("connection", (socket, request) => this.handleConnection(socket, request.url));
  }

  static async listen(host: string, port: number, token: string) {
    const server = new WebSocketServer({ host, port });
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });
    return new BrowserBridge(host, port, token, server);
  }

  status(extensionDirectory: string): BrowserServiceStatus {
    return {
      connected: Boolean(this.socket && this.socket.readyState === WebSocket.OPEN && this.hello),
      bridgeUrl: `ws://${this.host}:${this.port}`,
      extensionDirectory,
      ...(this.hello
        ? {
            extensionId: this.hello.extensionId,
            extensionVersion: this.hello.extensionVersion,
            ...(this.hello.userAgent ? { userAgent: this.hello.userAgent } : {}),
          }
        : {}),
    };
  }

  onEvent(listener: (event: BridgeEvent) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async close() {
    this.failPending(new Error("Browser bridge is shutting down."));
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1001, "server shutdown");
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.hello) {
      throw new Error("Chrome browser bridge disconnected during the operation. Retry the browser tool to reconnect.");
    }

    const id = `browser_${++this.sequence}_${Date.now().toString(36)}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser bridge request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.send(JSON.stringify({ type: "request", id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleConnection(socket: WebSocket, rawUrl: string | undefined) {
    if (!this.authorized(rawUrl)) {
      socket.close(1008, "unauthorized");
      return;
    }

    if (this.socket && this.socket !== socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1012, "replaced by a newer browser bridge connection");
    }
    this.failPending(new Error("Browser bridge connection was replaced."));
    this.socket = socket;
    this.hello = undefined;

    socket.on("message", (raw) => this.handleMessage(socket, raw.toString()));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.hello = undefined;
      this.failPending(new Error("Chrome browser bridge disconnected."));
    });
    socket.on("error", () => undefined);
  }

  private handleMessage(socket: WebSocket, raw: string) {
    if (socket !== this.socket) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;

    if (record.type === "hello") {
      if (
        record.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
        typeof record.extensionId !== "string" ||
        typeof record.extensionVersion !== "string"
      ) {
        socket.close(1002, "incompatible protocol");
        return;
      }
      this.hello = record as unknown as BridgeHello;
      return;
    }

    if (record.type === "response" && typeof record.id === "string") {
      const response = record as unknown as BridgeResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error?.message ?? "Browser bridge request failed."));
      return;
    }

    if (record.type === "event") {
      const event = record as unknown as BridgeEvent;
      for (const listener of this.eventListeners) listener(event);
    }
  }

  private authorized(rawUrl: string | undefined) {
    try {
      const url = new URL(rawUrl ?? "/", `ws://${this.host}:${this.port}`);
      const candidate = url.searchParams.get("token");
      if (!candidate) return false;
      const expected = Buffer.from(this.token);
      const actual = Buffer.from(candidate);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class BrowserService {
  private starting: Promise<void> | undefined;
  private closed = false;
  private readonly states = new Map<number, BrowserTabState>();
  private readonly locks = new Map<number, Promise<void>>();
  private readonly claimListings = new Map<number, { title?: string; url?: string; listedAt: number }>();
  private readonly fileChooserWaiters = new Map<number, PendingFileChooser>();
  private readonly downloads = new Map<number, BrowserDownload>();
  private readonly downloadWaiters = new Set<PendingDownload>();

  private constructor(
    private readonly bridge: BrowserBridge,
    private readonly extensionDirectory: string,
    private readonly launchBrowser: () => Promise<void>,
  ) {
    this.bridge.onEvent((event) => this.handleBridgeEvent(event));
  }

  static async create(input: {
    dataDirectory: string;
    host?: string;
    port: number;
    launchBrowser?: () => Promise<void>;
  }) {
    const host = input.host ?? "127.0.0.1";
    const token = await loadOrCreateBridgeToken(input.dataDirectory);
    const extensionDirectory = await prepareBrowserExtension(
      input.dataDirectory,
      `ws://${host}:${input.port}`,
      token,
    );
    const bridge = await BrowserBridge.listen(host, input.port, token);
    return new BrowserService(bridge, extensionDirectory, input.launchBrowser ?? launchChrome);
  }

  status() {
    return this.bridge.status(this.extensionDirectory);
  }

  private async ensureConnected() {
    if (this.closed) throw new Error("Browser service is shutting down.");
    if (this.status().connected) return;
    if (!this.starting) {
      this.starting = this.startBrowser().finally(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
  }

  private async startBrowser() {
    // Give an already-running extension a moment to reconnect before launching.
    if (await this.waitForConnection(750)) return;
    await this.launchBrowser();
    if (await this.waitForConnection(BROWSER_CONNECT_TIMEOUT_MS)) return;
    throw new Error(
      `Chrome was started, but its extension did not connect within 15 seconds. ` +
      `Load or enable the unpacked extension at ${this.extensionDirectory} in chrome://extensions. ` +
      `If it is installed in another profile, set BROWSER_PROFILE_DIRECTORY to that profile's directory name.`,
    );
  }

  private async waitForConnection(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (this.closed) throw new Error("Browser service is shutting down.");
      if (this.status().connected) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await sleep(Math.min(100, remaining));
    }
  }

  async close() {
    this.closed = true;
    for (const pending of this.fileChooserWaiters.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser service is shutting down."));
    }
    this.fileChooserWaiters.clear();
    for (const pending of this.downloadWaiters) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser service is shutting down."));
    }
    this.downloadWaiters.clear();
    await Promise.all(
      [...this.states.keys()].map((tabId) => this.releaseTab(tabId).catch(() => undefined)),
    );
    await this.bridge.close();
  }

  async listTabs() {
    await this.ensureConnected();
    const tabs = await this.bridge.request<BrowserTab[]>("tabs.list");
    this.claimListings.clear();
    const listedAt = Date.now();
    for (const tab of tabs) {
      if (!this.states.has(tab.id)) {
        this.claimListings.set(tab.id, { title: tab.title, url: tab.url, listedAt });
      }
    }
    return tabs.map((tab) => this.describeTab(tab));
  }

  async open(input: { url?: string; active?: boolean; newWindow?: boolean }) {
    if (input.url) validateNavigationUrl(input.url);
    await this.ensureConnected();
    const tab = await this.bridge.request<BrowserTab>("tabs.open", {
      ...(input.url ? { url: input.url } : {}),
      active: input.active !== false,
      newWindow: input.newWindow === true,
    });
    this.createState(tab.id, "agent");
    await this.ensureAttached(tab.id);
    if (input.url) await this.waitForPageReady(tab.id, DEFAULT_ACTION_TIMEOUT_MS);
    return await this.snapshot(tab.id, false);
  }

  async snapshot(tabId?: number, includeScreenshot = true): Promise<BrowserSnapshotResult> {
    const resolvedTabId = await this.resolveTabId(tabId);
    this.requireControlled(resolvedTabId);
    return await this.withTabLock(resolvedTabId, async () => {
      await this.ensureAttached(resolvedTabId);
      return await this.captureSnapshot(resolvedTabId, includeScreenshot);
    });
  }

  async evaluate(tabId: number | undefined, expression: string, awaitPromise = true) {
    const resolvedTabId = await this.resolveTabId(tabId);
    this.requireControlled(resolvedTabId);
    return await this.withTabLock(resolvedTabId, async () => {
      await this.ensureAttached(resolvedTabId);
      const value = await this.evaluateExpression(resolvedTabId, expression, awaitPromise);
      this.recordAction(resolvedTabId, "evaluate", truncate(String(expression), 160));
      return {
        tabId: resolvedTabId,
        value,
        page: await this.pageIdentity(resolvedTabId),
      };
    });
  }

  async action(input: BrowserActionInput): Promise<BrowserSnapshotResult> {
    const timeoutMs = clampTimeout(input.timeoutMs);
    const tabId = await this.resolveTabId(input.tabId);
    this.requireControlled(tabId);

    if (input.action === "close") {
      await this.bridge.request("tabs.close", { tabId });
      this.states.delete(tabId);
      return {
        snapshot: {
          tabId,
          snapshotId: "closed",
          epoch: 0,
          url: "",
          title: "",
          loading: false,
          visibleText: "Tab closed.",
          interactiveElements: [],
          accessibilityTree: [],
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
          relatedTabs: [],
        },
      };
    }

    return await this.withTabLock(tabId, async () => {
      if (input.action === "activate") {
        await this.bridge.request("tabs.activate", { tabId });
        this.recordAction(tabId, "activate");
        await this.ensureAttached(tabId);
        return await this.captureSnapshot(tabId, false);
      }

      await this.ensureAttached(tabId);
      switch (input.action) {
        case "navigate":
          await this.navigate(tabId, requireString(input.url, "url"), timeoutMs);
          break;
        case "back":
          await this.historyNavigation(tabId, "back", timeoutMs);
          break;
        case "forward":
          await this.historyNavigation(tabId, "forward", timeoutMs);
          break;
        case "reload":
          await this.reload(tabId, input.bypassCache === true, timeoutMs);
          break;
        case "click":
          await this.click(tabId, input, timeoutMs, 1);
          break;
        case "dblclick":
          await this.click(tabId, input, timeoutMs, 2);
          break;
        case "type":
          await this.typeText(tabId, input, timeoutMs);
          break;
        case "press":
          await this.pressKey(tabId, input, timeoutMs);
          break;
        case "scroll":
          await this.scroll(tabId, input, timeoutMs);
          break;
        case "wait":
          await this.waitFor(tabId, input, timeoutMs);
          break;
      }
      await sleep(100);
      return await this.captureSnapshot(tabId, false);
    });
  }

  async manageTab(input: BrowserOwnershipActionInput) {
    await this.ensureConnected();
    if (input.action === "cleanup") return await this.cleanupTabs();
    const tabId = await this.resolveTabId(input.tabId);

    if (input.action === "claim") {
      if (this.states.has(tabId)) return { tab: this.describeTab(await this.bridge.request<BrowserTab>("tabs.get", { tabId })) };
      const listing = this.claimListings.get(tabId);
      if (!listing || Date.now() - listing.listedAt > CLAIM_LISTING_TTL_MS) {
        throw new Error("The tab claim listing is missing or expired. List browser tabs again before claiming.");
      }
      if (input.title !== listing.title || input.url !== listing.url) {
        throw new Error("The tab title or URL does not match the latest browser tab listing.");
      }
      const current = await this.bridge.request<BrowserTab>("tabs.get", { tabId });
      if (current.title !== listing.title || current.url !== listing.url) {
        this.claimListings.delete(tabId);
        throw new Error("The browser tab changed after it was listed. List tabs again before claiming.");
      }
      this.createState(tabId, "claimed");
      this.claimListings.delete(tabId);
      await this.ensureAttached(tabId);
      this.recordAction(tabId, "claim");
      return { tab: this.describeTab(current) };
    }

    const state = this.state(tabId);
    if (input.action === "release") {
      await this.releaseTab(tabId);
      return { tabId, released: true };
    }
    state.mark = input.action === "mark_handoff" ? "handoff" : "deliverable";
    this.recordAction(tabId, input.action);
    return { tab: this.describeTab(await this.bridge.request<BrowserTab>("tabs.get", { tabId })) };
  }

  async upload(input: { tabId?: number; ref?: string; locator?: string; files: string[]; timeoutMs?: number }) {
    const timeoutMs = clampTimeout(input.timeoutMs);
    const tabId = await this.resolveTabId(input.tabId);
    this.requireControlled(tabId);
    const selector = this.resolveLocator(tabId, { action: "click", ref: input.ref, locator: input.locator })!;
    const files = await validateUploadFiles(input.files);

    return await this.withTabLock(tabId, async () => {
      await this.ensureAttached(tabId);
      const directFileInput = await this.fileInputBackendNodeId(tabId, selector);
      if (directFileInput !== undefined) {
        await this.sendCdp(tabId, "DOM.setFileInputFiles", {
          files,
          backendNodeId: directFileInput,
        });
        this.recordAction(tabId, "upload", `${files.length} file(s) via ${selector}`);
        await sleep(100);
        return { files, snapshot: (await this.captureSnapshot(tabId, false)).snapshot };
      }

      await this.sendCdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
      const waiter = this.createFileChooserWaiter(tabId, timeoutMs);
      try {
        await this.click(tabId, { action: "click", locator: selector, force: true }, timeoutMs, 1);
        const chooser = await waiter.promise;
        if (!chooser.backendNodeId) throw new Error("Chrome did not identify the file input for the chooser.");
        if (chooser.mode !== "selectMultiple" && files.length > 1) {
          throw new Error("The browser file chooser accepts only one file.");
        }
        await this.sendCdp(tabId, "DOM.setFileInputFiles", {
          files,
          backendNodeId: chooser.backendNodeId,
        });
      } finally {
        waiter.cancel();
        await this.sendCdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
      }
      this.recordAction(tabId, "upload", `${files.length} file(s) via ${selector}`);
      await sleep(100);
      return { files, snapshot: (await this.captureSnapshot(tabId, false)).snapshot };
    });
  }

  async download(input: BrowserDownloadInput) {
    await this.ensureConnected();
    const timeoutMs = clampTimeout(input.timeoutMs);
    if (input.action === "list") {
      const downloads = await this.bridge.request<BrowserDownload[]>("downloads.list");
      for (const download of downloads) this.updateDownload(download);
      return {
        downloads: downloads
          .map((download) => this.downloads.get(download.id)!)
          .filter((download) => download.tabId !== undefined && this.states.has(download.tabId)),
      };
    }
    if (input.action === "cancel") {
      const downloadId = requireDownloadId(input.downloadId);
      const download = await this.bridge.request<BrowserDownload | null>("downloads.cancel", { id: downloadId });
      if (download) this.downloads.set(download.id, download);
      return { download };
    }
    if (input.action === "wait") {
      const downloadId = requireDownloadId(input.downloadId);
      return { download: await this.waitForDownload({ downloadId, completed: true, timeoutMs }).promise };
    }

    const tabId = await this.resolveTabId(input.tabId);
    this.requireControlled(tabId);
    const selector = this.resolveLocator(tabId, { action: "click", ref: input.ref, locator: input.locator })!;
    const createdWaiter = this.waitForDownload({ tabId, completed: false, timeoutMs });
    try {
      await this.withTabLock(tabId, async () => {
        await this.ensureAttached(tabId);
        await this.click(tabId, { action: "click", locator: selector }, timeoutMs, 1);
      });
      const created = await createdWaiter.promise;
      if (input.waitForCompletion === false) return { download: created };
      return { download: await this.waitForDownload({ downloadId: created.id, completed: true, timeoutMs }).promise };
    } catch (error) {
      createdWaiter.cancel();
      throw error;
    }
  }

  private async resolveTabId(tabId?: number) {
    await this.ensureConnected();
    if (tabId !== undefined) {
      if (!Number.isInteger(tabId) || tabId < 0) throw new Error("tabId must be a non-negative integer.");
      await this.bridge.request<BrowserTab>("tabs.get", { tabId });
      return tabId;
    }
    const active = await this.bridge.request<BrowserTab | null>("tabs.active");
    if (!active) throw new Error("Chrome has no active tab to control.");
    return active.id;
  }

  private state(tabId: number) {
    const state = this.states.get(tabId);
    if (!state) throw new Error(`Chrome tab ${tabId} is not controlled. List tabs and claim it first.`);
    return state;
  }

  private createState(tabId: number, ownership: "agent" | "claimed", parentTabId?: number) {
    const existing = this.states.get(tabId);
    if (existing) return existing;
    const state: BrowserTabState = {
      ownership,
      ...(parentTabId !== undefined ? { parentTabId } : {}),
      epoch: 0,
      attached: false,
      snapshotSequence: 0,
      refs: new Map(),
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      requestUrls: new Map(),
      popupTabIds: new Set(),
    };
    this.states.set(tabId, state);
    return state;
  }

  private requireControlled(tabId: number) {
    this.state(tabId);
  }

  private describeTab(tab: BrowserTab): BrowserTab {
    const state = this.states.get(tab.id);
    return {
      ...tab,
      ownership: state?.ownership ?? "user",
      controlled: Boolean(state),
      ...(state?.mark ? { mark: state.mark } : {}),
      ...(state?.parentTabId !== undefined ? { parentTabId: state.parentTabId } : {}),
    };
  }

  private async releaseTab(tabId: number) {
    const state = this.state(tabId);
    await state.attaching?.catch(() => undefined);
    await this.bridge.request("overlay.hide", { tabId }).catch(() => undefined);
    if (state.attached) {
      await this.bridge.request("debugger.detach", { tabId }).catch(() => undefined);
    }
    this.fileChooserWaiters.get(tabId)?.reject(new Error("Browser tab control was released."));
    this.fileChooserWaiters.delete(tabId);
    this.states.delete(tabId);
  }

  private async cleanupTabs() {
    const closed: number[] = [];
    const released: number[] = [];
    const preserved: Array<{ tabId: number; mark: "deliverable" | "handoff" }> = [];

    for (const [tabId, state] of [...this.states]) {
      if (state.mark) {
        preserved.push({ tabId, mark: state.mark });
        state.mark = undefined;
        continue;
      }
      if (state.ownership === "agent") {
        await this.bridge.request("tabs.close", { tabId }).catch(() => undefined);
        this.states.delete(tabId);
        closed.push(tabId);
      } else {
        await this.releaseTab(tabId);
        released.push(tabId);
      }
    }
    return { closed, released, preserved };
  }

  private createFileChooserWaiter(tabId: number, timeoutMs: number) {
    const previous = this.fileChooserWaiters.get(tabId);
    previous?.reject(new Error("A newer file chooser wait replaced this one."));
    let pending!: PendingFileChooser;
    const promise = new Promise<FileChooserEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.fileChooserWaiters.get(tabId) === pending) this.fileChooserWaiters.delete(tabId);
        reject(new Error(`Browser file chooser did not open within ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref();
      pending = { resolve, reject, timer };
      this.fileChooserWaiters.set(tabId, pending);
    });
    const cancel = () => {
      if (this.fileChooserWaiters.get(tabId) !== pending) return;
      clearTimeout(pending.timer);
      this.fileChooserWaiters.delete(tabId);
    };
    return { promise, cancel };
  }

  private waitForDownload(input: { tabId?: number; downloadId?: number; completed: boolean; timeoutMs: number }) {
    if (input.downloadId !== undefined) {
      const existing = this.downloads.get(input.downloadId);
      if (existing && (!input.completed || existing.state === "complete" || existing.state === "interrupted")) {
        return { promise: Promise.resolve(existing), cancel: () => undefined };
      }
    }

    let pending!: PendingDownload;
    const promise = new Promise<BrowserDownload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.downloadWaiters.delete(pending);
        reject(new Error(`Browser download did not ${input.completed ? "finish" : "start"} within ${input.timeoutMs}ms.`));
      }, input.timeoutMs);
      timer.unref();
      pending = {
        ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
        ...(input.downloadId !== undefined ? { downloadId: input.downloadId } : {}),
        resolve,
        reject,
        timer,
        completed: input.completed,
      };
      this.downloadWaiters.add(pending);
    });
    const cancel = () => {
      if (!this.downloadWaiters.delete(pending)) return;
      clearTimeout(pending.timer);
    };
    return { promise, cancel };
  }

  private updateDownload(download: BrowserDownload) {
    const previous = this.downloads.get(download.id);
    const current = { ...previous, ...download };
    this.downloads.set(download.id, current);
    for (const waiter of [...this.downloadWaiters]) {
      if (waiter.downloadId !== undefined && waiter.downloadId !== current.id) continue;
      if (waiter.tabId !== undefined && current.tabId !== undefined && waiter.tabId !== current.tabId) continue;
      if (waiter.completed && current.state !== "complete" && current.state !== "interrupted") continue;
      if (current.tabId === undefined && waiter.tabId !== undefined && waiter.downloadId === undefined) {
        current.tabId = waiter.tabId;
        this.downloads.set(current.id, current);
      }
      clearTimeout(waiter.timer);
      this.downloadWaiters.delete(waiter);
      waiter.resolve(current);
    }
  }

  private async ensureAttached(tabId: number) {
    const state = this.state(tabId);
    if (state.attached) return;
    if (state.attaching) return await state.attaching;
    const attaching = (async () => {
      await this.bridge.request("debugger.attach", { tabId });
      state.attached = true;
      const domains = ["Runtime.enable", "Accessibility.enable", "Network.enable", "Log.enable", "Page.enable"];
      await Promise.all(
        domains.map((method) =>
          this.sendCdp(tabId, method).catch(() => undefined),
        ),
      );
      await this.bridge.request("overlay.show", { tabId }).catch(() => undefined);
    })();
    state.attaching = attaching;
    try {
      await attaching;
    } finally {
      if (state.attaching === attaching) state.attaching = undefined;
    }
  }

  private async sendCdp<T = Record<string, unknown>>(
    tabId: number,
    method: string,
    commandParams: Record<string, unknown> = {},
  ) {
    return await this.bridge.request<T>("debugger.command", {
      tabId,
      method,
      commandParams,
    });
  }

  private async evaluateExpression<T = unknown>(tabId: number, expression: string, awaitPromise = true) {
    const response = await this.sendCdp<CdpRuntimeResult>(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Page evaluation failed.";
      throw new Error(truncate(detail, 1_000));
    }
    return response.result?.value as T;
  }

  private async fileInputBackendNodeId(tabId: number, locator: string) {
    await this.ensurePlaywrightInjected(tabId);
    const locatorJson = JSON.stringify(locator);
    const response = await this.sendCdp<CdpRuntimeResult>(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const injected = globalThis.__localCodexPlaywrightInjected;
        const element = injected.querySelector(injected.parseSelector(${locatorJson}), document, true);
        return element instanceof HTMLInputElement && element.type === "file" ? element : null;
      })()`,
      returnByValue: false,
      userGesture: true,
    });
    if (response.exceptionDetails) return undefined;
    const objectId = response.result?.objectId;
    if (!objectId || response.result?.subtype === "null") return undefined;
    try {
      const described = await this.sendCdp<{ node?: { backendNodeId?: number } }>(tabId, "DOM.describeNode", { objectId });
      return described.node?.backendNodeId;
    } finally {
      await this.sendCdp(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  private async ensurePlaywrightInjected(tabId: number) {
    const installed = await this.evaluateExpression<boolean>(
      tabId,
      "Boolean(globalThis.__localCodexPlaywrightInjected)",
    );
    if (installed) return;
    const installExpression = await getPlaywrightInstallExpression();
    await this.evaluateExpression(tabId, installExpression);
  }

  private async navigate(tabId: number, url: string, timeoutMs: number) {
    validateNavigationUrl(url);
    await this.bridge.request("tabs.navigate", { tabId, url });
    this.invalidateRefs(tabId);
    this.recordAction(tabId, "navigate", url);
    await this.waitForPageReady(tabId, timeoutMs);
  }

  private async historyNavigation(tabId: number, direction: "back" | "forward", timeoutMs: number) {
    await this.bridge.request(`tabs.${direction}`, { tabId });
    this.invalidateRefs(tabId);
    this.recordAction(tabId, direction);
    await this.waitForPageReady(tabId, timeoutMs);
  }

  private async reload(tabId: number, bypassCache: boolean, timeoutMs: number) {
    await this.bridge.request("tabs.reload", { tabId, bypassCache });
    this.invalidateRefs(tabId);
    this.recordAction(tabId, "reload", bypassCache ? "bypass cache" : undefined);
    await this.waitForPageReady(tabId, timeoutMs);
  }

  private async click(tabId: number, input: BrowserActionInput, timeoutMs: number, clickCount: 1 | 2) {
    const directCoordinates =
      typeof input.x === "number" && typeof input.y === "number"
        ? { x: input.x, y: input.y }
        : undefined;
    const locator = directCoordinates ? undefined : this.resolveLocator(tabId, input);
    const point = directCoordinates ?? (await this.waitForClickPoint(tabId, locator!, timeoutMs, input.force === true));
    const viewport = await this.evaluateExpression<{ width: number; height: number }>(
      tabId,
      "({ width: window.innerWidth, height: window.innerHeight })",
    );
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x > viewport.width ||
      point.y > viewport.height
    ) {
      throw new Error(`Click coordinates (${point.x}, ${point.y}) are outside the ${viewport.width}x${viewport.height} viewport.`);
    }
    const overlayMove = await this.bridge
      .request<{ delivered: boolean }>("overlay.move", { tabId, x: point.x, y: point.y })
      .catch(() => ({ delivered: false }));
    if (overlayMove.delivered) await sleep(CONTROL_OVERLAY_MOVE_DELAY_MS);
    await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    const button = input.button ?? "left";
    const modifiers = keyboardModifiers(input.modifiers ?? []);
    for (let count = 1; count <= clickCount; count += 1) {
      await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button,
        clickCount: count,
        modifiers,
      });
      await this.sendCdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button,
        clickCount: count,
        modifiers,
      });
      await this.bridge.request("overlay.click", { tabId }).catch(() => undefined);
    }
    this.recordAction(tabId, clickCount === 2 ? "dblclick" : "click", locator ?? `${point.x},${point.y}`);
  }

  private async waitForClickPoint(tabId: number, locator: string, timeoutMs: number, force = false) {
    await this.ensurePlaywrightInjected(tabId);
    const locatorJson = JSON.stringify(locator);
    const startedAt = Date.now();
    let lastInvalidSelector: string | undefined;
    while (Date.now() - startedAt <= timeoutMs) {
      const result = await this.evaluateExpression<
        | { ok: true; x: number; y: number }
        | { notFound: true }
        | { invalidSelector: true; message: string }
      >(
        tabId,
        `(() => {
          try {
            const injected = globalThis.__localCodexPlaywrightInjected;
            const parsed = injected.parseSelector(${locatorJson});
            const element = injected.querySelector(parsed, document, true);
            if (!element) return { notFound: true };
            const visible = injected.elementState(element, "visible");
            const enabled = injected.elementState(element, "enabled");
            if (!visible.matches || (!${force} && !enabled.matches)) return { notFound: true };
            element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            const rect = element.getBoundingClientRect();
            return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      );
      if ("ok" in result) return { x: result.x, y: result.y };
      if ("invalidSelector" in result) {
        lastInvalidSelector = result.message;
        break;
      }
      await sleep(100);
    }
    if (lastInvalidSelector) throw new Error(`Invalid browser locator: ${truncate(lastInvalidSelector, 500)}`);
    throw new Error(`Browser target was not visible and enabled within ${timeoutMs}ms: ${locator}`);
  }

  private async typeText(tabId: number, input: BrowserActionInput, timeoutMs: number) {
    const text = requireString(input.text, "text", true);
    const locator = this.resolveLocator(tabId, input, true);
    if (locator) {
      await this.waitForLocator(tabId, locator, timeoutMs, "editable");
      await this.ensurePlaywrightInjected(tabId);
    }
    const locatorJson = locator ? JSON.stringify(locator) : "null";
    const textJson = JSON.stringify(text);
    const clear = input.clear === true;
    const result = await this.evaluateExpression<
      { ok: true } | { notFound: true } | { notEditable: true } | { invalidSelector: true; message: string }
    >(
      tabId,
      `(() => {
        try {
          const element = ${locator ? `(() => { const injected = globalThis.__localCodexPlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "document.activeElement"};
          if (!element) return { notFound: true };
          const textControl = element instanceof HTMLTextAreaElement ||
            (element instanceof HTMLInputElement && !new Set(["button","checkbox","color","file","hidden","image","radio","range","reset","submit"]).has(element.type));
          const editable = textControl || element.isContentEditable;
          if (!editable || element.disabled || element.readOnly) return { notEditable: true };
          element.focus();
          if (document.activeElement !== element) return { notEditable: true };
          if (${clear}) {
            if (textControl) element.select();
            else {
              const range = document.createRange();
              range.selectNodeContents(element);
              const selection = document.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
            }
          } else if (textControl && typeof element.setSelectionRange === "function") {
            const end = element.value.length;
            element.setSelectionRange(end, end);
          }
          const text = ${textJson};
          let inserted = true;
          if (text.length > 0) inserted = document.execCommand("insertText", false, text);
          else if (${clear}) document.execCommand("delete", false);
          if (!inserted) return { notEditable: true };
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        } catch (error) {
          return { invalidSelector: true, message: String(error) };
        }
      })()`,
    );
    if ("notFound" in result) throw new Error("Browser typing target was not found.");
    if ("notEditable" in result) throw new Error("Browser typing target is not editable.");
    if ("invalidSelector" in result) throw new Error(`Invalid browser locator: ${truncate(result.message, 500)}`);
    this.recordAction(tabId, "type", locator ?? "focused element");
  }

  private async pressKey(tabId: number, input: BrowserActionInput, timeoutMs: number) {
    if (input.ref || input.locator) {
      const locator = this.resolveLocator(tabId, input);
      await this.waitForLocator(tabId, locator!, timeoutMs, "visible");
      await this.focusLocator(tabId, locator!);
    }
    const key = requireString(input.key, "key");
    const modifiers = keyboardModifiers(input.modifiers ?? []);
    const descriptor = keyDescriptor(key);
    const keyDown: Record<string, unknown> = {
      type: descriptor.text && modifiers === 0 ? "keyDown" : "rawKeyDown",
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      modifiers,
      ...(descriptor.text && modifiers === 0 ? { text: descriptor.text, unmodifiedText: descriptor.text } : {}),
    };
    await this.sendCdp(tabId, "Input.dispatchKeyEvent", keyDown);
    await this.sendCdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      modifiers,
    });
    this.recordAction(tabId, "press", [...(input.modifiers ?? []), key].join("+"));
  }

  private async scroll(tabId: number, input: BrowserActionInput, timeoutMs: number) {
    const locator = this.resolveLocator(tabId, input, true);
    if (locator) await this.waitForLocator(tabId, locator, timeoutMs, "visible");
    const locatorJson = locator ? JSON.stringify(locator) : "null";
    if (locator) await this.ensurePlaywrightInjected(tabId);
    const deltaX = finiteNumber(input.deltaX ?? 0, "deltaX");
    const deltaY = finiteNumber(input.deltaY ?? 0, "deltaY");
    const result = await this.evaluateExpression<
      { ok: true } | { notFound: true } | { invalidSelector: true; message: string }
    >(
      tabId,
      `(() => {
        try {
          const target = ${locator ? `(() => { const injected = globalThis.__localCodexPlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "window"};
          if (!target) return { notFound: true };
          target.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: "instant" });
          return { ok: true };
        } catch (error) {
          return { invalidSelector: true, message: String(error) };
        }
      })()`,
    );
    if ("notFound" in result) throw new Error("Browser scroll target was not found.");
    if ("invalidSelector" in result) throw new Error(`Invalid browser locator: ${truncate(result.message, 500)}`);
    this.recordAction(tabId, "scroll", `${deltaX},${deltaY}${locator ? ` on ${locator}` : ""}`);
  }

  private async waitFor(tabId: number, input: BrowserActionInput, timeoutMs: number) {
    const locator = this.resolveLocator(tabId, input, true);
    if (!locator && !input.waitForText && !input.waitForUrlIncludes) {
      throw new Error("wait requires ref/locator, waitForText, or waitForUrlIncludes.");
    }
    if (locator) await this.ensurePlaywrightInjected(tabId);
    const locatorJson = locator ? JSON.stringify(locator) : "null";
    const textJson = input.waitForText !== undefined ? JSON.stringify(input.waitForText) : "null";
    const urlJson = input.waitForUrlIncludes !== undefined ? JSON.stringify(input.waitForUrlIncludes) : "null";
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const matches = await this.evaluateExpression<boolean>(
        tabId,
        `(() => {
          try {
            const injected = globalThis.__localCodexPlaywrightInjected;
            const locator = ${locatorJson};
            const expectedText = ${textJson};
            const expectedUrl = ${urlJson};
            if (locator) {
              const element = injected.querySelector(injected.parseSelector(locator), document, true);
              if (!element || !injected.elementState(element, "visible").matches) return false;
            }
            if (expectedText !== null && !(document.body?.innerText ?? "").includes(expectedText)) return false;
            if (expectedUrl !== null && !location.href.includes(expectedUrl)) return false;
            return true;
          } catch {
            return false;
          }
        })()`,
      ).catch(() => false);
      if (matches) {
        this.recordAction(tabId, "wait", locator ?? input.waitForText ?? input.waitForUrlIncludes);
        return;
      }
      await sleep(100);
    }
    throw new Error(`Browser wait condition did not match within ${timeoutMs}ms.`);
  }

  private async waitForLocator(
    tabId: number,
    locator: string,
    timeoutMs: number,
    desiredState: "visible" | "editable",
  ) {
    await this.ensurePlaywrightInjected(tabId);
    const locatorJson = JSON.stringify(locator);
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const matches = await this.evaluateExpression<boolean>(
        tabId,
        `(() => {
          try {
            const injected = globalThis.__localCodexPlaywrightInjected;
            const element = injected.querySelector(injected.parseSelector(${locatorJson}), document, true);
            if (!element || !injected.elementState(element, "visible").matches) return false;
            if (${JSON.stringify(desiredState)} === "editable") {
              const textControl = element instanceof HTMLTextAreaElement ||
                (element instanceof HTMLInputElement && !new Set(["button","checkbox","color","file","hidden","image","radio","range","reset","submit"]).has(element.type));
              return (textControl || element.isContentEditable) && !element.disabled && !element.readOnly;
            }
            return true;
          } catch {
            return false;
          }
        })()`,
      ).catch(() => false);
      if (matches) return;
      await sleep(100);
    }
    throw new Error(`Browser target did not become ${desiredState} within ${timeoutMs}ms: ${locator}`);
  }

  private async focusLocator(tabId: number, locator: string) {
    await this.ensurePlaywrightInjected(tabId);
    const locatorJson = JSON.stringify(locator);
    const focused = await this.evaluateExpression<boolean>(
      tabId,
      `(() => {
        const injected = globalThis.__localCodexPlaywrightInjected;
        const element = injected.querySelector(injected.parseSelector(${locatorJson}), document, true);
        if (!element) return false;
        element.focus();
        return document.activeElement === element;
      })()`,
    );
    if (!focused) throw new Error(`Could not focus browser target: ${locator}`);
  }

  private resolveLocator(tabId: number, input: BrowserActionInput, optional = false) {
    if (input.ref) {
      const state = this.state(tabId);
      const target = state.refs.get(input.ref);
      if (!target) throw new Error(`Unknown or stale browser element ref: ${input.ref}. Take a new browser snapshot.`);
      if (target.epoch !== state.epoch || target.snapshotId !== state.latestSnapshotId) {
        throw new Error(`Browser element ref ${input.ref} is stale after the page changed. Take a new browser snapshot.`);
      }
      return target.locator;
    }
    if (input.locator) return input.locator;
    if (optional) return undefined;
    if (typeof input.x === "number" && typeof input.y === "number") return undefined;
    throw new Error("Browser action requires a fresh element ref, a Playwright locator, or coordinates.");
  }

  private async captureSnapshot(tabId: number, includeScreenshot: boolean): Promise<BrowserSnapshotResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = this.state(tabId);
      const startingEpoch = state.epoch;
      const page = await this.evaluateExpression<{
        url: string;
        title: string;
        loading: boolean;
        visibleText: string;
        interactiveElements: Array<Omit<BrowserInteractiveElement, "ref">>;
      }>(tabId, PAGE_SNAPSHOT_EXPRESSION);

      const [axResponse, screenshotResponse] = await Promise.all([
        this.sendCdp<{ nodes?: CdpAxNode[] }>(tabId, "Accessibility.getFullAXTree").catch(() => ({ nodes: [] })),
        includeScreenshot
          ? this.sendCdp<{ data?: string }>(tabId, "Page.captureScreenshot", {
              format: "png",
              fromSurface: true,
              captureBeyondViewport: false,
            }).catch(() => ({ data: undefined }))
          : Promise.resolve({ data: undefined as string | undefined }),
      ]);

      if (state.epoch !== startingEpoch && attempt === 0) continue;

      const snapshotId = `s${++state.snapshotSequence}-e${state.epoch}`;
      state.refs.clear();
      const interactiveElements = page.interactiveElements.slice(0, MAX_INTERACTIVE_ELEMENTS).map((element, index) => {
        const ref = `e${index + 1}`;
        state.refs.set(ref, { locator: element.locator, epoch: state.epoch, snapshotId });
        return { ref, ...element };
      });
      state.latestSnapshotId = snapshotId;

      const screenshotData = screenshotResponse.data;
      const screenshotBuffer = screenshotData ? Buffer.from(screenshotData, "base64") : undefined;
      const dimensions = screenshotBuffer ? pngDimensions(screenshotBuffer) : undefined;
      const relatedTabs = await this.relatedTabs(tabId);
      const snapshot: BrowserSnapshot = {
        tabId,
        snapshotId,
        epoch: state.epoch,
        url: page.url,
        title: page.title,
        loading: page.loading,
        visibleText: truncate(page.visibleText ?? "", MAX_VISIBLE_TEXT),
        interactiveElements,
        accessibilityTree: normalizeAccessibilityTree(axResponse.nodes ?? []),
        consoleEntries: state.consoleEntries.slice(-MAX_DIAGNOSTIC_ENTRIES),
        networkEntries: state.networkEntries.slice(-MAX_DIAGNOSTIC_ENTRIES),
        actionTimeline: state.actionTimeline.slice(-MAX_ACTION_TIMELINE),
        relatedTabs,
        ...(screenshotBuffer
          ? {
              screenshot: {
                mimeType: "image/png" as const,
                ...(dimensions ?? {}),
                bytes: screenshotBuffer.byteLength,
              },
            }
          : {}),
      };
      return { snapshot, ...(screenshotData ? { screenshotData } : {}) };
    }
    throw new Error("Page changed repeatedly while capturing a browser snapshot. Try again.");
  }

  private async pageIdentity(tabId: number) {
    return await this.evaluateExpression<{ url: string; title: string }>(
      tabId,
      "({ url: location.href, title: document.title })",
    );
  }

  private async relatedTabs(tabId: number) {
    const state = this.state(tabId);
    const tabIds = new Set(state.popupTabIds);
    if (state.parentTabId !== undefined) tabIds.add(state.parentTabId);
    const tabs = await Promise.all(
      [...tabIds].map((relatedTabId) =>
        this.bridge.request<BrowserTab>("tabs.get", { tabId: relatedTabId }).catch(() => undefined),
      ),
    );
    return tabs.filter((tab): tab is BrowserTab => Boolean(tab)).map((tab) => this.describeTab(tab));
  }

  private async waitForPageReady(tabId: number, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const tab = await this.bridge.request<BrowserTab>("tabs.get", { tabId }).catch(() => undefined);
      if (tab?.status === "complete") {
        const ready = await this.evaluateExpression<string>(tabId, "document.readyState").catch(() => "loading");
        if (ready !== "loading") return;
      }
      await sleep(100);
    }
    throw new Error(`Browser navigation did not become ready within ${timeoutMs}ms.`);
  }

  private recordAction(tabId: number, action: string, detail?: string) {
    const state = this.state(tabId);
    state.actionTimeline.push({
      at: new Date().toISOString(),
      action,
      ...(detail ? { detail: truncate(detail, 500) } : {}),
    });
    trimArray(state.actionTimeline, MAX_ACTION_TIMELINE);
  }

  private invalidateRefs(tabId: number) {
    const state = this.state(tabId);
    state.epoch += 1;
    state.refs.clear();
    state.latestSnapshotId = undefined;
  }

  private handleBridgeEvent(event: BridgeEvent) {
    if (event.event === "downloadCreated" || event.event === "downloadChanged") {
      if (event.download) this.updateDownload(event.download);
      return;
    }
    if (event.event === "downloadErased") {
      if (event.downloadId !== undefined) this.downloads.delete(event.downloadId);
      return;
    }
    if (!Number.isInteger(event.tabId)) return;
    const tabId = event.tabId!;

    if (event.event === "tabCreated") {
      const parentTabId = event.tab?.openerTabId;
      if (parentTabId === undefined || !this.states.has(parentTabId)) return;
      const parent = this.state(parentTabId);
      this.createState(tabId, "agent", parentTabId);
      parent.popupTabIds.add(tabId);
      this.recordAction(parentTabId, "popup", `tab ${tabId}`);
      void this.ensureAttached(tabId).catch(() => undefined);
      return;
    }

    if (event.event === "tabRemoved") {
      const removed = this.states.get(tabId);
      if (removed?.parentTabId !== undefined) this.states.get(removed.parentTabId)?.popupTabIds.delete(tabId);
      for (const state of this.states.values()) state.popupTabIds.delete(tabId);
      this.fileChooserWaiters.get(tabId)?.reject(new Error("Browser tab closed before the file chooser completed."));
      this.fileChooserWaiters.delete(tabId);
      this.states.delete(tabId);
      return;
    }

    const state = this.states.get(tabId);
    if (!state) return;

    if (event.event === "debuggerDetached") {
      state.attached = false;
      state.attaching = undefined;
      this.invalidateRefs(tabId);
      return;
    }
    if (event.event === "tabUpdated") {
      if (event.changeInfo?.url || event.changeInfo?.status === "loading") this.invalidateRefs(tabId);
      return;
    }
    if (event.event !== "debugger" || !event.method) return;

    if (event.method === "Page.fileChooserOpened") {
      const pending = this.fileChooserWaiters.get(tabId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.fileChooserWaiters.delete(tabId);
      pending.resolve({
        ...(event.params?.mode === "selectSingle" || event.params?.mode === "selectMultiple"
          ? { mode: event.params.mode }
          : {}),
        ...(typeof event.params?.backendNodeId === "number"
          ? { backendNodeId: event.params.backendNodeId }
          : {}),
      });
      return;
    }

    if (event.method === "Page.frameNavigated") {
      const frame = event.params?.frame as Record<string, unknown> | undefined;
      if (frame && !frame.parentId) this.invalidateRefs(tabId);
      return;
    }
    if (event.method === "Network.requestWillBeSent") {
      const requestId = event.params?.requestId;
      const request = event.params?.request as Record<string, unknown> | undefined;
      if (typeof requestId === "string" && typeof request?.url === "string") {
        state.requestUrls.set(requestId, request.url);
        if (state.requestUrls.size > 200) {
          const oldest = state.requestUrls.keys().next().value;
          if (typeof oldest === "string") state.requestUrls.delete(oldest);
        }
      }
      return;
    }
    if (event.method === "Network.responseReceived") {
      const requestId = event.params?.requestId;
      const response = event.params?.response as Record<string, unknown> | undefined;
      const url = typeof response?.url === "string"
        ? response.url
        : typeof requestId === "string"
          ? state.requestUrls.get(requestId)
          : undefined;
      state.networkEntries.push({
        at: new Date().toISOString(),
        kind: "response",
        text: truncate(`${response?.status ?? ""} ${url ?? ""}`.trim(), 1_000),
        ...(url ? { url } : {}),
        ...(typeof response?.status === "number" ? { status: response.status } : {}),
      });
      trimArray(state.networkEntries, MAX_DIAGNOSTIC_ENTRIES);
      return;
    }
    if (event.method === "Network.loadingFailed") {
      const requestId = event.params?.requestId;
      const url = typeof requestId === "string" ? state.requestUrls.get(requestId) : undefined;
      const errorText = typeof event.params?.errorText === "string" ? event.params.errorText : "Network request failed";
      state.networkEntries.push({
        at: new Date().toISOString(),
        kind: "failed",
        text: truncate(`${errorText}${url ? ` ${url}` : ""}`, 1_000),
        ...(url ? { url } : {}),
      });
      trimArray(state.networkEntries, MAX_DIAGNOSTIC_ENTRIES);
      return;
    }
    if (event.method === "Runtime.consoleAPICalled") {
      const type = typeof event.params?.type === "string" ? event.params.type : "console";
      const args = Array.isArray(event.params?.args) ? event.params.args : [];
      const text = args
        .map((arg) => {
          if (!arg || typeof arg !== "object") return String(arg);
          const record = arg as Record<string, unknown>;
          if (record.value !== undefined) return String(record.value);
          if (typeof record.description === "string") return record.description;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      state.consoleEntries.push({
        at: new Date().toISOString(),
        kind: type,
        text: truncate(text, 1_000),
      });
      trimArray(state.consoleEntries, MAX_DIAGNOSTIC_ENTRIES);
      return;
    }
    if (event.method === "Log.entryAdded") {
      const entry = event.params?.entry as Record<string, unknown> | undefined;
      const text = typeof entry?.text === "string" ? entry.text : "";
      state.consoleEntries.push({
        at: new Date().toISOString(),
        kind: typeof entry?.level === "string" ? entry.level : "log",
        text: truncate(text, 1_000),
        ...(typeof entry?.url === "string" ? { url: entry.url } : {}),
      });
      trimArray(state.consoleEntries, MAX_DIAGNOSTIC_ENTRIES);
    }
  }

  private async withTabLock<T>(tabId: number, operation: () => Promise<T>) {
    const previous = this.locks.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.locks.set(tabId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(tabId) === queued) this.locks.delete(tabId);
    }
  }
}

export async function createBrowserService(input: {
  dataDirectory: string;
  port: number;
  host?: string;
  launchBrowser?: () => Promise<void>;
}) {
  return await BrowserService.create(input);
}

async function loadOrCreateBridgeToken(dataDirectory: string) {
  const tokenPath = path.join(dataDirectory, "browser-bridge-token");
  await mkdir(dataDirectory, { recursive: true });
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (token.length >= 32) return token;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

async function prepareBrowserExtension(dataDirectory: string, bridgeUrl: string, token: string) {
  const sourceDirectory = fileURLToPath(new URL("../browser-extension/", import.meta.url));
  const extensionDirectory = path.join(dataDirectory, "browser-extension");
  await mkdir(extensionDirectory, { recursive: true });
  await Promise.all([
    copyFile(path.join(sourceDirectory, "manifest.json"), path.join(extensionDirectory, "manifest.json")),
    copyFile(path.join(sourceDirectory, "service-worker.js"), path.join(extensionDirectory, "service-worker.js")),
    copyFile(path.join(sourceDirectory, "content-script.js"), path.join(extensionDirectory, "content-script.js")),
    copyFile(path.join(sourceDirectory, "cursor.svg"), path.join(extensionDirectory, "cursor.svg")),
    copyFile(path.join(sourceDirectory, "empty.svg"), path.join(extensionDirectory, "empty.svg")),
  ]);
  const config = `globalThis.LOCAL_CODEX_BROWSER_CONFIG = ${JSON.stringify({ bridgeUrl, token })};\n`;
  await writeFile(path.join(extensionDirectory, "config.js"), config, { encoding: "utf8", mode: 0o600 });
  return extensionDirectory;
}

function normalizeAccessibilityTree(nodes: CdpAxNode[]) {
  const output: BrowserAxNode[] = [];
  for (const node of nodes) {
    if (node.ignored || !node.nodeId) continue;
    const role = primitiveString(node.role?.value);
    const name = primitiveString(node.name?.value);
    const value = primitiveString(node.value?.value);
    const description = primitiveString(node.description?.value);
    const properties: Record<string, string | number | boolean> = {};
    for (const property of node.properties ?? []) {
      if (!property.name) continue;
      const primitive = primitiveValue(property.value?.value);
      if (primitive !== undefined && IMPORTANT_AX_PROPERTIES.has(property.name)) {
        properties[property.name] = primitive;
      }
    }
    if (!role && !name && !value) continue;
    output.push({
      nodeId: node.nodeId,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(role ? { role: truncate(role, 120) } : {}),
      ...(name ? { name: truncate(name, 500) } : {}),
      ...(value ? { value: truncate(value, 500) } : {}),
      ...(description ? { description: truncate(description, 500) } : {}),
      ...(typeof node.backendDOMNodeId === "number" ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
    });
    if (output.length >= MAX_AX_NODES) break;
  }
  return output;
}

const IMPORTANT_AX_PROPERTIES = new Set([
  "checked",
  "disabled",
  "expanded",
  "focused",
  "level",
  "multiselectable",
  "pressed",
  "readonly",
  "required",
  "selected",
]);

const PAGE_SNAPSHOT_EXPRESSION = `(() => {
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const attrSelector = (name, value) => '[' + name + '=\"' + CSS.escape(value) + '\"]';
  const selectorFor = (element) => {
    if (element.id) {
      const selector = '#' + CSS.escape(element.id);
      if (unique(selector)) return 'css=' + selector;
    }
    for (const attribute of ['data-testid', 'data-test', 'aria-label', 'name']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = attrSelector(attribute, value);
      if (unique(selector)) return 'css=' + selector;
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      const segment = sameTag.length <= 1 ? tag : tag + ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      parts.unshift(segment);
      const selector = parts.join(' > ');
      if (unique(selector)) return 'css=' + selector;
      current = parent;
    }
    return 'css=' + parts.join(' > ');
  };
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button','submit','reset'].includes(type)) return 'button';
      return 'textbox';
    }
    return undefined;
  };
  const elements = [];
  const candidates = document.querySelectorAll('a[href],button,input,textarea,select,[role],[tabindex],[contenteditable="true"]');
  for (const element of candidates) {
    if (elements.length >= ${MAX_INTERACTIVE_ELEMENTS}) break;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    const label = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') ||
      ((element.innerText || element.textContent || '').trim()) || (typeof element.value === 'string' ? element.value : '');
    elements.push({
      locator: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || implicitRole(element),
      name: label ? label.slice(0, 500) : undefined,
      type: element instanceof HTMLInputElement ? element.type : undefined,
      value: typeof element.value === 'string' ? element.value.slice(0, 500) : undefined,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      checked: typeof element.checked === 'boolean' ? element.checked : undefined,
      selected: typeof element.selected === 'boolean' ? element.selected : undefined,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState === 'loading',
    visibleText: (document.body?.innerText || '').slice(0, ${MAX_VISIBLE_TEXT}),
    interactiveElements: elements,
  };
})()`;

function validateNavigationUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid browser URL: ${value}`);
  }
  if (url.protocol === "about:" && url.href === "about:blank") return;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser navigation currently supports http://, https://, and about:blank URLs only.");
  }
}

async function validateUploadFiles(values: string[]) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("At least one upload file is required.");
  if (values.length > MAX_UPLOAD_FILES) throw new Error(`At most ${MAX_UPLOAD_FILES} files can be uploaded at once.`);
  const files: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw new Error(`Browser upload paths must be absolute: ${value}`);
    }
    const resolved = path.resolve(value);
    const metadata = await stat(resolved).catch(() => undefined);
    if (!metadata?.isFile()) throw new Error(`Browser upload file does not exist or is not a regular file: ${resolved}`);
    files.push(resolved);
  }
  return files;
}

function requireDownloadId(value: number | undefined) {
  if (!Number.isInteger(value) || value! < 0) throw new Error("A valid downloadId is required.");
  return value!;
}

function clampTimeout(value: number | undefined) {
  if (value === undefined) return DEFAULT_ACTION_TIMEOUT_MS;
  if (!Number.isFinite(value)) throw new Error("timeoutMs must be a finite number.");
  return Math.max(100, Math.min(MAX_ACTION_TIMEOUT_MS, Math.trunc(value)));
}

function requireString(value: string | undefined, name: string, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} is required for this browser action.`);
  }
  return value;
}

function finiteNumber(value: number, name: string) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function keyboardModifiers(modifiers: Array<"Alt" | "Control" | "Meta" | "Shift">) {
  let value = 0;
  for (const modifier of modifiers) {
    if (modifier === "Alt") value |= 1;
    if (modifier === "Control") value |= 2;
    if (modifier === "Meta") value |= 4;
    if (modifier === "Shift") value |= 8;
  }
  return value;
}

function keyDescriptor(input: string) {
  const aliases: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  };
  const aliased = aliases[input];
  if (aliased) return aliased;
  if (input.length === 1) {
    const upper = input.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(input) ? `Digit${input}` : "";
    return { key: input, code, keyCode: upper.charCodeAt(0), text: input };
  }
  throw new Error(`Unsupported browser key: ${input}`);
}

function primitiveString(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function primitiveValue(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function pngDimensions(buffer: Buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return undefined;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function truncate(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}â€¦`;
}

function trimArray<T>(values: T[], maximum: number) {
  if (values.length > maximum) values.splice(0, values.length - maximum);
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
