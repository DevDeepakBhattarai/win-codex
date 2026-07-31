import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { resolvePowerShellExecutable } from "./run-powershell.mjs";

const cwd = process.cwd();
if (resolvePowerShellExecutable("darwin", "powershell.exe") !== "pwsh") {
  throw new Error("macOS must use pwsh instead of powershell.exe.");
}
const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once("error", reject);
  portProbe.listen(0, "127.0.0.1", resolve);
});
const probeAddress = portProbe.address();
if (!probeAddress || typeof probeAddress === "string") {
  throw new Error("Could not allocate an isolated test port.");
}
const port = probeAddress.port;
await new Promise((resolve, reject) =>
  portProbe.close(error => (error ? reject(error) : resolve())),
);
const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${baseUrl}/mcp`;
const dataDir = path.join(
  cwd,
  ".audit-backup",
  `authenticated-stateless-data-${port}`,
);
await rm(dataDir, { recursive: true, force: true });

const child = spawn(process.execPath, ["dist/server.js"], {
  cwd,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_BASE_URL: baseUrl,
    MCP_PUBLIC_URL: mcpUrl,
    AUTH_ISSUER: baseUrl,
    DATA_DIR: dataDir,
    OAUTH_STORE_PATH: path.join(dataDir, "oauth-store.json"),
    ALLOWED_REDIRECT_URIS: "",
    REQUIRE_EXACT_REDIRECT_URIS: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", chunk => { stdout += chunk; });
child.stderr.on("data", chunk => { stderr += chunk; });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    if (child.exitCode !== null) {
      throw new Error(`Server exited during ${label}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

function form(values) {
  return new URLSearchParams(values).toString();
}

async function postMcp(body, accessToken, extraHeaders = {}) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const response = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    responseText,
  };
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited during startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response;
    } catch {
      // Server is still binding or initializing its OAuth store.
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for server health.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

try {
  const healthResponse = await waitForServer();
  const health = await healthResponse.json();
  if (
    healthResponse.status !== 200 ||
    health.transportMode !== "stateless" ||
    health.authentication !== "oauth2-bearer"
  ) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }

  const invalidClientUrl = new URL(`${baseUrl}/oauth/authorize`);
  invalidClientUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: "missing-client",
    redirect_uri: "https://evil.example/callback",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  const invalidClientResponse = await fetch(invalidClientUrl, { redirect: "manual" });
  if (invalidClientResponse.status !== 400 || invalidClientResponse.headers.has("location")) {
    throw new Error("Invalid OAuth client could be used as an open redirect.");
  }

  const dangerousRedirectResponse = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Dangerous Redirect Test",
      redirect_uris: ["javascript:alert(1)"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (dangerousRedirectResponse.status !== 400) {
    throw new Error("Dangerous OAuth redirect URI was accepted.");
  }

  const corsResponse = await fetch(mcpUrl, {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
    },
  });
  if (corsResponse.headers.has("access-control-allow-origin")) {
    throw new Error("Untrusted CORS origin was allowed.");
  }

  const initializeBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "authenticated-stateless-test", version: "1.0.0" },
    },
  };

  const noToken = await postMcp(initializeBody);
  if (noToken.status !== 401) {
    throw new Error(`Unauthenticated request was not rejected: ${JSON.stringify(noToken)}`);
  }

  const badToken = await postMcp(initializeBody, "not-a-valid-jwt");
  if (badToken.status !== 401) {
    throw new Error(`Malformed token was not rejected: ${JSON.stringify(badToken)}`);
  }

  const redirectUri = "http://127.0.0.1/callback";
  const registrationResponse = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Authenticated Stateless Test",
      redirect_uris: [redirectUri],
      scope: "mcp:control",
      token_endpoint_auth_method: "none",
    }),
  });
  if (!registrationResponse.ok) {
    throw new Error(`Registration failed: ${registrationResponse.status} ${await registrationResponse.text()}`);
  }
  const registration = await registrationResponse.json();

  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp:control",
    resource: mcpUrl,
    state: "authenticated-stateless-test",
  }).toString();

  const authorizePageResponse = await fetch(authorizeUrl);
  const authorizePage = await authorizePageResponse.text();
  const transactionId = authorizePage.match(/name="auth_tx" value="([^"]+)"/)?.[1];
  if (!transactionId) throw new Error("Authorization transaction ID was not rendered.");

  const pin = await waitFor(
    () => stdout.match(/OAUTH CONSENT PIN:\s*(\d{6})/)?.[1],
    "consent PIN",
  );

  const consentResponse = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ auth_tx: transactionId, consent_pin: pin, action: "authorize" }),
    redirect: "manual",
  });
  const consentHtml = await consentResponse.text();
  const location =
    consentResponse.headers.get("location") ??
    consentHtml.match(/url=([^"']+)/i)?.[1]?.replaceAll("&amp;", "&") ??
    consentHtml.match(/href="([^"]+)"/i)?.[1]?.replaceAll("&amp;", "&");
  if (!location) throw new Error("Authorization response did not expose a callback URL.");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("Authorization callback did not contain a code.");

  const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: registration.client_id,
      code_verifier: verifier,
      resource: mcpUrl,
    }),
  });
  const token = await tokenResponse.json();
  if (tokenResponse.status !== 200 || !token.access_token || !token.refresh_token) {
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${JSON.stringify(token)}`);
  }

  const initialized = await postMcp(initializeBody, token.access_token);
  if (initialized.status !== 200) {
    throw new Error(`Authenticated initialize failed: ${JSON.stringify(initialized)}`);
  }
  if (initialized.sessionId !== null) {
    throw new Error(`Stateless initialize unexpectedly returned Mcp-Session-Id: ${initialized.sessionId}`);
  }

  const toolsListBody = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  };
  const protocolHeaders = { "mcp-protocol-version": "2025-06-18" };
  const toolsList = await postMcp(toolsListBody, token.access_token, protocolHeaders);
  if (toolsList.status !== 200 || !toolsList.responseText.includes("list_directory")) {
    throw new Error(`Authenticated tools/list failed: ${JSON.stringify(toolsList)}`);
  }
  if (toolsList.sessionId !== null) {
    throw new Error(`Stateless tools/list unexpectedly returned Mcp-Session-Id: ${toolsList.sessionId}`);
  }

  const powerShellCall = await postMcp(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "powershell",
        arguments: {
          command: "Write-Output 'mcp-platform-ok'",
          timeoutMs: 10000,
        },
      },
    },
    token.access_token,
    protocolHeaders,
  );
  if (
    powerShellCall.status !== 200 ||
    !powerShellCall.responseText.includes("mcp-platform-ok")
  ) {
    throw new Error(`PowerShell tool execution failed: ${JSON.stringify(powerShellCall)}`);
  }

  const requestCount = 300;
  let succeeded = 0;
  for (let offset = 0; offset < requestCount; offset += 25) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(25, requestCount - offset) }, (_, index) =>
        postMcp(
          { ...toolsListBody, id: 1000 + offset + index },
          token.access_token,
          protocolHeaders,
        ),
      ),
    );
    const failures = batch.filter(result => result.status !== 200 || result.sessionId !== null);
    if (failures.length) {
      throw new Error(`Stateless request batch failed: ${JSON.stringify(failures.slice(0, 3))}`);
    }
    succeeded += batch.length;
  }

  const revokeResponse = await fetch(`${baseUrl}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      token: token.refresh_token,
      client_id: registration.client_id,
    }),
  });
  if (revokeResponse.status !== 200) {
    throw new Error(`Revocation failed: ${revokeResponse.status} ${await revokeResponse.text()}`);
  }

  const afterRevocation = await postMcp(toolsListBody, token.access_token, protocolHeaders);
  if (afterRevocation.status !== 401) {
    throw new Error(`Revoked grant still accessed MCP: ${JSON.stringify(afterRevocation)}`);
  }

  console.log(JSON.stringify({
    transportMode: health.transportMode,
    authentication: health.authentication,
    openRedirectBlocked: true,
    dangerousRedirectBlocked: true,
    untrustedCorsBlocked: true,
    unauthenticatedRejected: noToken.status === 401,
    malformedTokenRejected: badToken.status === 401,
    authenticatedInitializeSucceeded: initialized.status === 200,
    sessionIdIssued: initialized.sessionId !== null,
    authenticatedToolsListSucceeded: toolsList.status === 200,
    powerShellExecutableSelection: true,
    powerShellCommandSucceeded: powerShellCall.status === 200,
    statelessRequestsSucceeded: succeeded,
    revokedGrantRejected: afterRevocation.status === 401,
  }, null, 2));
} finally {
  if (child.exitCode === null && child.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        sleep(3000).then(() => child.kill("SIGKILL")),
      ]);
    }
  }
  await rm(dataDir, { recursive: true, force: true });
}
