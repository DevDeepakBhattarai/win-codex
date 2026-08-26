import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const SOURCE_ASSIGNMENT = /\b(source\d*) = /g;
const SOURCE_TERMINATOR = ";\n  }\n});";
const MINIMUM_SOURCE_LENGTH = 100_000;

let cachedInstallExpression: Promise<string> | undefined;

export function getPlaywrightInstallExpression(): Promise<string> {
  cachedInstallExpression ??= buildPlaywrightInstallExpression();
  return cachedInstallExpression;
}

async function buildPlaywrightInstallExpression() {
  const packageJsonPath = require.resolve("playwright-core/package.json");
  const bundlePath = path.join(path.dirname(packageJsonPath), "lib", "coreBundle.js");
  const bundle = await readFile(bundlePath, "utf8");
  const source = extractInjectedRuntime(bundle, bundlePath);

  const options = JSON.stringify({
    isUnderTest: false,
    sdkLanguage: "javascript",
    testIdAttributeName: "data-testid",
    stableRafCount: 1,
    browserName: "chromium",
    shouldPrependErrorPrefix: false,
    isUtilityWorld: false,
    customEngines: [],
  });

  // T3 Code (MIT) uses the same technique: extract Playwright's own injected
  // locator runtime and install it in the page through CDP. The generated
  // variable number changes between Playwright releases, so identify the
  // payload by the InjectedScript export rather than hard-coding source3/source4.
  return `(() => {
    if (globalThis.__localCodexPlaywrightInjected) return true;
    const module = { exports: {} };
    ${source}
    globalThis.__localCodexPlaywrightInjected = new (module.exports.InjectedScript())(globalThis, ${options});
    return true;
  })()`;
}

function extractInjectedRuntime(bundle: string, bundlePath: string) {
  for (const match of bundle.matchAll(SOURCE_ASSIGNMENT)) {
    if (match.index === undefined) continue;
    const literalStart = match.index + match[0].length;
    const literalEnd = bundle.indexOf(SOURCE_TERMINATOR, literalStart);
    if (literalEnd < 0) continue;

    const literal = bundle.slice(literalStart, literalEnd);
    let candidate: unknown;
    try {
      candidate = vm.runInNewContext(literal, Object.create(null), { timeout: 1_000 });
    } catch {
      continue;
    }
    if (
      typeof candidate === "string" &&
      candidate.length >= MINIMUM_SOURCE_LENGTH &&
      candidate.includes("InjectedScript")
    ) {
      return candidate;
    }
  }
  throw new Error(`Could not extract Playwright's InjectedScript runtime from ${bundlePath}.`);
}
