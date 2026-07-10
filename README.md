# Local Windows Control MCP

A hardened Streamable HTTP MCP server that lets an approved ChatGPT connection control a Windows machine through PowerShell, filesystem, directory, and process tools.

The server is deliberately powerful. An approved client receives the permissions of the Windows account running the server. The security model therefore focuses on ensuring that only an explicitly approved ChatGPT OAuth grant can reach the tools, that stolen access tokens expire quickly, and that grants remain revocable without repeatedly reconnecting ChatGPT.

## Endpoints

The default local address is `http://localhost:6000`:

- MCP: `/mcp`
- Health: `/health`
- Protected-resource metadata: `/.well-known/oauth-protected-resource`
- Authorization-server metadata: `/.well-known/oauth-authorization-server`
- Dynamic client registration: `/oauth/register`
- Authorization: `/oauth/authorize`
- Token: `/oauth/token`
- Revocation: `/oauth/revoke`
- JWKS: `/oauth/jwks`

## Installation

This repository uses pnpm and Node.js 22.

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm run harden
pnpm start
```

`pnpm run harden` removes inherited Windows permissions from `.env` and `.data` and grants access only to the current Windows account, SYSTEM, and Administrators. Run it again after moving the project or changing the service account.

Development mode remains available:

```powershell
pnpm dev
```

Production mode runs compiled JavaScript from `dist/` and does not use the TypeScript runtime loader.

## ChatGPT connection

Keep the Node server bound to loopback and expose it through an HTTPS tunnel. A typical configuration is:

```env
HOST=localhost
PORT=6000
PUBLIC_BASE_URL=https://mcp.example.com
MCP_PUBLIC_URL=https://mcp.example.com/mcp
AUTH_ISSUER=https://mcp.example.com
OAUTH_CONSENT_PIN=use-a-random-value-with-at-least-20-characters
ALLOWED_REDIRECT_URIS=https://chatgpt.com/connector/oauth/your-existing-callback-id
REQUIRE_EXACT_REDIRECT_URIS=true
ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com
CORS_ALLOWED_ORIGINS=https://chatgpt.com,https://chat.openai.com
```

Add this connector URL in ChatGPT:

```text
https://mcp.example.com/mcp
```

The consent PIN is requested only during initial authorization. After approval:

- The OAuth grant and refresh token survive server restarts.
- Access tokens expire after 10 minutes by default.
- ChatGPT refreshes them automatically.
- Refresh tokens rotate on use.
- Restarting the server with the same `.data/oauth-store.json` does not require reconnecting ChatGPT.

Existing grants created by older versions are migrated in place. Their old non-expiring access token is rejected after the hardened server starts, after which ChatGPT should use its persisted refresh token automatically.

## Security controls

The server now applies the following controls by default:

- Non-loopback public URLs must use HTTPS.
- The Node listener must remain on loopback unless `ALLOW_NON_LOOPBACK_BIND=true` is explicitly configured.
- A consent PIN of at least 20 characters is mandatory for non-loopback deployments.
- Public deployments are locked to the exact ChatGPT callback URI already associated with this connector; a broad origin allowlist is only a bootstrap fallback. Loopback HTTP callbacks remain available for local tests.
- `javascript:`, `data:`, `file:`, URL fragments, and URLs containing user information are rejected.
- Invalid clients and unregistered redirect URIs return a local error and cannot use the authorization endpoint as an open redirect.
- Consent submissions use short-lived, random, server-side authorization transactions rather than trusting hidden OAuth parameters.
- Authorization, registration, token, revocation, and MCP ingress endpoints are rate-limited.
- CORS uses an exact allowlist instead of reflecting arbitrary origins.
- OAuth and consent responses use no-store caching and restrictive browser security headers.
- JWT access tokens use RS256, issuer and audience validation, a required expiration, maximum token age, grant binding, and scope binding.
- Refresh-token lookup is indexed, refresh tokens are stored as SHA-256 hashes, and rotation includes a short retry grace period.
- MCP sessions are owned by the client and grant that created them, with idle, absolute, and total-count limits.
- Revoking a grant immediately closes all of its active MCP sessions.
- OAuth-store writes are serialized, protected with a cross-process lock, and replaced atomically.
- The OAuth store is schema-validated before use.
- Child processes do not inherit `OAUTH_CONSENT_PIN`.
- Command output uses bounded buffers instead of repeated whole-string copies.
- File reading performs bounded disk I/O rather than loading an entire file before truncation.
- Directory enumeration stops after the requested entry limit and limits concurrent metadata calls.
- Failed detached process launches return `started: false` rather than crashing Node.
- Timed-out Windows processes are terminated with `taskkill /T /F` to include descendants.
- Large structured MCP results are not duplicated in full as text.

### Default lifetimes and limits

```env
ACCESS_TOKEN_TTL_SECONDS=600
REFRESH_ROTATION_GRACE_SECONDS=60
SESSION_IDLE_TTL_MINUTES=60
SESSION_ABSOLUTE_TTL_HOURS=24
MAX_SESSIONS=64
MAX_OAUTH_CLIENTS=20
```

These limits do not require repeated user authorization. A new MCP session can be initialized automatically under the same persistent OAuth grant.

## Important trust boundary

OAuth prevents someone who merely discovers the URL from running tools. It does not sandbox an approved tool call.

After approval, the `powershell` and `start_process` tools can perform anything permitted to the Windows account running this service. No command parser can reliably make arbitrary PowerShell safe while preserving arbitrary PowerShell functionality.

For stronger containment without changing the ChatGPT experience, run this server as a dedicated, non-administrator Windows account that has access only to the development directories and applications it must control. Do not run it elevated. The OAuth files should remain owned by that account and protected with `pnpm run harden`.

True protection of OAuth signing material from an already authorized arbitrary-PowerShell client requires separating the OAuth control plane and command executor into different Windows security principals. That is an operating-system deployment boundary rather than an HTTP or OAuth code change.

## Tools

- `powershell`: execute a Windows PowerShell command, with a maximum waited duration of 60 seconds and bounded output.
- `read_text_file`: read up to 5 MiB of a UTF-8 file using bounded I/O.
- `write_text_file`: create or replace up to 5 MiB of UTF-8 text.
- `list_directory`: list up to 1,000 directory entries.
- `start_process`: launch an executable with argument-array semantics, optionally waiting for completion.

## Revocation

List clients and grants:

```powershell
pnpm revoke
```

Revoke one client's grants:

```powershell
pnpm revoke -- -ClientId local_example
```

Revoke all grants:

```powershell
pnpm revoke -- -All
```

Add `-RemoveClients` to remove registrations as well. The revoke utility uses the same OAuth-store lock and atomic replacement strategy as the server.

## Verification

With a server running:

```powershell
pnpm smoke
```

The smoke test verifies:

- Dynamic registration and PKCE authorization.
- Server-side consent transactions.
- Expiring access tokens.
- Refresh-token rotation.
- MCP initialization and tool listing.
- PowerShell execution.
- Safe handling of nonexistent executables.
- Bounded file reads.
- Refresh and access revocation.

Run the additional security regression suite:

```powershell
$env:MCP_SECURITY_TEST_CONSENT_PIN = $env:OAUTH_CONSENT_PIN
pnpm security-test
```

It verifies open-redirect prevention, dangerous redirect rejection, untrusted CORS denial, and cross-grant MCP session isolation.

## Configuration reference

See `.env.example` for all supported settings. The most security-sensitive values are:

- `OAUTH_CONSENT_PIN`
- `OAUTH_STORE_PATH`
- `ALLOWED_REDIRECT_URIS`
- `REQUIRE_EXACT_REDIRECT_URIS`
- `ALLOWED_REDIRECT_ORIGINS`
- `CORS_ALLOWED_ORIGINS`
- `ALLOW_NON_LOOPBACK_BIND`

Keep `.env` and `.data` out of source control. Both are ignored by `.gitignore`.
