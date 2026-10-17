import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserTab, BrowserDownload, BridgeEvent } from "./browser.js";

type Client = {
  socket: WebSocket;
  processId: number;
  appName: string;
  tabs: Map<number, number>;
  downloads: Map<number, number>;
};
type Route = { client: Client; rendererId: number };
type Pending = {
  client: Client;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

// Translate process-local renderer IDs before they enter the shared CDP controller.
export class ElectronBridge {
  private readonly clients = new Set<Client>();
  private readonly sockets = new Set<WebSocket>();
  private readonly routes = new Map<number, Route>();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private nextTabId = 1;
  private sequence = 0;
  private nextDownloadId = 1;
  private readonly downloadRoutes = new Map<number, { client: Client; nativeId: number }>();

  private constructor(
    private readonly server: WebSocketServer,
    private readonly host: string,
    private readonly port: number,
    private readonly token: string,
  ) {
    server.on("connection", (socket, request) => this.accept(socket, request.url));
  }

  static async listen(host: string, port: number, token: string) {
    const server = new WebSocketServer({ host, port });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => { server.off("error", reject); resolve(); });
    });
    return new ElectronBridge(server, host, port, token);
  }

  status(extensionDirectory: string) {
    return { connected: this.clients.size > 0, bridgeUrl: `ws://${this.host}:${this.port}`, extensionDirectory };
  }

  onEvent(listener: (event: BridgeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (method === "downloads.list") {
      const groups = await Promise.all([...this.clients].map(async client => {
        const downloads = await this.send(client, method, params, timeoutMs) as BrowserDownload[];
        return downloads.map(download => this.mapDownload(client, download));
      }));
      return groups.flat() as T;
    }
    if (method === "downloads.cancel") {
      const route = this.downloadRoutes.get(Number(params.id));
      if (!route || !this.clients.has(route.client)) throw new Error("Electron download is unavailable.");
      const result = await this.send(route.client, method, { id: route.nativeId }, timeoutMs) as BrowserDownload | null;
      return (result ? this.mapDownload(route.client, result) : null) as T;
    }
    if (method === "tabs.list") {
      const groups = await Promise.all([...this.clients].map(async (client) => {
        const tabs = await this.send(client, method, params, timeoutMs) as BrowserTab[];
        return tabs.map((tab) => this.mapTab(client, tab));
      }));
      return groups.flat() as T;
    }
    const route = this.routes.get(Number(params.tabId));
    if (!route || !this.clients.has(route.client)) {
      throw new Error("The selected Electron renderer is unavailable. List targets and claim a live renderer. The target was not switched.");
    }
    if (method === "overlay.show") {
      const [source, cursor] = await Promise.all([
        readFile(new URL("../browser-extension/control-overlay.js", import.meta.url), "utf8"),
        readFile(new URL("../browser-extension/cursor.svg", import.meta.url), "base64"),
      ]);
      params = { ...params, source, cursorUrl: `data:image/svg+xml;base64,${cursor}` };
    }
    const result = await this.send(route.client, method, { ...params, tabId: route.rendererId }, timeoutMs);
    return (method.startsWith("tabs.") && method !== "tabs.close"
      ? this.mapTab(route.client, result as BrowserTab)
      : result) as T;
  }

  private send(client: Client, method: string, params: Record<string, unknown>, timeoutMs: number) {
    if (client.socket.readyState !== WebSocket.OPEN) throw new Error("The selected Electron process disconnected.");
    const id = `electron_${++this.sequence}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Electron bridge request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { client, resolve, reject, timer });
      client.socket.send(JSON.stringify({ type: "request", id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private mapId(client: Client, rendererId: number) {
    let id = client.tabs.get(rendererId);
    if (id === undefined) {
      id = this.nextTabId++;
      client.tabs.set(rendererId, id);
      this.routes.set(id, { client, rendererId });
    }
    return id;
  }

  private mapTab(client: Client, tab: BrowserTab): BrowserTab {
    return {
      ...tab,
      id: this.mapId(client, tab.id),
      rendererId: tab.id,
      processId: client.processId,
      appName: client.appName,
      ...(tab.openerTabId !== undefined ? { openerTabId: this.mapId(client, tab.openerTabId) } : {}),
    };
  }

  private mapDownload(client: Client, download: BrowserDownload): BrowserDownload {
    let id = client.downloads.get(download.id);
    if (id === undefined) {
      id = this.nextDownloadId++;
      client.downloads.set(download.id, id);
      this.downloadRoutes.set(id, { client, nativeId: download.id });
    }
    return { ...download, id, ...(download.tabId !== undefined ? { tabId: this.mapId(client, download.tabId) } : {}) };
  }

  private emit(event: BridgeEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private accept(socket: WebSocket, rawUrl: string | undefined) {
    let candidate: string | null;
    try { candidate = new URL(rawUrl ?? "/", `ws://${this.host}:${this.port}`).searchParams.get("token"); }
    catch { socket.close(1008, "unauthorized"); return; }
    if (!candidate || Buffer.byteLength(candidate) !== Buffer.byteLength(this.token) ||
        !timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token))) {
      socket.close(1008, "unauthorized");
      return;
    }
    this.sockets.add(socket);
    let client: Client | undefined;
    const handshakeTimer = setTimeout(() => socket.close(1008, "hello required"), 5_000);
    handshakeTimer.unref();
    socket.on("error", () => undefined);
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (!message || typeof message !== "object") return;
      if (!client) {
        if (message.type !== "hello" || message.protocolVersion !== 1 || message.clientKind !== "electron" ||
            typeof message.processId !== "number" || !Number.isSafeInteger(message.processId) || message.processId < 1 ||
            typeof message.appName !== "string") {
          socket.close(1002, "incompatible Electron protocol");
          return;
        }
        // Reconnects cannot inherit old claims or IDs, even within the same process.
        for (const previous of this.clients) {
          if (previous.processId === message.processId) previous.socket.terminate();
        }
        client = { socket, processId: message.processId, appName: message.appName, tabs: new Map(), downloads: new Map() };
        this.clients.add(client);
        clearTimeout(handshakeTimer);
        return;
      }
      if (message.type === "response" && typeof message.id === "string") {
        const pending = this.pending.get(message.id);
        if (!pending || pending.client !== client) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok === true) pending.resolve(message.result);
        else {
          const error = message.error as { message?: string } | undefined;
          pending.reject(new Error(error?.message ?? "Electron bridge request failed."));
        }
      } else if (message.type === "event" && typeof message.tabId === "number") {
        const event = message as unknown as BridgeEvent;
        const tabId = this.mapId(client, message.tabId);
        this.emit({ ...event, tabId, ...(event.tab ? { tab: this.mapTab(client, event.tab) } : {}), ...(event.download ? { download: this.mapDownload(client, event.download) } : {}) });
        if (event.event === "tabRemoved") {
          client.tabs.delete(message.tabId);
          this.routes.delete(tabId);
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      this.sockets.delete(socket);
      if (!client) return;
      this.clients.delete(client);
      for (const [id, pending] of this.pending) {
        if (pending.client !== client) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error("The selected Electron process disconnected."));
        this.pending.delete(id);
      }
      for (const id of client.downloads.values()) this.downloadRoutes.delete(id);
      for (const id of client.tabs.values()) {
        this.routes.delete(id);
        this.emit({ type: "event", event: "tabRemoved", tabId: id });
      }
    });
  }
}
