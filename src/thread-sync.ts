import { randomBytes, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, RequestHandler, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseConversationUrl } from "./chatgpt-support.js";
export { parseConversationUrl } from "./chatgpt-support.js";

export const THREAD_SYNC_WIDGET_URI = "ui://local-codex/thread-sync-v2.html";
export const THREAD_SYNC_AGENT_INSTRUCTION = "When the user asks for the current ChatGPT thread URL, conversation URL, or thread ID, always use this exact sequence: first call sync_current_thread, then call get_current_thread_url. Run sync_current_thread first even if the thread may already be synced; it is idempotent. get_current_thread_url is the only source of the URL. Do not infer, construct, or obtain the current thread URL with browser tools or any other tool.";
const TICKET_TTL_MS = 30 * 60 * 1000;
const MAX_RECORDS = 2_000;
const BROWSER_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
]);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const identitySchema = z.object({ ownerId: z.string(), sessionId: z.string().min(1).max(2048) });
const ticketSchema = identitySchema.extend({
  token: tokenSchema,
  expiresAt: z.number(),
  consumed: z.boolean().optional(),
});
const bindingSchema = identitySchema.extend({
  threadId: z.string(),
  conversationUrl: z.string(),
  boundAt: z.string(),
});
const storeSchema = z.object({
  version: z.literal(1),
  tickets: z.array(ticketSchema).max(MAX_RECORDS),
  bindings: z.array(bindingSchema).max(MAX_RECORDS),
});
type Identity = z.infer<typeof identitySchema>;
type Store = z.infer<typeof storeSchema>;

/** One queue owns both token issuance and binding, including the atomic file write. */
export class ThreadSyncRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly filePath: string, private state: Store) {}

  static async open(dataDirectory: string) {
    await mkdir(dataDirectory, { recursive: true });
    const filePath = path.join(dataDirectory, "thread-sync.json");
    let state: Store = { version: 1, tickets: [], bindings: [] };
    try {
      state = storeSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return new ThreadSyncRegistry(filePath, state);
  }

  async context(identity: Identity) {
    identitySchema.parse(identity);
    return this.update((state) => {
      const binding = state.bindings.find((entry) => sameIdentity(entry, identity));
      let ticket = state.tickets.find((entry) => sameIdentity(entry, identity));
      if (binding && ticket?.consumed !== false) {
        state.tickets = state.tickets.filter((entry) => !sameIdentity(entry, identity));
        ticket = undefined;
      }
      if (!ticket) {
        if (state.tickets.length >= MAX_RECORDS) throw new Error("Too many pending thread registrations.");
        ticket = {
          ...identity,
          token: randomBytes(32).toString("base64url"),
          expiresAt: Date.now() + TICKET_TTL_MS,
          consumed: false,
        };
        state.tickets.push(ticket);
      }
      const publicTicket = { token: ticket.token, expiresAt: ticket.expiresAt };
      return binding
        ? { status: "connected" as const, ...publicBinding(binding), ticket: publicTicket }
        : { status: "syncing" as const, ticket: publicTicket };
    });
  }

  async bind(token: string, conversationUrl: string) {
    tokenSchema.parse(token);
    const conversation = parseConversationUrl(conversationUrl);
    return this.update((state) => {
      const ticket = state.tickets.find((entry) => entry.token === token);
      if (!ticket) throw new Error("Binding token is unknown or expired.");
      ticket.consumed = true;
      const existing = state.bindings.find((entry) => sameIdentity(entry, ticket));
      if (existing) {
        if (existing.threadId !== conversation.threadId) {
          throw new Error("This session is already bound to a different conversation. Refusing to rebind.");
        }
        existing.conversationUrl = conversation.conversationUrl;
        existing.boundAt = new Date().toISOString();
        return publicBinding(existing);
      }
      if (state.bindings.some((entry) => entry.ownerId === ticket.ownerId && entry.threadId === conversation.threadId)) {
        throw new Error("This conversation is already bound to a different session. Refusing to guess.");
      }
      if (state.bindings.length >= MAX_RECORDS) throw new Error("Thread registration limit reached.");
      const binding = {
        ownerId: ticket.ownerId,
        sessionId: ticket.sessionId,
        ...conversation,
        boundAt: new Date().toISOString(),
      };
      state.bindings.push(binding);
      return publicBinding(binding);
    });
  }

  async binding(identity: Identity) {
    identitySchema.parse(identity);
    await this.queue;
    const binding = this.state.bindings.find((entry) => sameIdentity(entry, identity));
    return binding ? publicBinding(binding) : undefined;
  }

  async allBindings() {
    await this.queue;
    return this.state.bindings.map(publicBinding);
  }

  async waitForBinding(identity: Identity, timeoutMs = 8000) {
    identitySchema.parse(identity);
    const deadline = Date.now() + timeoutMs;
    do {
      await this.queue;
      const binding = this.state.bindings.find((entry) => sameIdentity(entry, identity));
      const ticket = this.state.tickets.find((entry) => sameIdentity(entry, identity));
      const refreshPending = Boolean(ticket && ticket.expiresAt > Date.now() && ticket.consumed === false);
      if (binding && !refreshPending) return publicBinding(binding);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return undefined;
  }

  private update<T>(operation: (state: Store) => T): Promise<T> {
    const result = this.queue.then(async () => {
      const next = structuredClone(this.state);
      next.tickets = next.tickets.filter((ticket) => ticket.expiresAt > Date.now());
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

function sameIdentity(left: Identity, right: Identity) {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId;
}

function publicBinding(binding: z.infer<typeof bindingSchema>) {
  return { threadId: binding.threadId, conversationUrl: binding.conversationUrl, boundAt: binding.boundAt };
}

export function threadSyncBindUrl(port = 6002) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("THREAD_SYNC_PORT must be an integer between 1 and 65535.");
  }
  // Fetch rejects these before connecting, even for loopback extensions.
  // https://fetch.spec.whatwg.org/#port-blocking
  if (BROWSER_BLOCKED_PORTS.has(port)) {
    throw new Error(`THREAD_SYNC_PORT ${port} is blocked by browsers. Use 6002 or another browser-safe port.`);
  }
  return `http://127.0.0.1:${port}/thread-sync/bind`;
}

export async function prepareThreadSync(dataDirectory: string, port = 6002) {
  const bindUrl = threadSyncBindUrl(port);
  const registry = await ThreadSyncRegistry.open(dataDirectory);
  const tokenPath = path.join(dataDirectory, "support-extension-token");
  const legacyTokenPath = path.join(dataDirectory, "thread-sync-extension-token");
  let extensionToken: string;
  try {
    extensionToken = tokenSchema.parse((await readFile(tokenPath, "utf8")).trim());
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    try {
      extensionToken = tokenSchema.parse((await readFile(legacyTokenPath, "utf8")).trim());
      await rename(legacyTokenPath, tokenPath);
    } catch (legacyError) {
      if (!(legacyError instanceof Error && "code" in legacyError && legacyError.code === "ENOENT")) throw legacyError;
      extensionToken = randomBytes(32).toString("base64url");
      await writeFile(tokenPath, `${extensionToken}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  }
  const sourceDirectory = fileURLToPath(new URL("../support-extension/", import.meta.url));
  const extensionDirectory = path.resolve(dataDirectory, "support-extension");
  const legacyExtensionDirectory = path.resolve(dataDirectory, "thread-sync-extension");
  await rm(legacyExtensionDirectory, { recursive: true, force: true });
  await mkdir(extensionDirectory, { recursive: true });
  await Promise.all(["manifest.json", "content-script.js", "service-worker.js", "popup.html", "popup.js", "popup.css"].map((file) =>
    copyFile(path.join(sourceDirectory, file), path.join(extensionDirectory, file)),
  ));
  await writeFile(path.join(extensionDirectory, "config.js"),
    `globalThis.LOCAL_CODEX_THREAD_SYNC = ${JSON.stringify({
      bindUrl,
      commandClaimUrl: bindUrl.replace("/thread-sync/bind", "/chatgpt-support/commands/claim"),
      commandResultUrl: bindUrl.replace("/thread-sync/bind", "/chatgpt-support/commands/result"),
      ralfRegisterUrl: bindUrl.replace("/thread-sync/bind", "/chatgpt-support/ralf/register"),
      ralfProjectsUrl: bindUrl.replace("/thread-sync/bind", "/chatgpt-support/ralf/projects"),
      extensionToken,
    })};\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const widgetHtml = await readFile(new URL("../thread-sync-widget/widget.html", import.meta.url), "utf8");
  return { registry, extensionToken, extensionDirectory, widgetHtml, bindUrl };
}

function authenticateExtension(req: Request, res: Response, extensionToken: string) {
  const authorization = req.get("authorization");
  const candidate = Buffer.from(authorization?.startsWith("Bearer ") ? authorization.slice(7) : "");
  const expected = Buffer.from(extensionToken);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    res.status(401).json({ error: "Sync extension authentication failed." });
    return false;
  }
  const origin = req.get("origin");
  if (origin && !/^(?:chrome-extension|moz-extension):\/\/[A-Za-z0-9_-]+$/.test(origin)) {
    res.status(403).json({ error: "Only the sync extension may use this endpoint." });
    return false;
  }
  return true;
}

export function threadSyncBindHandler(
  registry: ThreadSyncRegistry,
  extensionToken: string,
  onBound?: (binding: { threadId: string; conversationUrl: string; boundAt: string }) => void | Promise<void>,
): RequestHandler {
  return async (req, res) => {
    // The extension credential grants only binding, never MCP/browser/terminal access.
    if (!authenticateExtension(req, res, extensionToken)) return;
    const parsed = z.object({ token: tokenSchema, conversationUrl: z.string().max(2048) }).strict().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid thread binding request." });
      return;
    }
    try {
      const binding = await registry.bind(parsed.data.token, parsed.data.conversationUrl);
      await onBound?.(binding);
      console.log(`[thread-sync] bound conversation=${JSON.stringify(binding.conversationUrl)}`);
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: "bound" });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Thread binding failed." });
    }
  };
}

export function threadSyncToolMeta() {
  return { ui: { resourceUri: THREAD_SYNC_WIDGET_URI }, "openai/outputTemplate": THREAD_SYNC_WIDGET_URI };
}

export function registerThreadSync(
  server: McpServer,
  sync: Awaited<ReturnType<typeof prepareThreadSync>>,
  ownerId: string,
) {
  server.registerResource("thread-sync-widget", THREAD_SYNC_WIDGET_URI, { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{
      uri: THREAD_SYNC_WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      text: sync.widgetHtml,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
    }],
  }));
  server.registerTool("sync_current_thread", {
    title: "Sync Current Thread",
    description: "Required step 1 for current-thread lookup. Whenever the user asks for the current ChatGPT thread URL, conversation URL, or thread ID, call this tool first, even if the thread may already be synced. Then call get_current_thread_url. This tool renders the Thread Sync UI in the chat and starts the extension handshake. It does not return the URL.",
    inputSchema: {},
    outputSchema: {
      status: z.enum(["syncing", "synced"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: threadSyncToolMeta(),
  }, async (_args, extra) => {
    const session = extra._meta?.["openai/session"];
    if (typeof session !== "string" || !session || session.length > 2048) {
      return {
        isError: true,
        content: [{ type: "text", text: "The client did not provide a valid openai/session, so the current thread URL cannot be synced." }],
      };
    }
    const context = await sync.registry.context({ ownerId, sessionId: session });
    if (context.status === "connected") {
      const structuredContent = { status: "synced" as const };
      return {
        content: [{ type: "text", text: "Refreshing the current thread binding. Now call get_current_thread_url." }],
        structuredContent,
        _meta: { "local-codex/thread-binding": context.ticket },
      };
    }
    const structuredContent = { status: context.status };
    return {
      content: [{ type: "text", text: "Thread Sync UI is connecting this conversation. Now call get_current_thread_url. Do not use another tool to obtain the current thread URL." }],
      structuredContent,
      _meta: { "local-codex/thread-binding": context.ticket },
    };
  });
  server.registerTool("get_current_thread_url", {
    title: "Get Current Thread URL",
    description: "Required step 2 for current-thread lookup. Call sync_current_thread first in the same request, then call this tool. It waits briefly for the Thread Sync UI and extension handshake and returns the exact ChatGPT conversation URL. This is the only tool that returns the current thread URL; do not infer or construct it elsewhere.",
    inputSchema: {},
    outputSchema: { conversationUrl: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (_args, extra) => {
    const session = extra._meta?.["openai/session"];
    if (typeof session !== "string" || !session || session.length > 2048) {
      return {
        isError: true,
        content: [{ type: "text", text: "The client did not provide a valid openai/session, so the current thread URL is unavailable." }],
      };
    }
    const binding = await sync.registry.waitForBinding({ ownerId, sessionId: session });
    if (!binding) {
      return {
        isError: true,
        content: [{ type: "text", text: "Thread Sync did not finish in time. Call sync_current_thread again, then call get_current_thread_url again. Do not use another tool to guess the URL." }],
      };
    }
    const structuredContent = { conversationUrl: binding.conversationUrl };
    return {
      content: [{ type: "text", text: binding.conversationUrl }],
      structuredContent,
    };
  });
}
