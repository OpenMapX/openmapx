/**
 * Provider HTTP path gate.
 *
 * Server-side integration code and the shared provider packages choose one of
 * three HTTP paths (see "Choosing the HTTP path" in
 * docs/docs/developer/integration-system.md). The analysis lives in the
 * extension CLI's policy library so that extension authors run the same rules;
 * it refuses raw `fetch`, `fetchJson` in a module that reads a credential, and
 * a coordinate that falls back to zero.
 *
 * Integration code is the server module graph: each integration's `index.ts`
 * and its `.ts` package exports, followed through relative imports. Browser
 * modules that call the app's own API are not part of it. Each exception names
 * the exact number of findings in one file and the reason they are acceptable.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listModules,
  serverModuleGraph,
} from "../packages/extension-cli/src/policy/module-graph.ts";
import {
  checkProviderHttp,
  type ProviderHttpExceptions,
} from "../packages/extension-cli/src/policy/provider-http.ts";

export type {
  ProviderHttpException,
  ProviderHttpExceptions,
  ProviderHttpFinding,
  ProviderHttpRule,
} from "../packages/extension-cli/src/policy/provider-http.ts";
export {
  checkProviderHttp,
  findProviderHttpFindings,
  readsCredential,
} from "../packages/extension-cli/src/policy/provider-http.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS = "integrations";
/** Shared provider packages scanned in full. */
const PACKAGE_ROOTS = [
  "packages/integration-framework/src",
  "packages/mobility-core/src",
  "packages/noaa-coops-data",
  "packages/ourairports-data",
  "packages/open-landmarks-client",
  "packages/entur-client/src",
  "packages/otp-client/src",
  "packages/provider-kit/src",
];
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "__tests__",
  "__fixtures__",
  "testing",
  "scripts",
]);

export const EXCEPTIONS: ProviderHttpExceptions = {
  "raw-fetch": {
    "integrations/geocoding-motis/provider.ts": {
      count: 1,
      reason: "Readiness probe of the operator's local MOTIS instance, not a provider request.",
    },
    "integrations/search-nlp/index.ts": {
      count: 1,
      reason:
        "Asks the local Ollama service to pull a model; the pull deliberately has no duration bound.",
    },
  },
  "credentialed-fetch-json": {},
  "null-island": {},
};

function exportedEntries(packageJson: string): string[] {
  const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { exports?: unknown };
  const entries: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") entries.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(manifest.exports);
  return entries;
}

/** The server module graph of every integration. */
function integrationServerModules(): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(join(ROOT, INTEGRATIONS), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name === "__tests__") continue;
    const directory = join(ROOT, INTEGRATIONS, entry.name);
    entries.push(join(directory, "index.ts"));
    const packageJson = join(directory, "package.json");
    if (existsSync(packageJson)) {
      entries.push(...exportedEntries(packageJson).map((path) => join(directory, path)));
    }
  }
  return serverModuleGraph(entries, SKIPPED_DIRECTORIES);
}

function main(): void {
  const paths = [
    ...integrationServerModules(),
    ...PACKAGE_ROOTS.flatMap((root) => listModules(join(ROOT, root), SKIPPED_DIRECTORIES)),
  ];
  const modules = new Map<string, string>();
  for (const path of paths) {
    modules.set(relative(ROOT, path).split(sep).join("/"), readFileSync(path, "utf8"));
  }
  const failures = checkProviderHttp(modules, EXCEPTIONS);
  if (failures.length > 0) {
    console.error("Provider HTTP check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  const listed = Object.values(EXCEPTIONS).reduce(
    (total, entries) => total + Object.keys(entries).length,
    0,
  );
  console.log(`Provider HTTP check passed: ${modules.size} modules, ${listed} listed exceptions.`);
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) main();
