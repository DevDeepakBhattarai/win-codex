import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseStartArgs,
  tailscaleInfoFromStatus,
  tunnelEnvironmentFrom,
} from "./start.mjs";

function runStart(args, environment = {}) {
  return spawnSync(process.execPath, ["scripts/start.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...environment },
    timeout: 5_000,
    windowsHide: true,
  });
}

function createWindowsStartupFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "local-control-tunnel-test-"));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(path.join(root, "assets"), { recursive: true });
  copyFileSync("assets/local-codex.ico", path.join(root, "assets", "local-codex.ico"));
  copyFileSync("scripts/install-startup.ps1", path.join(root, "scripts", "install-startup.ps1"));
  copyFileSync("scripts/connector-watchdog.ps1", path.join(root, "scripts", "connector-watchdog.ps1"));
  writeFileSync(path.join(root, "dist", "server.js"), "process.exit(0);\n");
  writeFileSync(path.join(root, "scripts", "start-browser.mjs"), "process.exit(0);\n");
  writeFileSync(path.join(root, ".env"), "PORT=46241\nHOST=127.0.0.1\n");
  return root;
}

test("parseStartArgs defaults to no tunnel", () => {
  assert.deepEqual(parseStartArgs([]), {
    tunnel: "none",
    tunnelName: process.env.CLOUDFLARE_TUNNEL_NAME ?? "local",
    help: false,
  });
});

test("parseStartArgs accepts Tailscale and Cloudflare options", () => {
  assert.equal(parseStartArgs(["--tunnel", "tailscale"]).tunnel, "tailscale");
  assert.deepEqual(parseStartArgs(["--tunnel=cloudflare", "--tunnel-name", "office"]), {
    tunnel: "cloudflare",
    tunnelName: "office",
    help: false,
  });
});

test("parseStartArgs validates tunnel names only for Cloudflare", () => {
  assert.throws(
    () => parseStartArgs(["--tunnel", "cloudflare", "--tunnel-name", "bad name"]),
    /tunnel-name/,
  );
  assert.doesNotThrow(() => parseStartArgs(["--tunnel", "tailscale", "--tunnel-name", "bad name"]));
});

test("help ignores an invalid ambient Cloudflare tunnel name", () => {
  const result = runStart(["--help"], { CLOUDFLARE_TUNNEL_NAME: "bad name" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--tunnel <none\|cloudflare\|tailscale>/);
});

test("tunnel subprocess environment excludes application secrets", () => {
  const environment = tunnelEnvironmentFrom({
    PATH: "C:\\Windows\\System32",
    USERPROFILE: "C:\\Users\\example",
    OPENAI_API_KEY: "secret-openai-key",
    OAUTH_CONSENT_PIN: "123456",
    TAILSCALE_SOCKET: "example-socket",
    CLOUDFLARED_CONFIG: "example-config",
    TUNNEL_TOKEN: "example-cloudflare-token",
  });

  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.USERPROFILE, "C:\\Users\\example");
  assert.equal(environment.TAILSCALE_SOCKET, "example-socket");
  assert.equal(environment.CLOUDFLARED_CONFIG, "example-config");
  assert.equal(environment.TUNNEL_TOKEN, "example-cloudflare-token");
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OAUTH_CONSENT_PIN, undefined);
});

test("Cloudflare spawn failure exits before starting the MCP server", () => {
  const result = runStart(["--tunnel", "cloudflare", "--tunnel-name", "local"], {
    CLOUDFLARED_EXECUTABLE: "Z:\\definitely-missing\\cloudflared.exe",
    PORT: "46201",
    HOST: "127.0.0.1",
    THREAD_SYNC_ENABLED: "false",
    BROWSER_BRIDGE_ENABLED: "false",
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cloudflare tunnel failed to start/i);
});

test(
  "Cloudflare unexpected exit fails the wrapper after a successful spawn",
  { skip: process.platform !== "win32" },
  () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "local-control-cloudflare-exit-"));
    try {
      const result = runStart(["--tunnel", "cloudflare", "--tunnel-name", "local"], {
        CLOUDFLARED_EXECUTABLE: process.execPath,
        PORT: "46237",
        HOST: "127.0.0.1",
        PUBLIC_BASE_URL: "http://127.0.0.1:46237",
        MCP_PUBLIC_URL: "http://127.0.0.1:46237/mcp",
        AUTH_ISSUER: "http://127.0.0.1:46237",
        DATA_DIR: dataDir,
        THREAD_SYNC_ENABLED: "false",
        BROWSER_BRIDGE_ENABLED: "false",
        RALPH_ENABLED: "false",
      });

      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /Cloudflare tunnel (?:failed to start|exited unexpectedly)/i,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  "startup installer ignores Cloudflare tunnel-name syntax outside Cloudflare mode",
  { skip: process.platform !== "win32" },
  () => {
    const root = createWindowsStartupFixture();
    try {
      const startupDirectory = path.join(root, "startup");
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(root, "scripts", "install-startup.ps1"),
          "-TunnelProvider",
          "none",
          "-TunnelName",
          "bad name",
          "-StartupDirectory",
          startupDirectory,
        ],
        { encoding: "utf8", timeout: 5_000, windowsHide: true },
      );

      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(path.join(startupDirectory, "Local Computer Control MCP.lnk")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Tailscale watchdog retries readiness and gates browser/server startup",
  { skip: process.platform !== "win32" },
  async () => {
    const root = createWindowsStartupFixture();
    const fakeTailscale = path.join(root, "tailscale.cmd");
    writeFileSync(
      fakeTailscale,
      [
        "@echo off",
        'echo check>> "%~dp0status-checks.txt"',
        'if /I "%1"=="status" echo {"BackendState":"Running","Self":{"ID":"fixture-node","DNSName":"fixture.example.ts.net.","CapMap":{}}}',
        "exit /b 0",
        "",
      ].join("\r\n"),
    );

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts", "connector-watchdog.ps1"),
        "-ConnectorDirectory",
        root,
        "-NodeExecutable",
        process.execPath,
        "-TunnelProvider",
        "tailscale",
        "-TailscaleExecutable",
        fakeTailscale,
        "-RetrySeconds",
        "1",
      ],
      { stdio: "ignore", windowsHide: true },
    );

    try {
      const deadline = Date.now() + 15_000;
      let attempts = [];
      while (Date.now() < deadline) {
        const checks = path.join(root, "status-checks.txt");
        if (existsSync(checks)) attempts = readFileSync(checks, "utf8").trim().split(/\r?\n/).filter(Boolean);
        if (attempts.length >= 2 || child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(child.exitCode, null, "watchdog exited instead of retrying");
      const runtime = path.join(root, ".data", "runtime");
      const log = readFileSync(path.join(runtime, "watchdog.log"), "utf8");
      const failures = log.match(/Tailscale Funnel is not enabled/g) ?? [];
      assert.ok(attempts.length >= 2, `expected at least two readiness checks, got ${attempts.length}`);
      assert.equal(failures.length, 1, "unchanged readiness errors are reported once");
      assert.equal(existsSync(path.join(runtime, "browser.stdout.log")), false);
      assert.equal(existsSync(path.join(runtime, "server.stdout.log")), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once("exit", resolve));
        child.kill();
        await stopped;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("tailscaleInfoFromStatus derives the stable public URL", () => {
  const info = tailscaleInfoFromStatus({
    BackendState: "Running",
    Self: {
      ID: "node123",
      DNSName: "workstation.example.ts.net.",
      CapMap: { "https://tailscale.com/cap/funnel": null },
    },
  });
  assert.deepEqual(info, {
    publicBaseUrl: "https://workstation.example.ts.net",
    funnelEnabled: true,
    enableUrl: "https://login.tailscale.com/f/funnel?node=node123",
  });
});

test("tailscaleInfoFromStatus returns the enable URL when Funnel is unavailable", () => {
  const info = tailscaleInfoFromStatus({
    BackendState: "Running",
    Self: { ID: "node456", DNSName: "workstation.example.ts.net.", CapMap: {} },
  });
  assert.equal(info.funnelEnabled, false);
  assert.equal(info.enableUrl, "https://login.tailscale.com/f/funnel?node=node456");
});

test("tailscaleInfoFromStatus does not mistake Funnel port metadata for Funnel permission", () => {
  const info = tailscaleInfoFromStatus({
    BackendState: "Running",
    Self: {
      ID: "node789",
      DNSName: "workstation.example.ts.net.",
      CapMap: { "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000": [] },
    },
  });
  assert.equal(info.funnelEnabled, false);
});

test("tailscaleInfoFromStatus rejects disconnected Tailscale", () => {
  assert.throws(() => tailscaleInfoFromStatus({ BackendState: "Stopped", Self: {} }), /not connected/i);
});
