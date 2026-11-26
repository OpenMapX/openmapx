/**
 * Integration cache-write gate.
 *
 * A direct `ctx.cache.set` fences only its own invocation. Written after an
 * upstream request, it can refill a namespace that an admin cleared while the
 * request was in flight. Integration code stores upstream results through
 * `withCache` or through a writer from `captureCacheWriter`, both of which
 * capture the fence before the request (see "The integration context" in
 * docs/docs/developer/integration-system.md).
 *
 * The analysis lives in the extension CLI's policy library so that extension
 * authors run the same rule. In-memory maps that happen to be named `cache` and
 * writes that store no upstream result are listed below with the reason.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CacheWriteException,
  checkCacheWrites,
} from "../packages/extension-cli/src/policy/cache-writes.ts";
import { listModules } from "../packages/extension-cli/src/policy/module-graph.ts";

export type {
  CacheWriteException,
  DirectCacheWrite,
} from "../packages/extension-cli/src/policy/cache-writes.ts";
export {
  checkCacheWrites,
  findDirectCacheWrites,
} from "../packages/extension-cli/src/policy/cache-writes.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Integration code and the shared packages that receive an integration's cache. */
const SCAN_ROOTS = [
  "integrations",
  "packages/integration-framework/src",
  "packages/mobility-core/src",
  "packages/noaa-coops-data",
  "packages/provider-kit/src",
];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "__tests__", "__fixtures__"]);
/** Unlike the provider HTTP gate, which follows server imports only, this one also reads `.tsx`. */
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mts"];

export const EXCEPTIONS: Readonly<Record<string, CacheWriteException>> = {
  "integrations/transit/refresh-session.ts": {
    count: 1,
    reason: "The write stores trip refresh-token session state, not an upstream result.",
  },
  "integrations/transit-motis/rentals-capability.ts": {
    count: 1,
    reason: "`cache` is a module-level in-memory Map, not the integration cache.",
  },
  "integrations/bike-sharing/providers/db-bike-client.ts": {
    count: 1,
    reason: "`cache` is an in-memory Map owned by the provider, not the integration cache.",
  },
  "integrations/geocoding/mem-cache.ts": {
    count: 1,
    reason: "`this.cache` is the process-local LRU behind the autocomplete L1.",
  },
  "integrations/knowledge-sun-time/index.ts": {
    count: 1,
    reason:
      "The /timezone entry comes from the bundled geo-tz lookup; no upstream request precedes the write.",
  },
  "integrations/search-nlp/index.ts": {
    count: 2,
    reason:
      "A development-only parse quota counter and a provider breaker flag; neither stores an upstream result.",
  },
};

function main(): void {
  const modules = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const path of listModules(join(ROOT, root), SKIPPED_DIRECTORIES, SCANNED_EXTENSIONS)) {
      modules.set(relative(ROOT, path).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  }
  const failures = checkCacheWrites(modules, EXCEPTIONS);
  if (failures.length > 0) {
    console.error("Integration cache-write check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Integration cache-write check passed: ${modules.size} modules, ${Object.keys(EXCEPTIONS).length} listed exceptions.`,
  );
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) main();
