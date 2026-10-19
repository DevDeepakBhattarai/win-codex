import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { parse as parseDotenv } from "dotenv";

const DEFAULT_TUNNEL = "none";
const TUNNEL_PROVIDERS = new Set(["none", "cloudflare", "tailscale"]);
const AMBIENT_ENVIRONMENT = { ...process.env };
const TUNNEL_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "USERNAME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);
const TUNNEL_ENVIRONMENT_PREFIXES = ["TAILSCALE_", "TS_", "CLOUDFLARED_", "TUNNEL_"];

function loadApplicationEnvironment() {
  let fileEnvironment = {};
  try {
    fileEnvironment = parseDotenv(readFileSync(".env"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { ...fileEnvironment, ...AMBIENT_ENVIRONMENT };
}

const APPLICATION_ENVIRONMENT = loadApplicationEnvironment();

export function tunnelEnvironmentFrom(environment) {
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (
      TUNNEL_ENVIRONMENT_KEYS.has(normalized) ||
      TUNNEL_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

const TUNNEL_ENVIRONMENT = tunnelEnvironmentFrom(AMBIENT_ENVIRONMENT);

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument === name) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    return { value, consumed: 2 };
  }
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (!value) {
      throw new Error(`${name} requires a value.`);
    }
    return { value, consumed: 1 };
  }
  return undefined;
}

export function parseStartArgs(argv) {
  const options = {
    tunnel: DEFAULT_TUNNEL,
    tunnelName: AMBIENT_ENVIRONMENT.CLOUDFLARE_TUNNEL_NAME ?? "local",
    help: false,
  };

  for (let index = 0; index < argv.length;) {
    const argument = argv[index];
    if (argument === "--") {
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      index += 1;
      continue;
    }

    const tunnel = readOption(argv, index, "--tunnel");
    if (tunnel) {
      options.tunnel = tunnel.value.toLowerCase();
      index += tunnel.consumed;
      continue;
    }

    const tunnelName = readOption(argv, index, "--tunnel-name");
    if (tunnelName) {
      options.tunnelName = tunnelName.value;
      index += tunnelName.consumed;
      continue;
    }

    throw new Error(`Unknown start option: ${argument}`);
  }

  if (options.help) return options;
  if (!TUNNEL_PROVIDERS.has(options.tunnel)) {
    throw new Error(`--tunnel must be one of: ${[...TUNNEL_PROVIDERS].join(", ")}.`);
  }
  if (options.tunnel === "cloudflare" && !/^[a-zA-Z0-9_-]+$/.test(options.tunnelName)) {
    throw new Error("--tunnel-name must contain only letters, digits, underscores, and hyphens.");
  }
  return options;
}

export function tailscaleInfoFromStatus(status) {
  if (!status || status.BackendState !== "Running") {
    throw new Error("Tailscale is not connected. Start Tailscale and sign in before using --tunnel tailscale.");
  }
  const self = status.Self;
  const dnsName = typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
  if (!dnsName) {
    throw new Error("Tailscale did not report a MagicDNS name for this device.");
  }
  const capabilities = [
    ...(Array.isArray(self?.Capabilities) ? self.Capabilities : []),
    ...Object.keys(self?.CapMap ?? {}),
  ];
  const funnelEnabled = capabilities.some((capability) => {
    const value = String(capability).toLowerCase();
    return value === "funnel" || value === "https://tailscale.com/cap/funnel";
  });
  const nodeId = typeof self?.ID === "string" ? self.ID : "";
  return {
    publicBaseUrl: `https://${dnsName}`,
    funnelEnabled,
    enableUrl: nodeId ? `https://login.tailscale.com/f/funnel?node=${encodeURIComponent(nodeId)}` : undefined,
  };
}

function execText(executable, args) {
  return execFileSync(executable, args, {
    encoding: "utf8",
    env: TUNNEL_ENVIRONMENT,
    timeout: 15_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function readTailscaleInfo(executable) {
  let rawStatus;
  try {
    rawStatus = execText(executable, ["status", "--json"]);
  } catch (error) {
    const details = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Unable to read Tailscale status.${details ? `\n${details}` : ""}`);
  }

  let status;
  try {
    status = JSON.parse(rawStatus);
  } catch {
    throw new Error("Tailscale returned invalid JSON from `tailscale status --json`.");
  }
  return tailscaleInfoFromStatus(status);
}

export function configureTailscaleFunnel(executable, port) {
  const info = readTailscaleInfo(executable);
  if (!info.funnelEnabled) {
    const suffix = info.enableUrl ? ` Enable it once at:\n${info.enableUrl}` : "";
    throw new Error(`Tailscale Funnel is not enabled for this device.${suffix}`);
  }
  try {
    execText(executable, ["funnel", "--bg", "--yes", String(port)]);
  } catch (error) {
    const details = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Unable to configure Tailscale Funnel for local port ${port}.${details ? `\n${details}` : ""}`);
  }
  return info;
}

function printHelp() {
  console.log(`Usage: pnpm start -- [options]\n\nOptions:\n  --tunnel <none|cloudflare|tailscale>  Tunnel provider to start (default: none)\n  --tunnel-name <name>                  Cloudflare named tunnel (default: local)\n  -h, --help                            Show this help\n\nExamples:\n  pnpm start\n  pnpm start -- --tunnel tailscale\n  pnpm start -- --tunnel cloudflare --tunnel-name local`);
}

function executableFor(provider) {
  if (provider === "tailscale") {
    return APPLICATION_ENVIRONMENT.TAILSCALE_EXECUTABLE ?? (process.platform === "win32" ? "tailscale.exe" : "tailscale");
  }
  if (provider === "cloudflare") {
    return APPLICATION_ENVIRONMENT.CLOUDFLARED_EXECUTABLE ?? (process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  }
  return undefined;
}

function numericPort() {
  const port = Number(APPLICATION_ENVIRONMENT.PORT ?? 6000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function publicEnvironment(publicBaseUrl) {
  return {
    ...APPLICATION_ENVIRONMENT,
    PUBLIC_BASE_URL: publicBaseUrl,
    MCP_PUBLIC_URL: `${publicBaseUrl}/mcp`,
    AUTH_ISSUER: publicBaseUrl,
  };
}

async function startCloudflareTunnel(options) {
  const executable = executableFor("cloudflare");
  const child = spawn(executable, ["tunnel", "run", options.tunnelName], {
    cwd: process.cwd(),
    env: TUNNEL_ENVIRONMENT,
    stdio: "inherit",
    windowsHide: true,
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.removeListener("error", onError);
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });

  if (child.exitCode !== null) {
    throw new Error(`Cloudflare tunnel exited during startup with code ${child.exitCode}.`);
  }
  return child;
}

function startServer(environment) {
  return spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
    windowsHide: false,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseStartArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  let environment = APPLICATION_ENVIRONMENT;
  let tunnelProcess;

  if (options.tunnel === "tailscale") {
    const port = numericPort();
    const info = configureTailscaleFunnel(executableFor("tailscale"), port);
    environment = publicEnvironment(info.publicBaseUrl);
    console.log(`Tailscale Funnel: ${info.publicBaseUrl}`);
    console.log(`MCP URL:          ${info.publicBaseUrl}/mcp`);
    console.log(`Authorization:    ${info.publicBaseUrl}/oauth/authorize`);
    console.log(`Token URL:        ${info.publicBaseUrl}/oauth/token`);
  } else if (options.tunnel === "cloudflare") {
    try {
      tunnelProcess = await startCloudflareTunnel(options);
    } catch (error) {
      throw new Error(`Cloudflare tunnel failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    const configuredBase = APPLICATION_ENVIRONMENT.PUBLIC_BASE_URL;
    console.log(`Cloudflare tunnel: ${options.tunnelName}`);
    if (configuredBase) {
      console.log(`Public URL:        ${configuredBase}`);
      console.log(`MCP URL:           ${APPLICATION_ENVIRONMENT.MCP_PUBLIC_URL ?? `${configuredBase.replace(/\/$/, "")}/mcp`}`);
    } else {
      console.log("Set PUBLIC_BASE_URL in .env to the public hostname routed by the named Cloudflare tunnel.");
    }
  }

  const serverProcess = startServer(environment);
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (tunnelProcess && !tunnelProcess.killed) tunnelProcess.kill(signal);
    if (!serverProcess.killed) serverProcess.kill(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  serverProcess.on("error", (error) => {
    console.error(`MCP server failed to start: ${error.message}`);
    shuttingDown = true;
    if (tunnelProcess && !tunnelProcess.killed) tunnelProcess.kill();
    process.exitCode = 1;
  });
  serverProcess.on("exit", (code, signal) => {
    if (tunnelProcess && !tunnelProcess.killed) tunnelProcess.kill();
    if (shuttingDown) {
      if (process.exitCode === undefined) process.exitCode = code ?? 0;
      return;
    }
    if (signal) console.error(`MCP server exited from signal ${signal}.`);
    process.exitCode = code ?? (signal ? 1 : 0);
  });

  if (tunnelProcess) {
    const failTunnel = (message) => {
      if (shuttingDown) return;
      console.error(message);
      shuttingDown = true;
      if (!serverProcess.killed) serverProcess.kill();
      process.exitCode = 1;
    };
    tunnelProcess.on("error", (error) => {
      failTunnel(`Cloudflare tunnel failed: ${error.message}`);
    });
    tunnelProcess.on("exit", (code, signal) => {
      failTunnel(`Cloudflare tunnel exited unexpectedly (${signal ?? `code ${code ?? 0}`}).`);
    });
    if (tunnelProcess.exitCode !== null) {
      failTunnel(`Cloudflare tunnel exited unexpectedly (code ${tunnelProcess.exitCode}).`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
