import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import {
  createTerminalInvocation,
  formatPlatformName,
  shouldCreateTerminalProcessGroup,
  terminalSignalTarget,
} from "../dist/terminal.js";
import {
  createPowerShellStartupArguments,
  resolvePowerShellExecutable,
} from "./run-powershell.mjs";

const cwd = process.cwd();
if (resolvePowerShellExecutable("darwin", "powershell.exe") !== "pwsh") {
  throw new Error("macOS management scripts must use pwsh instead of powershell.exe.");
}
if (
  createPowerShellStartupArguments("darwin", true).includes("-NonInteractive")
) {
  throw new Error("The interactive smoke test must permit consent PIN input.");
}
if (
  !shouldCreateTerminalProcessGroup("darwin") ||
  shouldCreateTerminalProcessGroup("win32") ||
  terminalSignalTarget("darwin", 1234) !== -1234
) {
  throw new Error("POSIX terminal commands must run in a signalable process group.");
}

const smokeTestPath = path.join(cwd, "scripts", "smoke-test.ps1");
const escapedSmokeTestPath = smokeTestPath.replaceAll("'", "''");
const smokeParseCommand = [
  "$tokens = $null",
  "$errors = $null",
  `[System.Management.Automation.Language.Parser]::ParseFile('${escapedSmokeTestPath}', [ref]$tokens, [ref]$errors) | Out-Null`,
  "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error ($_.ToString()) }; exit 1 }",
].join("; ");
const smokeParse = spawnSync(
  resolvePowerShellExecutable(),
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", smokeParseCommand],
  { cwd, encoding: "utf8", windowsHide: true },
);
if (smokeParse.error || smokeParse.status !== 0) {
  throw new Error(
    `PowerShell smoke test has syntax errors: ${smokeParse.error?.message ?? smokeParse.stderr}`,
  );
}

const macTerminalInvocation = createTerminalInvocation({
  platform: "darwin",
  command: "printf mac-terminal-ok",
  configuredExecutable: undefined,
  powerShellExecutable: "pwsh",
});
if (
  macTerminalInvocation.executable !== "/bin/bash" ||
  macTerminalInvocation.args[0] !== "-lc" ||
  macTerminalInvocation.args[1] !== "printf mac-terminal-ok"
) {
  throw new Error("macOS terminal commands must run through /bin/bash -lc.");
}

const windowsTerminalInvocation = createTerminalInvocation({
  platform: "win32",
  command: "Write-Output windows-terminal-ok",
  configuredExecutable: undefined,
  powerShellExecutable: "powershell.exe",
});
if (
  windowsTerminalInvocation.executable !== "powershell.exe" ||
  !windowsTerminalInvocation.args.includes("Write-Output windows-terminal-ok")
) {
  throw new Error("Windows terminal commands must run through PowerShell.");
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
    health.authentication !== "oauth2-bearer" ||
    health.platform !== process.platform ||
    health.platformName !== formatPlatformName(process.platform)
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
  if (
    toolsList.status !== 200 ||
    !toolsList.responseText.includes("list_directory") ||
    !toolsList.responseText.includes("terminal") ||
    !toolsList.responseText.includes("analyze_image") ||
    !toolsList.responseText.includes("browser_snapshot") ||
    !toolsList.responseText.includes("browser_action") ||
    !toolsList.responseText.includes("browser_tab") ||
    !toolsList.responseText.includes("browser_upload") ||
    !toolsList.responseText.includes("browser_download") ||
    !toolsList.responseText.includes("browser_clipboard")
  ) {
    throw new Error(`Authenticated tools/list failed: ${JSON.stringify(toolsList)}`);
  }
  if (toolsList.sessionId !== null) {
    throw new Error(`Stateless tools/list unexpectedly returned Mcp-Session-Id: ${toolsList.sessionId}`);
  }

  const terminalCall = await postMcp(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "terminal",
        arguments: {
          command: "node -e \"console.log('mcp-terminal-ok')\"",
          timeoutMs: 10000,
        },
      },
    },
    token.access_token,
    protocolHeaders,
  );
  if (
    terminalCall.status !== 200 ||
    !terminalCall.responseText.includes("mcp-terminal-ok")
  ) {
    throw new Error(`Terminal tool execution failed: ${JSON.stringify(terminalCall)}`);
  }

  const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl02QAAAABJRU5ErkJggg==";
  const testImagePath = path.join(dataDir, "analyze-image-test.png");
  await writeFile(testImagePath, Buffer.from(tinyPngBase64, "base64"));
  const imageCall = await postMcp(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "analyze_image",
        arguments: { path: testImagePath },
      },
    },
    token.access_token,
    protocolHeaders,
  );
  if (
    imageCall.status !== 200 ||
    !imageCall.responseText.includes('"type":"image"') ||
    !imageCall.responseText.includes('"mimeType":"image/png"') ||
    !imageCall.responseText.includes(tinyPngBase64)
  ) {
    throw new Error(`Image tool did not return MCP image content: ${JSON.stringify(imageCall)}`);
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
    hostPlatformAdvertised: health.platform === process.platform,
    terminalToolAdvertised: toolsList.responseText.includes("terminal"),
    imageToolAdvertised: toolsList.responseText.includes("analyze_image"),
    browserToolsAdvertised:
      toolsList.responseText.includes("browser_snapshot") &&
      toolsList.responseText.includes("browser_action") &&
      toolsList.responseText.includes("browser_tab") &&
      toolsList.responseText.includes("browser_upload") &&
      toolsList.responseText.includes("browser_download") &&
      toolsList.responseText.includes("browser_clipboard"),
    macTerminalUsesBash: macTerminalInvocation.executable === "/bin/bash",
    macTerminalUsesProcessGroup: shouldCreateTerminalProcessGroup("darwin"),
    smokeTestSyntaxValid: smokeParse.status === 0,
    windowsTerminalUsesPowerShell: windowsTerminalInvocation.executable === "powershell.exe",
    terminalCommandSucceeded: terminalCall.status === 200,
    imageToolReturnedMcpImageContent: imageCall.status === 200,
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
