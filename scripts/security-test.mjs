import { createHash, randomBytes } from "node:crypto";

const baseUrl = (process.env.MCP_SECURITY_TEST_BASE_URL ?? "http://127.0.0.1:6000").replace(/\/$/, "");
const consentPin = process.env.MCP_SECURITY_TEST_CONSENT_PIN;
const redirectUri = "http://127.0.0.1/callback";

function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) body.set(key, String(value));
  }
  return body;
}

async function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    const body = await response.text();
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}: ${body}`);
  }
  return response;
}

async function registerClient(clientName) {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      scope: "mcp:control",
      token_endpoint_auth_method: "none",
    }),
  });
  await expectStatus(response, response.status === 200 ? 200 : 201, `${clientName} registration`);
  return response.json();
}

async function authorizeClient(client) {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const resourceResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  await expectStatus(resourceResponse, 200, "protected resource metadata");
  const resource = (await resourceResponse.json()).resource;

  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.search = formBody({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp:control",
    resource,
    state: `security-${client.client_id}`,
  }).toString();

  const consentPage = await fetch(authorizeUrl);
  await expectStatus(consentPage, 200, "consent page");
  const html = await consentPage.text();
  const transaction = html.match(/name="auth_tx" value="([^"]+)"/u)?.[1];
  if (!transaction) throw new Error("Consent page did not include an authorization transaction.");

  const authorization = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      auth_tx: transaction,
      action: "authorize",
      consent_pin: consentPin,
    }),
    redirect: "manual",
  });
  await expectStatus(authorization, 200, "authorization approval");
  const completionPage = await authorization.text();
  const callbackJson = completionPage.match(
    /window\.location\.replace\(("(?:[^"\\]|\\.)*")\);<\/script>/u,
  )?.[1];
  if (!callbackJson) {
    throw new Error("Authorization response did not contain a callback navigation.");
  }
  const location = JSON.parse(callbackJson);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("Authorization response did not contain a code.");

  const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
      resource,
    }),
  });
  await expectStatus(tokenResponse, 200, "token exchange");
  return { ...(await tokenResponse.json()), resource };
}

async function revoke(client, token) {
  await fetch(`${baseUrl}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ token: token.refresh_token, client_id: client.client_id }),
  });
}

const invalidClientUrl = new URL(`${baseUrl}/oauth/authorize`);
invalidClientUrl.search = formBody({
  response_type: "code",
  client_id: "missing-client",
  redirect_uri: "https://evil.example/callback",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
}).toString();
const invalidClientResponse = await fetch(invalidClientUrl, { redirect: "manual" });
await expectStatus(invalidClientResponse, 400, "invalid client open-redirect protection");
if (invalidClientResponse.headers.has("location")) {
  throw new Error("Invalid client request was redirected.");
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
await expectStatus(dangerousRedirectResponse, 400, "dangerous redirect rejection");

const corsResponse = await fetch(`${baseUrl}/mcp`, {
  method: "OPTIONS",
  headers: {
    origin: "https://evil.example",
    "access-control-request-method": "POST",
  },
});
if (corsResponse.headers.has("access-control-allow-origin")) {
  throw new Error("Untrusted CORS origin was allowed.");
}

const clientA = await registerClient("Security Test Client A");
const clientB = await registerClient("Security Test Client B");
const tokenA = await authorizeClient(clientA);
const tokenB = await authorizeClient(clientB);

try {
  const initializeResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenA.access_token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "security-test", version: "1.0.0" },
      },
    }),
  });
  await expectStatus(initializeResponse, 200, "MCP initialize");
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP initialize did not return a session ID.");

  const hijackResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenB.access_token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });
  await expectStatus(hijackResponse, 403, "cross-grant MCP session protection");

  console.log(JSON.stringify({
    openRedirectBlocked: true,
    dangerousRedirectBlocked: true,
    untrustedCorsBlocked: true,
    crossGrantSessionBlocked: true,
    sessionId,
  }, null, 2));
} finally {
  await Promise.all([revoke(clientA, tokenA), revoke(clientB, tokenB)]);
}
