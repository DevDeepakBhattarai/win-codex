import "dotenv/config";

import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import {
  createTerminalInvocation,
  formatPlatformName,
  shouldCreateTerminalProcessGroup,
  terminalSignalTarget,
} from "./terminal.js";

const PORT = Number(process.env.PORT ?? 6000);
const HOST = process.env.HOST ?? "localhost";
const PUBLIC_BASE_URL = stripTrailingSlash(
  process.env.PUBLIC_BASE_URL ?? `http://${HOST}:${PORT}`,
);
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? `${PUBLIC_BASE_URL}/mcp`;
const AUTH_ISSUER = stripTrailingSlash(
  process.env.AUTH_ISSUER ?? PUBLIC_BASE_URL,
);
const REQUIRED_SCOPE = process.env.REQUIRED_SCOPE ?? "mcp:control";
const HOST_PLATFORM = process.platform;
const HOST_PLATFORM_NAME = formatPlatformName(HOST_PLATFORM);
const POWERSHELL_EXECUTABLE = resolvePowerShellExecutable(
  HOST_PLATFORM,
  process.env.POWERSHELL_EXECUTABLE,
);
const TERMINAL_EXECUTABLE = process.env.TERMINAL_EXECUTABLE;
const TERMINAL_SHELL = createTerminalInvocation({
  platform: HOST_PLATFORM,
  command: "",
  configuredExecutable: TERMINAL_EXECUTABLE,
  powerShellExecutable: POWERSHELL_EXECUTABLE,
}).shell;
const CONSENT_PIN_LENGTH = 6;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CHATGPT_FILE_BYTES = boundedIntegerEnv(
  "MAX_CHATGPT_FILE_BYTES",
  100 * 1024 * 1024,
  1024,
  1024 * 1024 * 1024,
);
const CHATGPT_FILE_DOWNLOAD_TIMEOUT_MS = boundedIntegerEnv(
  "CHATGPT_FILE_DOWNLOAD_TIMEOUT_MS",
  60_000,
  1_000,
  10 * 60_000,
);
const MAX_CHATGPT_FILE_REDIRECTS = 5;
const SERVER_NAME = "local-codex";
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
const OAUTH_STORE_PATH = path.resolve(
  process.env.OAUTH_STORE_PATH ?? path.join(DATA_DIR, "oauth-store.json"),
);
const ACCESS_TOKEN_TTL_SECONDS = boundedIntegerEnv(
  "ACCESS_TOKEN_TTL_SECONDS",
  10 * 60,
  60,
  60 * 60,
);
const CLOCK_TOLERANCE_SECONDS = 30;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const AUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const REFRESH_ROTATION_GRACE_SECONDS = boundedIntegerEnv(
  "REFRESH_ROTATION_GRACE_SECONDS",
  60,
  10,
  5 * 60,
);
const MAX_REFRESH_TOKENS_PER_GRANT = boundedIntegerEnv(
  "MAX_REFRESH_TOKENS_PER_GRANT",
  64,
  2,
  256,
);
const MAX_USED_REFRESH_TOKENS_PER_GRANT = Math.max(
  64,
  MAX_REFRESH_TOKENS_PER_GRANT * 4,
);
const MAX_OAUTH_CLIENTS = boundedIntegerEnv("MAX_OAUTH_CLIENTS", 20, 1, 1000);
const ALLOWED_REDIRECT_ORIGINS = new Set(
  parseCsvEnv("ALLOWED_REDIRECT_ORIGINS", ["https://chatgpt.com"]),
);
const ALLOWED_REDIRECT_URIS = new Set(
  parseCsvEnv("ALLOWED_REDIRECT_URIS", []).map((value) =>
    new URL(value).toString(),
  ),
);
const REQUIRE_EXACT_REDIRECT_URIS =
  process.env.REQUIRE_EXACT_REDIRECT_URIS !== "false";
const CORS_ALLOWED_ORIGINS = new Set(
  parseCsvEnv("CORS_ALLOWED_ORIGINS", [
    "https://chatgpt.com",
    "https://chat.openai.com",
  ]),
);

type OAuthClient = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  scope: string;
  issuedAt: number;
  tokenEndpointAuthMethod: "none";
};

type AuthorizationCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  sub: string;
  expiresAt: number;
};

type AuthorizationTransaction = {
  transactionId: string;
  request: z.infer<typeof authorizeRequestSchema>;
  clientId: string;
  consentPin: string;
  expiresAt: number;
  redirectedTo?: string;
};

type UsedRefreshToken = {
  hash: string;
  validUntil: number;
};

type OAuthGrant = {
  grantId: string;
  clientId: string;
  scope: string;
  resource: string;
  sub: string;
  issuedAt: number;
  refreshTokenHash: string;
  parallelRefreshTokenHashes?: string[];
  usedRefreshTokens?: UsedRefreshToken[];
  // Legacy fields retained so existing version-1 stores migrate without reconnecting.
  previousRefreshTokenHash?: string;
  previousRefreshTokenValidUntil?: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

type OAuthStore = {
  version: 1;
  privateJwk: JWK;
  publicJwk: JWK;
  clients: OAuthClient[];
  grants: OAuthGrant[];
  updatedAt: number;
};

type AuthContext = {
  clientId: string;
  grantId: string;
  subject?: string;
};

type AuthedRequest = Request & {
  auth?: AuthInfo;
  authContext?: AuthContext;
};

const clients = new Map<string, OAuthClient>();
const codes = new Map<string, AuthorizationCode>();
const authorizationTransactions = new Map<string, AuthorizationTransaction>();
const grants = new Map<string, OAuthGrant>();
const refreshTokenIndex = new Map<string, string>();
let signingKey: JWK;
let publicJwks: { keys: JWK[] };
let localJwks: ReturnType<typeof createLocalJWKSet>;
let authStoreMtimeMs = 0;
let lastAuthStoreCheckAt = 0;
let authStoreWriteQueue: Promise<void> = Promise.resolve();
let refreshTokenQueue: Promise<void> = Promise.resolve();

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  if (new URL(PUBLIC_BASE_URL).protocol === "https:") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  if (req.path.startsWith("/oauth/")) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || CORS_ALLOWED_ORIGINS.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    exposedHeaders: ["WWW-Authenticate"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Mcp-Protocol-Version",
      "Mcp-Session-Id",
    ],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);
app.use("/mcp", createRateLimiter("mcp-ingress", 15 * 60 * 1000, 3000));
app.use(
  express.json({
    type: ["application/json", "application/*+json"],
    limit: "6mb",
  }),
);
app.use(
  express.urlencoded({
    extended: false,
    limit: "64kb",
    parameterLimit: 50,
  }),
);

const registrationRateLimit = createRateLimiter("oauth-register", 60 * 60 * 1000, 10);
const authorizePageRateLimit = createRateLimiter("oauth-authorize-get", 15 * 60 * 1000, 120);
const authorizeSubmitRateLimit = createRateLimiter("oauth-authorize-post", 15 * 60 * 1000, 10);
const tokenRateLimit = createRateLimiter("oauth-token", 15 * 60 * 1000, 120);
const revokeRateLimit = createRateLimiter("oauth-revoke", 15 * 60 * 1000, 120);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: SERVER_NAME,
    mcp: MCP_PUBLIC_URL,
    issuer: AUTH_ISSUER,
    transportMode: "stateless",
    authentication: "oauth2-bearer",
    platform: HOST_PLATFORM,
    platformName: HOST_PLATFORM_NAME,
    terminalShell: TERMINAL_SHELL,
  });
});

app.get(
  [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ],
  (_req, res) => {
    res.json(protectedResourceMetadata());
  },
);

app.get(
  [
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
  ],
  (_req, res) => {
    res.json(authorizationServerMetadata());
  },
);

app.get("/oauth/jwks", (_req, res) => {
  res.json(publicJwks);
});

app.post("/oauth/register", registrationRateLimit, async (req, res) => {
  await reloadAuthStoreIfChanged();

  const parsed = dcrRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_client_metadata",
      error_description: parsed.error.message,
    });
  }

  const tokenAuthMethod =
    parsed.data.token_endpoint_auth_method === undefined
      ? "none"
      : parsed.data.token_endpoint_auth_method;

  if (tokenAuthMethod !== "none") {
    return res.status(400).json({
      error: "invalid_client_metadata",
      error_description:
        "This local development server supports public OAuth clients only.",
    });
  }

  const scope = normalizeScope(parsed.data.scope ?? REQUIRED_SCOPE);
  const existingClient = [...clients.values()].find(
    (candidate) =>
      candidate.clientName === parsed.data.client_name &&
      candidate.scope === scope &&
      arraysEqual(candidate.redirectUris, parsed.data.redirect_uris),
  );

  if (existingClient) {
    return res.status(200).json(clientResponse(existingClient));
  }

  if (clients.size >= MAX_OAUTH_CLIENTS) {
    return res.status(429).json({
      error: "invalid_client_metadata",
      error_description: "The local OAuth client registration limit has been reached.",
    });
  }

  const client: OAuthClient = {
    clientId: `local_${randomId(24)}`,
    clientName: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
    scope,
    issuedAt: Math.floor(Date.now() / 1000),
    tokenEndpointAuthMethod: "none",
  };

  clients.set(client.clientId, client);
  await persistAuthStore();

  return res.status(201).json(clientResponse(client));
});

app.get("/oauth/authorize", authorizePageRateLimit, async (req, res) => {
  const requestId = logOAuthResponse("/oauth/authorize", req, res);
  await reloadAuthStoreIfChanged();

  const parsed = authorizeRequestSchema.safeParse(req.query);

  if (!parsed.success) {
    return res
      .status(400)
      .send(renderErrorPage("Invalid authorization request"));
  }

  const client = clients.get(parsed.data.client_id);

  if (!client || !client.redirectUris.includes(parsed.data.redirect_uri)) {
    return res
      .status(400)
      .send(renderErrorPage("Invalid OAuth client or redirect URI"));
  }

  const validationError = validateAuthorizeRequest(parsed.data, client);

  if (validationError) {
    return redirectOAuthError(
      parsed.data.redirect_uri,
      parsed.data.state,
      validationError,
      res,
    );
  }

  const transactionId = `oat_${randomId(32)}`;
  const consentPin = generateConsentPin();
  authorizationTransactions.set(transactionId, {
    transactionId,
    request: parsed.data,
    clientId: client.clientId,
    consentPin,
    expiresAt: Date.now() + AUTH_TRANSACTION_TTL_MS,
  });

  const clientLabel = client.clientName ?? parsed.data.client_id;
  console.log(
    `\n========================================\n` +
    `  OAUTH CONSENT PIN: ${consentPin}\n` +
    `  Client: ${clientLabel}\n` +
    `  Expires in: ${Math.round(AUTH_TRANSACTION_TTL_MS / 60000)} minutes\n` +
    `========================================\n`,
  );
  console.log(
    `[oauth/authorize] ${requestId} rendered consent for transaction ${transactionId.slice(0, 12)}...`,
  );

  return res
    .type("html")
    .send(renderConsentPage(parsed.data, client, transactionId));
});

app.post("/oauth/authorize", authorizeSubmitRateLimit, async (req, res) => {
  const requestId = logOAuthResponse("/oauth/authorize", req, res);
  await reloadAuthStoreIfChanged();

  const parsed = consentSubmissionSchema.safeParse(req.body);

  if (!parsed.success) {
    console.warn("[oauth/authorize POST] Invalid form body:", parsed.error.message);
    return res
      .status(400)
      .send(renderErrorPage("Invalid authorization submission"));
  }

  const transaction = authorizationTransactions.get(parsed.data.auth_tx);

  if (!transaction) {
    console.warn("[oauth/authorize POST] Transaction not found:", parsed.data.auth_tx.slice(0, 12) + "...");
    return res
      .status(400)
      .send(renderErrorPage("Authorization request expired. Start the connection again."));
  }

  if (transaction.expiresAt < Date.now()) {
    console.warn("[oauth/authorize POST] Transaction expired:", transaction.transactionId.slice(0, 12) + "...");
    authorizationTransactions.delete(transaction.transactionId);
    return res
      .status(400)
      .send(renderErrorPage("Authorization request expired. Start the connection again."));
  }

  // If this transaction was already successfully processed (double-click),
  // render the same completion page instead of showing an error.
  if (transaction.redirectedTo) {
    console.log("[oauth/authorize POST] Duplicate submission detected; re-rendering callback completion.");
    return sendAuthorizationCallback(res, transaction.redirectedTo);
  }

  const client = clients.get(transaction.clientId);
  const request = transaction.request;

  if (!client || !client.redirectUris.includes(request.redirect_uri)) {
    authorizationTransactions.delete(transaction.transactionId);
    return res
      .status(400)
      .send(renderErrorPage("OAuth client is no longer available"));
  }

  if (parsed.data.action === "deny") {
    authorizationTransactions.delete(transaction.transactionId);
    return redirectOAuthError(
      request.redirect_uri,
      request.state,
      "access_denied",
      res,
    );
  }

  if (!verifyConsentPin(parsed.data.consent_pin, transaction.consentPin)) {
    console.warn("[oauth/authorize POST] Invalid consent PIN entered.");
    return res
      .status(403)
      .type("html")
      .send(
        renderConsentPage(
          request,
          client,
          transaction.transactionId,
          "Invalid consent PIN",
        ),
      );
  }

  const scope = normalizeScope(request.scope ?? client.scope ?? REQUIRED_SCOPE);
  const code = randomId(32);

  codes.set(code, {
    code,
    clientId: request.client_id,
    redirectUri: request.redirect_uri,
    scope,
    resource: request.resource ?? MCP_PUBLIC_URL,
    codeChallenge: request.code_challenge,
    sub: "local-dev-user",
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  const redirectUrl = new URL(request.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (request.state) redirectUrl.searchParams.set("state", request.state);

  // Keep the transaction around briefly so duplicate POSTs re-redirect
  // instead of showing "expired". It will be cleaned up by cleanupEphemeralState.
  transaction.redirectedTo = redirectUrl.toString();
  transaction.expiresAt = Date.now() + 60_000;

  console.log(
    `[oauth/authorize] ${requestId} approved transaction ${transaction.transactionId.slice(0, 12)}...; rendering callback completion.`,
  );
  return sendAuthorizationCallback(res, redirectUrl.toString());
});

app.post("/oauth/token", tokenRateLimit, async (req, res) => {
  logOAuthResponse("/oauth/token", req, res);
  await reloadAuthStoreIfChanged();

  const parsed = tokenRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: parsed.error.message,
    });
  }

  if (parsed.data.grant_type === "refresh_token") {
    const refreshRequest = parsed.data;
    return withRefreshTokenLock(async () => {
      const lookup = findGrantByRefreshToken(refreshRequest.refresh_token);
      const grant = lookup?.grant;
      const client = clients.get(refreshRequest.client_id);
      const resource = refreshRequest.resource ?? grant?.resource;
      const requestedScope = refreshRequest.scope
        ? normalizeScope(refreshRequest.scope)
        : grant?.scope;
      const now = Math.floor(Date.now() / 1000);

      if (
        !lookup ||
        !grant ||
        !client ||
        !isGrantUsable(grant) ||
        grant.clientId !== client.clientId ||
        resource !== grant.resource ||
        resource !== MCP_PUBLIC_URL ||
        requestedScope !== grant.scope
      ) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Refresh token is invalid or revoked.",
        });
      }

      if (lookup.match === "used" && lookup.validUntil < now) {
        grant.revokedAt = now;
        await persistAuthStore();
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Refresh token reuse was detected; reconnect this client.",
        });
      }

      if (
        lookup.match === "used" &&
        activeRefreshTokenCount(grant) >= MAX_REFRESH_TOKENS_PER_GRANT
      ) {
        return res.status(429).json({
          error: "temporarily_unavailable",
          error_description:
            "Too many parallel refresh-token branches are active for this grant.",
        });
      }

      const refreshToken = `lrt_${randomId(48)}`;
      rotateRefreshToken(
        grant,
        lookup.hash,
        lookup.match,
        refreshToken,
        now,
      );
      grant.lastUsedAt = now;
      await persistAuthStore();

      return res.json({
        access_token: await issueAccessToken(client, grant),
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
        scope: grant.scope,
      });
    });
  }

  const code = codes.get(parsed.data.code);

  if (!code || code.expiresAt < Date.now()) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Authorization code is invalid or expired.",
    });
  }

  const client = clients.get(parsed.data.client_id);
  const expectedChallenge = pkceS256(parsed.data.code_verifier);
  const resource = parsed.data.resource ?? code.resource;

  if (
    !client ||
    parsed.data.redirect_uri !== code.redirectUri ||
    parsed.data.client_id !== code.clientId ||
    expectedChallenge !== code.codeChallenge ||
    resource !== code.resource ||
    resource !== MCP_PUBLIC_URL
  ) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Authorization code validation failed.",
    });
  }

  codes.delete(parsed.data.code);

  const refreshToken = `lrt_${randomId(48)}`;
  const now = Math.floor(Date.now() / 1000);
  const grant: OAuthGrant = {
    grantId: `grant_${randomId(18)}`,
    clientId: client.clientId,
    scope: code.scope,
    resource,
    sub: code.sub,
    issuedAt: now,
    refreshTokenHash: tokenHash(refreshToken),
  };

  grants.set(grant.grantId, grant);
  refreshTokenIndex.set(grant.refreshTokenHash, grant.grantId);
  await persistAuthStore();

  return res.json({
    access_token: await issueAccessToken(client, grant),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: code.scope,
  });
});

app.post("/oauth/revoke", revokeRateLimit, async (req, res) => {
  await reloadAuthStoreIfChanged();

  const parsed = revocationRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: parsed.error.message,
    });
  }

  await revokeToken(parsed.data.token, parsed.data.client_id);
  return res.status(200).send("");
});

app.post("/mcp", requireOAuth, async (req: AuthedRequest, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  let cleanupStarted = false;
  const cleanup = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void Promise.allSettled([transport.close(), server.close()]);
  };

  res.once("finish", cleanup);
  res.once("close", cleanup);

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireOAuth, (_req: AuthedRequest, res: Response) => {
  return methodNotAllowed(res);
});

app.delete("/mcp", requireOAuth, (_req: AuthedRequest, res: Response) => {
  return methodNotAllowed(res);
});

function methodNotAllowed(res: Response) {
  res.setHeader("Allow", "POST");
  return res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. This MCP endpoint uses authenticated stateless POST requests.",
    },
    id: null,
  });
}

app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const status =
      error instanceof Error && "status" in error
        ? Number((error as Error & { status?: number }).status)
        : 500;
    const responseStatus = Number.isInteger(status) && status >= 400 && status < 600
      ? status
      : 500;

    if (responseStatus >= 500) {
      console.error("Unhandled request error:", error);
    }

    res.status(responseStatus).json({
      error: responseStatus === 413 ? "payload_too_large" : "request_failed",
    });
  },
);

const redirectUriSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isAllowedRedirectUri, "Redirect URI is not allowed.");

const dcrRequestSchema = z.object({
  redirect_uris: z.array(redirectUriSchema).min(1).max(5),
  client_name: z.string().min(1).max(100).optional(),
  scope: z.string().max(512).optional(),
  grant_types: z.array(z.string().max(64)).max(5).optional(),
  response_types: z.array(z.string().max(64)).max(5).optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
});

const authorizeRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(256),
  redirect_uri: redirectUriSchema,
  code_challenge: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(2048).optional(),
  scope: z.string().max(512).optional(),
  resource: z.string().url().max(2048).optional(),
});

const consentSubmissionSchema = z.object({
  auth_tx: z.string().min(1).max(256),
  consent_pin: z.string().max(256).optional(),
  action: z.enum(["authorize", "deny"]).default("authorize"),
});

const authorizationCodeTokenRequestSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  client_id: z.string().min(1),
  code_verifier: z.string().min(43),
  resource: z.string().url().optional(),
});

const refreshTokenRequestSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
});

const tokenRequestSchema = z.discriminatedUnion("grant_type", [
  authorizationCodeTokenRequestSchema,
  refreshTokenRequestSchema,
]);

const revocationRequestSchema = z.object({
  token: z.string().min(1).max(8192),
  token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
  client_id: z.string().max(256).optional(),
});

const oauthClientStoreSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string().optional(),
  redirectUris: z.array(z.string()).min(1),
  scope: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  tokenEndpointAuthMethod: z.literal("none"),
});

const oauthGrantStoreSchema = z.object({
  grantId: z.string().min(1),
  clientId: z.string().min(1),
  scope: z.string().min(1),
  resource: z.string().url(),
  sub: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  refreshTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  parallelRefreshTokenHashes: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(256)
    .optional(),
  usedRefreshTokens: z
    .array(
      z.object({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        validUntil: z.number().int().nonnegative(),
      }),
    )
    .max(1024)
    .optional(),
  previousRefreshTokenHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  previousRefreshTokenValidUntil: z.number().int().nonnegative().optional(),
  lastUsedAt: z.number().int().nonnegative().optional(),
  revokedAt: z.number().int().nonnegative().optional(),
});

const oauthStoreSchema = z.object({
  version: z.literal(1),
  privateJwk: z.record(z.string(), z.unknown()),
  publicJwk: z.record(z.string(), z.unknown()),
  clients: z.array(oauthClientStoreSchema),
  grants: z.array(oauthGrantStoreSchema),
  updatedAt: z.number().int().nonnegative(),
});

async function initializeAuthStore() {
  try {
    await loadAuthStore();
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await bootstrapKeys();
    await persistAuthStore();
  }
}

async function bootstrapKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "local-dev-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  publicJwks = { keys: [publicJwk] };
  localJwks = createLocalJWKSet(publicJwks);
  signingKey = {
    ...(await exportJWK(privateKey)),
    kid: publicJwk.kid,
    alg: "RS256",
  };
}

async function loadAuthStore() {
  return withAuthStoreLock(loadAuthStoreUnlocked);
}

async function loadAuthStoreUnlocked() {
  const rawStore = await readFile(OAUTH_STORE_PATH, "utf8");
  const parsedStore = oauthStoreSchema.safeParse(
    JSON.parse(rawStore.replace(/^\uFEFF/, "")),
  );

  if (!parsedStore.success) {
    throw new Error(
      `Invalid OAuth store at ${OAUTH_STORE_PATH}: ${parsedStore.error.message}`,
    );
  }

  const store = parsedStore.data as OAuthStore;

  clients.clear();
  grants.clear();
  refreshTokenIndex.clear();

  for (const client of store.clients ?? []) {
    clients.set(client.clientId, client);
  }

  for (const grant of store.grants ?? []) {
    normalizeGrantRefreshTokens(grant);
    grants.set(grant.grantId, grant);
    indexGrantRefreshTokens(grant);
  }

  signingKey = store.privateJwk;
  publicJwks = { keys: [store.publicJwk] };
  localJwks = createLocalJWKSet(publicJwks);
  authStoreMtimeMs = (await stat(OAUTH_STORE_PATH)).mtimeMs;
}

async function persistAuthStore() {
  const write = authStoreWriteQueue.then(
    () => persistAuthStoreNow(),
    () => persistAuthStoreNow(),
  );
  authStoreWriteQueue = write.catch(() => undefined);
  return write;
}

async function persistAuthStoreNow() {
  return withAuthStoreLock(async () => {
    await mkdir(path.dirname(OAUTH_STORE_PATH), { recursive: true });

    const store: OAuthStore = {
    version: 1,
    privateJwk: signingKey,
    publicJwk: publicJwks.keys[0],
    clients: [...clients.values()],
    grants: [...grants.values()],
    updatedAt: Math.floor(Date.now() / 1000),
  };
  const tmpPath = `${OAUTH_STORE_PATH}.${process.pid}.${randomId(8)}.tmp`;

    await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmpPath, OAUTH_STORE_PATH);
    authStoreMtimeMs = (await stat(OAUTH_STORE_PATH)).mtimeMs;
    lastAuthStoreCheckAt = Date.now();
  });
}

async function withAuthStoreLock<T>(action: () => Promise<T>) {
  const lockPath = `${OAUTH_STORE_PATH}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    let lockHandle;
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;

      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch (statError) {
        if (!isNodeError(statError, "ENOENT")) throw statError;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }

    try {
      return await action();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  throw new Error("Timed out waiting for the OAuth store lock.");
}

async function reloadAuthStoreIfChanged() {
  const now = Date.now();
  if (now - lastAuthStoreCheckAt < 1000) return;
  lastAuthStoreCheckAt = now;

  await authStoreWriteQueue;

  try {
    const storeStat = await stat(OAUTH_STORE_PATH);
    if (storeStat.mtimeMs > authStoreMtimeMs + 1) {
      await loadAuthStore();
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function isNodeError(error: unknown, code: string) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function findGrantByRefreshToken(refreshToken: string) {
  const refreshTokenHash = tokenHash(refreshToken);
  const grantId = refreshTokenIndex.get(refreshTokenHash);
  if (!grantId) return undefined;

  const grant = grants.get(grantId);
  if (!grant) return undefined;

  normalizeGrantRefreshTokens(grant);

  if (grant.refreshTokenHash === refreshTokenHash) {
    return {
      grant,
      hash: refreshTokenHash,
      match: "primary" as const,
    };
  }

  if (grant.parallelRefreshTokenHashes?.includes(refreshTokenHash)) {
    return {
      grant,
      hash: refreshTokenHash,
      match: "parallel" as const,
    };
  }

  const usedToken = grant.usedRefreshTokens?.find(
    (candidate) => candidate.hash === refreshTokenHash,
  );
  if (usedToken) {
    return {
      grant,
      hash: refreshTokenHash,
      match: "used" as const,
      validUntil: usedToken.validUntil,
    };
  }

  return undefined;
}

function rotateRefreshToken(
  grant: OAuthGrant,
  presentedHash: string,
  match: "primary" | "parallel" | "used",
  refreshToken: string,
  now: number,
) {
  normalizeGrantRefreshTokens(grant);

  const nextHash = tokenHash(refreshToken);
  if (match === "primary") {
    grant.refreshTokenHash = nextHash;
    rememberUsedRefreshToken(grant, presentedHash, now);
  } else if (match === "parallel") {
    const parallelTokens = grant.parallelRefreshTokenHashes ?? [];
    const tokenIndex = parallelTokens.indexOf(presentedHash);
    if (tokenIndex < 0) {
      throw new Error("Parallel refresh token disappeared during rotation.");
    }
    parallelTokens[tokenIndex] = nextHash;
    grant.parallelRefreshTokenHashes = parallelTokens;
    rememberUsedRefreshToken(grant, presentedHash, now);
  } else {
    grant.parallelRefreshTokenHashes = [
      ...(grant.parallelRefreshTokenHashes ?? []),
      nextHash,
    ];
  }

  refreshTokenIndex.set(nextHash, grant.grantId);
}

function normalizeGrantRefreshTokens(grant: OAuthGrant) {
  const parallelTokens = new Set(
    (grant.parallelRefreshTokenHashes ?? []).filter(
      (hash) => hash !== grant.refreshTokenHash,
    ),
  );
  grant.parallelRefreshTokenHashes = [...parallelTokens];

  const usedTokens = new Map<string, UsedRefreshToken>();
  for (const token of grant.usedRefreshTokens ?? []) {
    const existing = usedTokens.get(token.hash);
    if (!existing || token.validUntil > existing.validUntil) {
      usedTokens.set(token.hash, token);
    }
  }

  if (grant.previousRefreshTokenHash) {
    const legacyToken = {
      hash: grant.previousRefreshTokenHash,
      validUntil: grant.previousRefreshTokenValidUntil ?? 0,
    };
    const existing = usedTokens.get(legacyToken.hash);
    if (!existing || legacyToken.validUntil > existing.validUntil) {
      usedTokens.set(legacyToken.hash, legacyToken);
    }
    delete grant.previousRefreshTokenHash;
    delete grant.previousRefreshTokenValidUntil;
  }

  grant.usedRefreshTokens = [...usedTokens.values()]
    .sort((left, right) => right.validUntil - left.validUntil)
    .slice(0, MAX_USED_REFRESH_TOKENS_PER_GRANT);
}

function rememberUsedRefreshToken(
  grant: OAuthGrant,
  refreshTokenHash: string,
  now: number,
) {
  const usedTokens = (grant.usedRefreshTokens ?? []).filter(
    (token) => token.hash !== refreshTokenHash,
  );
  usedTokens.unshift({
    hash: refreshTokenHash,
    validUntil: now + REFRESH_ROTATION_GRACE_SECONDS,
  });

  const droppedTokens = usedTokens.slice(MAX_USED_REFRESH_TOKENS_PER_GRANT);
  for (const token of droppedTokens) {
    refreshTokenIndex.delete(token.hash);
  }

  grant.usedRefreshTokens = usedTokens.slice(
    0,
    MAX_USED_REFRESH_TOKENS_PER_GRANT,
  );
  refreshTokenIndex.set(refreshTokenHash, grant.grantId);
}

function activeRefreshTokenCount(grant: OAuthGrant) {
  return 1 + (grant.parallelRefreshTokenHashes?.length ?? 0);
}

function indexGrantRefreshTokens(grant: OAuthGrant) {
  refreshTokenIndex.set(grant.refreshTokenHash, grant.grantId);
  for (const hash of grant.parallelRefreshTokenHashes ?? []) {
    refreshTokenIndex.set(hash, grant.grantId);
  }
  for (const token of grant.usedRefreshTokens ?? []) {
    refreshTokenIndex.set(token.hash, grant.grantId);
  }
}

function withRefreshTokenLock<T>(action: () => Promise<T>) {
  const run = refreshTokenQueue.then(action, action);
  refreshTokenQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isGrantUsable(grant: OAuthGrant) {
  return !grant.revokedAt;
}

async function issueAccessToken(client: OAuthClient, grant: OAuthGrant) {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    scope: grant.scope,
    client_id: client.clientId,
    grant_id: grant.grantId,
  })
    .setProtectedHeader({ alg: "RS256", kid: publicJwks.keys[0].kid })
    .setIssuer(AUTH_ISSUER)
    .setSubject(grant.sub)
    .setAudience(grant.resource)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .setJti(randomId(16))
    .sign(signingKey);
}

async function revokeToken(token: string, clientId?: string) {
  let grant = findGrantByRefreshToken(token)?.grant;

  if (!grant) {
    try {
      const result = await jwtVerify(token, localJwks, {
        issuer: AUTH_ISSUER,
        audience: MCP_PUBLIC_URL,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      const grantId = result.payload.grant_id;
      if (typeof grantId === "string") grant = grants.get(grantId);
    } catch {
      return;
    }
  }

  if (!grant || grant.revokedAt) return;
  if (clientId && grant.clientId !== clientId) return;

  grant.revokedAt = Math.floor(Date.now() / 1000);
  await persistAuthStore();
}

async function requireOAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  await reloadAuthStoreIfChanged();

  const header = req.header("authorization");

  if (!header?.startsWith("Bearer ")) {
    return unauthorized(res);
  }

  const token = header.slice("Bearer ".length);

  try {
    const result = await jwtVerify(token, localJwks, {
      issuer: AUTH_ISSUER,
      audience: MCP_PUBLIC_URL,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      maxTokenAge: `${ACCESS_TOKEN_TTL_SECONDS + CLOCK_TOLERANCE_SECONDS}s`,
    });
    const payload = result.payload as JWTPayload & {
      client_id?: string;
      grant_id?: string;
      scope?: string;
    };
    const client = payload.client_id
      ? clients.get(payload.client_id)
      : undefined;
    const grant = payload.grant_id ? grants.get(payload.grant_id) : undefined;
    const scopes = String(payload.scope ?? "")
      .split(/\s+/)
      .filter(Boolean);

    if (
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      !client ||
      !grant ||
      !isGrantUsable(grant) ||
      grant.clientId !== client.clientId ||
      grant.resource !== MCP_PUBLIC_URL ||
      normalizeScope(String(payload.scope ?? "")) !== grant.scope
    ) {
      return unauthorized(res);
    }

    if (!scopes.includes(REQUIRED_SCOPE)) {
      return res.status(403).json({
        error: "forbidden",
        error_description: `Missing required scope: ${REQUIRED_SCOPE}`,
      });
    }

    req.auth = {
      token,
      clientId: client.clientId,
      scopes,
      expiresAt: payload.exp,
      resource: new URL(MCP_PUBLIC_URL),
      extra: {
        sub: payload.sub,
        grantId: grant.grantId,
      },
    };
    req.authContext = {
      clientId: client.clientId,
      grantId: grant.grantId,
      subject: payload.sub,
    };

    return next();
  } catch {
    return unauthorized(res);
  }
}

function unauthorized(res: Response) {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="mcp", resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
  );

  return res.status(401).json({
    error: "unauthorized",
  });
}


const commandResultOutputSchema = {
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
};

const terminalResultOutputSchema = {
  ...commandResultOutputSchema,
  shell: z.string(),
  platform: z.string(),
};

const textFileOutputSchema = {
  path: z.string(),
  bytesRead: z.number().int().nonnegative(),
  truncated: z.boolean(),
  content: z.string(),
};

const analyzeImageOutputSchema = {
  path: z.string(),
  bytesRead: z.number().int().nonnegative(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
};

const chatGptFileInputSchema = z
  .object({
    download_url: z.string().url(),
    file_id: z.string().min(1),
    mime_type: z.string().min(1).optional(),
    file_name: z.string().min(1).optional(),
  })
  .strict();

const saveChatGptFileOutputSchema = {
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  fileId: z.string(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
};

const writeTextFileOutputSchema = {
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
};

const directoryItemOutputSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["directory", "file", "other"]),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
});

const listDirectoryOutputSchema = {
  path: z.string(),
  truncated: z.boolean(),
  items: z.array(directoryItemOutputSchema),
};

const startProcessOutputSchema = {
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  pid: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
  timedOut: z.boolean().optional(),
  started: z.boolean(),
};

function textContentFromStructuredContent(structuredContent: Record<string, unknown>) {
  const serialized = JSON.stringify(structuredContent);
  const maximumTextBytes = 64 * 1024;
  const text =
    Buffer.byteLength(serialized, "utf8") <= maximumTextBytes
      ? serialized
      : JSON.stringify({
          summary: "The complete result is available in structuredContent.",
          fields: Object.keys(structuredContent),
        });

  return [{ type: "text" as const, text }];
}

function validateChatGptDownloadUrl(value: string) {
  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error("ChatGPT file download URLs must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("ChatGPT file download URLs must not contain credentials.");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  ) {
    throw new Error("Refusing to download a ChatGPT file from a local address.");
  }

  return url;
}

async function downloadChatGptFile(downloadUrl: string) {
  let currentUrl = validateChatGptDownloadUrl(downloadUrl);

  for (
    let redirectCount = 0;
    redirectCount <= MAX_CHATGPT_FILE_REDIRECTS;
    redirectCount += 1
  ) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(CHATGPT_FILE_DOWNLOAD_TIMEOUT_MS),
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `ChatGPT file download redirected with HTTP ${response.status} but did not include a Location header.`,
        );
      }
      if (redirectCount === MAX_CHATGPT_FILE_REDIRECTS) {
        throw new Error(
          `ChatGPT file download exceeded ${MAX_CHATGPT_FILE_REDIRECTS} redirects.`,
        );
      }

      currentUrl = validateChatGptDownloadUrl(
        new URL(location, currentUrl).toString(),
      );
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `ChatGPT file download failed with HTTP ${response.status} ${response.statusText}.`,
      );
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const declaredBytes = Number(contentLength);
      if (
        Number.isFinite(declaredBytes) &&
        declaredBytes > MAX_CHATGPT_FILE_BYTES
      ) {
        throw new Error(
          `ChatGPT file is ${declaredBytes} bytes; maximum supported size is ${MAX_CHATGPT_FILE_BYTES} bytes.`,
        );
      }
    }

    if (!response.body) {
      throw new Error("ChatGPT file download returned an empty response body.");
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        totalBytes += value.byteLength;
        if (totalBytes > MAX_CHATGPT_FILE_BYTES) {
          await reader.cancel();
          throw new Error(
            `ChatGPT file exceeded the maximum supported size of ${MAX_CHATGPT_FILE_BYTES} bytes while downloading.`,
          );
        }

        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks, totalBytes);
  }

  throw new Error("ChatGPT file download failed unexpectedly.");
}

function detectSupportedImageMimeType(buffer: Buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png" as const;
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg" as const;
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp" as const;
  }

  if (
    buffer.length >= 6 &&
    (buffer.toString("ascii", 0, 6) === "GIF87a" ||
      buffer.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return "image/gif" as const;
  }

  return undefined;
}

function createMcpServer() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: "0.1.0",
  });

  server.registerTool(
    "terminal",
    {
      title: "Run Terminal Command",
      description:
        `Run a shell command directly on this ${HOST_PLATFORM_NAME} computer using ${TERMINAL_SHELL}. Use this for all terminal and shell commands. On macOS, commands run through bash; cmd.exe and Windows-only commands are unavailable.`,
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe(`Terminal command to execute on ${HOST_PLATFORM_NAME}.`),
        cwd: z
          .string()
          .optional()
          .describe("Working directory. Defaults to the server process cwd."),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(60000)
          .default(10000)
          .describe("Timeout in milliseconds. Maximum is 60000."),
      },
      outputSchema: terminalResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ command, cwd, timeoutMs }) => {
      const result = await runTerminal({ command, cwd, timeoutMs });

      const structuredContent = {
        command,
        cwd: cwd ? path.resolve(cwd) : process.cwd(),
        shell: result.shell,
        platform: result.platformName,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      };

      return {
        content: textContentFromStructuredContent(structuredContent),
        structuredContent,
      };
    },
  );
  server.registerTool(
    "read_text_file",
    {
      title: "Read Text File",
      description: "Read a UTF-8 text file from the local machine.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute or relative file path."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(5 * 1024 * 1024)
          .default(1024 * 1024)
          .describe("Maximum bytes to return. Default 1 MiB, max 5 MiB."),
      },
      outputSchema: textFileOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: filePath, maxBytes }) => {
      const resolved = path.resolve(filePath);
      const handle = await open(resolved, "r");
      let bytesRead = 0;
      let truncated = false;
      let content = "";

      try {
        const fileStat = await handle.stat();
        const requestedBytes = Math.min(fileStat.size, maxBytes + 1);
        const buffer = Buffer.allocUnsafe(requestedBytes);
        const result = await handle.read(buffer, 0, requestedBytes, 0);
        bytesRead = Math.min(result.bytesRead, maxBytes);
        truncated = result.bytesRead > maxBytes || fileStat.size > maxBytes;
        const decoder = new TextDecoder("utf-8", { fatal: false });
        content = decoder.decode(buffer.subarray(0, bytesRead), {
          stream: truncated,
        });
      } finally {
        await handle.close();
      }

      const structuredContent = {
        path: resolved,
        bytesRead,
        truncated,
        content,
      };

      return {
        content: textContentFromStructuredContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "analyze_image",
    {
      title: "Analyze Local Image",
      description:
        "Read a local PNG, JPEG, WebP, or GIF image and return its pixels as MCP image content so the AI client can inspect it visually. Use this when the user provides a local image path and asks you to analyze, describe, or inspect the image.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute or relative image file path."),
      },
      outputSchema: analyzeImageOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) => {
      const resolved = path.resolve(filePath);
      const handle = await open(resolved, "r");
      let image: Buffer;
      let bytesRead: number;

      try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile()) {
          throw new Error(`Image path is not a regular file: ${resolved}`);
        }
        if (fileStat.size > MAX_IMAGE_BYTES) {
          throw new Error(
            `Image is ${fileStat.size} bytes; maximum supported size is ${MAX_IMAGE_BYTES} bytes.`,
          );
        }

        image = await handle.readFile();
        bytesRead = image.byteLength;
      } finally {
        await handle.close();
      }

      const mimeType = detectSupportedImageMimeType(image);
      if (!mimeType) {
        throw new Error(
          "Unsupported image format. Supported formats are PNG, JPEG, WebP, and GIF.",
        );
      }

      const structuredContent = {
        path: resolved,
        bytesRead,
        mimeType,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `Local image loaded from ${resolved}. Inspect the attached image content directly.`,
          },
          {
            type: "image" as const,
            data: image.toString("base64"),
            mimeType,
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "save_chatgpt_file",
    {
      title: "Save ChatGPT File",
      description:
        "Save a file from the current ChatGPT conversation directly to the local computer. This accepts ChatGPT file attachments, including images generated by ChatGPT, through the ChatGPT file-parameter bridge. Use it when the user asks to save, copy, or download an existing chat file to a local path. This tool does not generate the file itself.",
      inputSchema: {
        file: chatGptFileInputSchema.describe(
          "File supplied by ChatGPT. ChatGPT populates this parameter from a file in the conversation.",
        ),
        path: z
          .string()
          .min(1)
          .describe("Destination file path on the local computer."),
        createDirs: z
          .boolean()
          .default(true)
          .describe("Create parent directories when they do not exist."),
        overwrite: z
          .boolean()
          .default(true)
          .describe("Replace an existing destination file. Defaults to true."),
      },
      outputSchema: saveChatGptFileOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      _meta: {
        "openai/fileParams": ["file"],
      },
    },
    async ({ file, path: filePath, createDirs, overwrite }) => {
      const resolved = path.resolve(filePath);
      const bytes = await downloadChatGptFile(file.download_url);

      if (createDirs) {
        await mkdir(path.dirname(resolved), { recursive: true });
      }

      await writeFile(resolved, bytes, { flag: overwrite ? "w" : "wx" });

      const structuredContent = {
        path: resolved,
        bytesWritten: bytes.byteLength,
        fileId: file.file_id,
        ...(file.file_name ? { fileName: file.file_name } : {}),
        ...(file.mime_type ? { mimeType: file.mime_type } : {}),
      };

      return {
        content: textContentFromStructuredContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "write_text_file",
    {
      title: "Write Text File",
      description:
        "Create or replace a UTF-8 text file on the local machine.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute or relative file path."),
        content: z
          .string()
          .max(5 * 1024 * 1024)
          .describe("UTF-8 text content to write. Maximum 5 MiB."),
        createDirs: z
          .boolean()
          .default(true)
          .describe("Create parent directories when they do not exist."),
      },
      outputSchema: writeTextFileOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath, content, createDirs }) => {
      const resolved = path.resolve(filePath);

      if (createDirs) {
        await mkdir(path.dirname(resolved), { recursive: true });
      }

      await writeFile(resolved, content, "utf8");

      const structuredContent = {
        path: resolved,
        bytesWritten: Buffer.byteLength(content, "utf8"),
      };

      return {
        content: textContentFromStructuredContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description: "List files and folders in a local directory.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Directory path. Defaults to the server process cwd."),
        maxEntries: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(200)
          .describe("Maximum entries to return."),
      },
      outputSchema: listDirectoryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: directoryPath, maxEntries }) => {
      const resolved = path.resolve(directoryPath ?? process.cwd());
      const directory = await opendir(resolved);
      const selected = [];

      try {
        for await (const entry of directory) {
          selected.push(entry);
          if (selected.length > maxEntries) break;
        }
      } finally {
        await directory.close().catch(() => undefined);
      }

      const truncated = selected.length > maxEntries;
      if (truncated) selected.pop();

      const maybeItems = await mapWithConcurrency(selected, 32, async (entry) => {
        const itemPath = path.join(resolved, entry.name);
        try {
          const itemStat = await stat(itemPath);
          return {
            name: entry.name,
            path: itemPath,
            type: entry.isDirectory()
              ? ("directory" as const)
              : entry.isFile()
                ? ("file" as const)
                : ("other" as const),
            size: itemStat.size,
            modifiedAt: itemStat.mtime.toISOString(),
          };
        } catch (error) {
          if (isNodeError(error, "ENOENT")) return undefined;
          throw error;
        }
      });
      const items = maybeItems.filter((item) => item !== undefined);

      const structuredContent = {
        path: resolved,
        truncated,
        items,
      };

      return {
        content: textContentFromStructuredContent(structuredContent),
        structuredContent,
      };
    },
  );

  server.registerTool(
    "start_process",
    {
      title: "Start Process",
      description:
        `Start a specific executable directly on this ${HOST_PLATFORM_NAME} computer, optionally waiting for completion. Use terminal for shell commands. Do not use cmd.exe on macOS.`,
      inputSchema: {
        command: z.string().min(1).describe("Executable to run."),
        args: z.array(z.string()).default([]).describe("Command arguments."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory. Defaults to the server process cwd."),
        wait: z
          .boolean()
          .default(false)
          .describe("Wait for the process to exit."),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(60000)
          .default(10000)
          .describe("Timeout when wait is true. Maximum is 60000."),
      },
      outputSchema: startProcessOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ command, args, cwd, wait, timeoutMs }) => {
      const result = await startProcess({
        command,
        args,
        cwd,
        wait,
        timeoutMs,
      });

      return {
        content: textContentFromStructuredContent(result),
        structuredContent: result,
      };
    },
  );

  return server;
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer | string) {
    if (this.truncated) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.maximumBytes - this.bytes;

    if (remaining <= 0) {
      this.truncated = true;
      return;
    }

    if (buffer.byteLength > remaining) {
      this.chunks.push(buffer.subarray(0, remaining));
      this.bytes += remaining;
      this.truncated = true;
      return;
    }

    this.chunks.push(buffer);
    this.bytes += buffer.byteLength;
  }

  toString() {
    const value = Buffer.concat(this.chunks, this.bytes).toString("utf8");
    return this.truncated ? value + "\n...[output truncated]" : value;
  }
}

function childEnvironment() {
  const environment = { ...process.env };
  delete environment.OAUTH_CONSENT_PIN;
  return environment;
}

function terminateProcessTree(child: ReturnType<typeof spawn>) {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.on("error", () => undefined);
    return;
  }

  signalPosixProcessGroup(pid, "SIGTERM");
  const escalation = setTimeout(() => {
    signalPosixProcessGroup(pid, "SIGKILL");
  }, 1000);
  escalation.unref();
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(terminalSignalTarget(process.platform, pid), signal);
  } catch (error: unknown) {
    if (!isNodeError(error, "ESRCH")) {
      console.warn(`Could not send ${signal} to process group ${pid}:`, error);
    }
  }
}

function runTerminal(input: {
  command: string;
  cwd?: string;
  timeoutMs: number;
}) {
  const invocation = createTerminalInvocation({
    platform: HOST_PLATFORM,
    command: input.command,
    configuredExecutable: TERMINAL_EXECUTABLE,
    powerShellExecutable: POWERSHELL_EXECUTABLE,
  });

  return new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    shell: string;
    platformName: string;
  }>((resolve) => {
    const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: childEnvironment(),
      shell: false,
      detached: shouldCreateTerminalProcessGroup(HOST_PLATFORM),
      windowsHide: true,
    });

    const stdout = new BoundedOutput(1024 * 1024);
    const stderr = new BoundedOutput(1024 * 1024);
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) => stderr.append(error.message));

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, input.timeoutMs);
    timer.unref();

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode,
        signal,
        timedOut,
        shell: invocation.shell,
        platformName: invocation.platformName,
      });
    });
  });
}
function startProcess(input: {
  command: string;
  args: string[];
  cwd?: string;
  wait: boolean;
  timeoutMs: number;
}) {
  return new Promise<{
    command: string;
    args: string[];
    cwd: string;
    pid?: number;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
    started: boolean;
  }>((resolve) => {
    const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
    const child = spawn(input.command, input.args, {
      cwd,
      env: childEnvironment(),
      shell: false,
      detached: !input.wait,
      stdio: input.wait ? "pipe" : "ignore",
      windowsHide: true,
    });

    if (!input.wait) {
      let settled = false;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        resolve({
          command: input.command,
          args: input.args,
          cwd,
          started: false,
          stderr: error.message,
        });
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve({
          command: input.command,
          args: input.args,
          cwd,
          pid: child.pid,
          started: true,
        });
      });
      return;
    }

    const stdout = new BoundedOutput(1024 * 1024);
    const stderr = new BoundedOutput(1024 * 1024);
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) => stderr.append(error.message));

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, input.timeoutMs);
    timer.unref();

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command: input.command,
        args: input.args,
        cwd,
        pid: child.pid,
        started: true,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode,
        signal,
        timedOut,
      });
    });
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function protectedResourceMetadata() {
  return {
    resource: MCP_PUBLIC_URL,
    authorization_servers: [AUTH_ISSUER],
    scopes_supported: [REQUIRED_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Local Computer Control MCP",
  };
}

function authorizationServerMetadata() {
  return {
    issuer: AUTH_ISSUER,
    authorization_endpoint: `${AUTH_ISSUER}/oauth/authorize`,
    token_endpoint: `${AUTH_ISSUER}/oauth/token`,
    revocation_endpoint: `${AUTH_ISSUER}/oauth/revoke`,
    registration_endpoint: `${AUTH_ISSUER}/oauth/register`,
    jwks_uri: `${AUTH_ISSUER}/oauth/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [REQUIRED_SCOPE],
    resource_indicators_supported: true,
  };
}

function validateAuthorizeRequest(
  request: z.infer<typeof authorizeRequestSchema>,
  client?: OAuthClient,
) {
  if (!client) return "invalid_client";
  if (!client.redirectUris.includes(request.redirect_uri))
    return "invalid_request";
  if (request.resource && request.resource !== MCP_PUBLIC_URL)
    return "invalid_target";

  const requestedScopes = normalizeScope(request.scope ?? REQUIRED_SCOPE).split(
    " ",
  );
  const allowedScopes = new Set(client.scope.split(" "));

  if (!requestedScopes.every((scope) => allowedScopes.has(scope))) {
    return "invalid_scope";
  }

  return undefined;
}

function redirectOAuthError(
  redirectUri: string,
  state: string | undefined,
  error: string,
  res: Response,
) {
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("error", error);
  if (state) redirectUrl.searchParams.set("state", state);
  return res.redirect(302, redirectUrl.toString());
}

function clientResponse(client: OAuthClient) {
  return {
    client_id: client.clientId,
    client_id_issued_at: client.issuedAt,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: client.scope,
  };
}

function renderConsentPage(
  request: z.infer<typeof authorizeRequestSchema>,
  client: OAuthClient,
  transactionId: string,
  errorMessage?: string,
) {
  const pinField = `<label for="consent_pin">Consent PIN <small>(check your server terminal)</small></label>
      <input id="consent_pin" name="consent_pin" type="text" inputmode="numeric" autocomplete="off" maxlength="${CONSENT_PIN_LENGTH}" pattern="[0-9]{${CONSENT_PIN_LENGTH}}" required autofocus />`;
  const error = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize Local Computer Control MCP</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #f6f7f9; color: #16181d; }
      main { max-width: 680px; margin: 10vh auto; padding: 32px; background: white; border: 1px solid #d8dce3; border-radius: 8px; }
      h1 { margin: 0 0 16px; font-size: 24px; }
      p { line-height: 1.5; }
      code { background: #eef1f5; padding: 2px 5px; border-radius: 4px; }
      label { display: block; margin: 18px 0 6px; font-weight: 650; }
      label small { font-weight: 400; color: #6e7781; }
      input { box-sizing: border-box; width: 100%; max-width: 260px; padding: 9px; border: 1px solid #c8ced8; border-radius: 6px; font-size: 18px; letter-spacing: 0.15em; text-align: center; }
      button { border: 0; border-radius: 6px; background: #1f6feb; color: white; padding: 10px 16px; font-weight: 650; cursor: pointer; }
      .danger { border-left: 4px solid #d1242f; padding-left: 12px; }
      .error { color: #b42318; font-weight: 650; }
      .actions { display: flex; gap: 10px; align-items: center; }
      .deny { background: #6e7781; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authorize Local Computer Control MCP</h1>
      <p><strong>${escapeHtml(client.clientName ?? request.client_id)}</strong> is requesting access to <code>${escapeHtml(request.resource ?? MCP_PUBLIC_URL)}</code>.</p>
      <p>Redirect destination: <code>${escapeHtml(new URL(request.redirect_uri).origin)}</code></p>
      <p class="danger">This grants access to tools that can run terminal commands, read/write files, and start processes on this computer. Only approve this request if you started it from ChatGPT.</p>
      <p>Scope: <code>${escapeHtml(request.scope ?? REQUIRED_SCOPE)}</code></p>
      ${error}
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="auth_tx" value="${escapeHtml(transactionId)}" />
        ${pinField}
        <p></p>
        <div class="actions">
          <button type="submit" name="action" value="authorize">Authorize</button>
          <button class="deny" type="submit" name="action" value="deny" formnovalidate>Deny</button>
        </div>
      </form>
    </main>
  </body>
</html>`;
}

function renderErrorPage(message: string) {
  return `<!doctype html><html><body><h1>OAuth Error</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function sendAuthorizationCallback(res: Response, callbackUrl: string) {
  // Some embedded OAuth browsers do not act on an HTTP redirect after the
  // consent form POST. OAuth permits other user-agent redirect mechanisms;
  // this page uses navigation, a meta-refresh fallback, and a visible link.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  return res
    .status(200)
    .type("html")
    .send(renderAuthorizationCallbackPage(callbackUrl));
}

function renderAuthorizationCallbackPage(callbackUrl: string) {
  const escapedUrl = escapeHtml(callbackUrl);
  const callbackJson = JSON.stringify(callbackUrl)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0;url=${escapedUrl}" />
    <title>Completing authorization</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #f6f7f9; color: #16181d; }
      main { max-width: 560px; margin: 10vh auto; padding: 32px; background: white; border: 1px solid #d8dce3; border-radius: 8px; }
      h1 { margin: 0 0 16px; font-size: 24px; }
      p { line-height: 1.5; }
      a { display: inline-block; border-radius: 6px; background: #1f6feb; color: white; padding: 10px 16px; font-weight: 650; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authorization approved</h1>
      <p>Returning to ChatGPT…</p>
      <p><a href="${escapedUrl}" rel="noreferrer">Continue to ChatGPT</a></p>
    </main>
    <script>window.location.replace(${callbackJson});</script>
  </body>
</html>`;
}

function logOAuthResponse(pathname: string, req: Request, res: Response) {
  const requestId = `oauth_${randomId(6)}`;
  const startedAt = Date.now();
  let finished = false;

  res.once("finish", () => {
    finished = true;
    console.log(
      `[${pathname}] ${requestId} ${req.method} completed with ${res.statusCode} in ${Date.now() - startedAt}ms.`,
    );
  });
  res.once("close", () => {
    if (!finished) {
      console.warn(
        `[${pathname}] ${requestId} ${req.method} connection closed before a response completed.`,
      );
    }
  });

  return requestId;
}

function resolvePowerShellExecutable(
  platform: NodeJS.Platform,
  configuredExecutable: string | undefined,
) {
  const configured = configuredExecutable?.trim();

  if (
    configured &&
    !(platform !== "win32" && configured.toLowerCase() === "powershell.exe")
  ) {
    return configured;
  }

  return platform === "win32" ? "powershell.exe" : "pwsh";
}
function boundedIntegerEnv(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function parseCsvEnv(name: string, defaultValues: string[]) {
  const raw = process.env[name];
  return (raw ? raw.split(",") : defaultValues)
    .map((value) => value.trim())
    .filter(Boolean);
}

function arraysEqual(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function isAllowedRedirectUri(value: string) {
  try {
    const redirect = new URL(value);
    if (redirect.hash || redirect.username || redirect.password) return false;

    if (redirect.protocol === "http:") {
      return isLoopbackHost(redirect.hostname);
    }

    if (redirect.protocol !== "https:") return false;
    if (ALLOWED_REDIRECT_URIS.size > 0) {
      return ALLOWED_REDIRECT_URIS.has(redirect.toString());
    }
    return ALLOWED_REDIRECT_ORIGINS.has(redirect.origin);
  } catch {
    return false;
  }
}

function generateConsentPin(): string {
  const max = Math.pow(10, CONSENT_PIN_LENGTH);
  const raw = randomBytes(4).readUInt32BE(0) % max;
  return String(raw).padStart(CONSENT_PIN_LENGTH, "0");
}

function verifyConsentPin(candidate: string | undefined, expectedPin: string) {
  if (!candidate) return false;

  const expected = createHash("sha256").update(expectedPin).digest();
  const actual = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expected, actual);
}

type RateLimitEntry = { count: number; resetAt: number };
const rateLimitEntries = new Map<string, RateLimitEntry>();

function createRateLimiter(prefix: string, windowMs: number, maximum: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${prefix}:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    const existing = rateLimitEntries.get(key);
    const entry =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : existing;

    entry.count += 1;
    rateLimitEntries.set(key, entry);

    res.setHeader("RateLimit-Limit", String(maximum));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, maximum - entry.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maximum) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({
        error: "rate_limited",
        error_description: "Too many requests. Try again later.",
      });
    }

    return next();
  };
}

function cleanupEphemeralState() {
  const now = Date.now();

  for (const [code, authorizationCode] of codes) {
    if (authorizationCode.expiresAt < now) codes.delete(code);
  }

  for (const [transactionId, transaction] of authorizationTransactions) {
    if (transaction.expiresAt < now) authorizationTransactions.delete(transactionId);
  }

  for (const [key, entry] of rateLimitEntries) {
    if (entry.resetAt < now) rateLimitEntries.delete(key);
  }

}

function validateConfiguration() {
  const publicUrl = new URL(PUBLIC_BASE_URL);
  const mcpUrl = new URL(MCP_PUBLIC_URL);
  const issuerUrl = new URL(AUTH_ISSUER);
  const publicDeployment = !isLoopbackHost(publicUrl.hostname);

  if (publicDeployment && publicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS when it is not loopback.");
  }
  if (publicDeployment && process.env.OAUTH_CONSENT_PIN) {
    console.warn("OAUTH_CONSENT_PIN env var is set but ignored; PINs are now generated dynamically per request.");
  }
  if (
    publicDeployment &&
    REQUIRE_EXACT_REDIRECT_URIS &&
    ALLOWED_REDIRECT_URIS.size === 0
  ) {
    throw new Error(
      "ALLOWED_REDIRECT_URIS must contain the exact ChatGPT callback URI for a public deployment.",
    );
  }
  // Note: OAUTH_CONSENT_PIN env var is no longer used. PINs are generated dynamically per request.
  if (mcpUrl.origin !== publicUrl.origin || issuerUrl.origin !== publicUrl.origin) {
    throw new Error("PUBLIC_BASE_URL, MCP_PUBLIC_URL, and AUTH_ISSUER must share one origin.");
  }
  if (!isLoopbackHost(HOST) && process.env.ALLOW_NON_LOOPBACK_BIND !== "true") {
    throw new Error("HOST must be loopback unless ALLOW_NON_LOOPBACK_BIND=true.");
  }
}

function normalizeScope(scope: string) {
  const normalized = scope.split(/\s+/).filter(Boolean).join(" ");

  return normalized || REQUIRED_SCOPE;
}

function pkceS256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function randomId(bytes: number) {
  return randomBytes(bytes).toString("base64url");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

validateConfiguration();
await initializeAuthStore();

const cleanupTimer = setInterval(cleanupEphemeralState, 60 * 1000);
cleanupTimer.unref();

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`${SERVER_NAME} listening on ${PUBLIC_BASE_URL}`);
  console.log(`MCP endpoint: ${MCP_PUBLIC_URL}`);
  console.log(`OAuth issuer: ${AUTH_ISSUER}`);
  console.log(`OAuth store: ${OAUTH_STORE_PATH}`);
  console.log(`Required scope: ${REQUIRED_SCOPE}`);
  console.log("MCP transport mode: stateless (OAuth required on every request)");
  console.log(
    `Maximum parallel refresh tokens per grant: ${MAX_REFRESH_TOKENS_PER_GRANT}`,
  );
  console.log(`Host platform: ${HOST_PLATFORM_NAME} (${HOST_PLATFORM})`);
  console.log(`Terminal shell: ${TERMINAL_SHELL}`);
  console.log(
    `OAuth consent PIN: dynamically generated per request (${CONSENT_PIN_LENGTH}-digit)`,
  );
});

let shutdownStarted = false;
async function shutdown(signal: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`Received ${signal}; closing HTTP server.`);

  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  forcedExit.unref();

  httpServer.close((error) => {
    clearTimeout(forcedExit);
    if (error) {
      console.error("HTTP shutdown failed:", error);
      process.exit(1);
    } else {
      process.exit(0);
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

const parentPid = process.ppid;
if (parentPid && parentPid !== 1) {
  const parentMonitorInterval = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error: unknown) {
      if (isNodeError(error, "ESRCH")) {
        console.log(`Parent process ${parentPid} exited. Shutting down server.`);
        clearInterval(parentMonitorInterval);
        void shutdown("parent_exit");
      }
    }
  }, 2000);
  parentMonitorInterval.unref();
}
