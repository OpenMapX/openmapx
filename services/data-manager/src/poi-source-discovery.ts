import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type PoiSource,
  registerPoiSources as registerPoiSourcesInStore,
} from "@openmapx/poi-source-registry";

export interface DiscoveryLogger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface DiscoveryOptions {
  /** Repo root — typically OPENMAPX_ROOT_DIR. Required. */
  rootDir: string;
  /** Optional community integrations dir — typically OPENMAPX_CUSTOM_INTEGRATIONS_DIR. */
  customIntegrationsDir?: string;
  logger: DiscoveryLogger;
  /** Test seam: inject a custom dynamic-importer (default: native import()). */
  importModule?: (url: string) => Promise<unknown>;
}

export interface DiscoveryResult {
  /** Total integration dirs scanned across both roots. */
  scanned: number;
  /** Integrations whose poi-sources module was importable. */
  withSources: number;
  /** Sum of sources from successful declarePoiSources() calls. */
  registered: number;
  /** Integrations where loading failed (logged + swallowed). */
  errors: Array<{ integration: string; reason: string }>;
}

const POI_SOURCES_BASENAMES = ["poi-sources.js", "poi-sources.ts"] as const;

function listIntegrationDirs(parent: string | undefined): string[] {
  if (!parent || !existsSync(parent)) return [];
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const full = join(parent, name);
    try {
      if (statSync(full).isDirectory()) dirs.push(full);
    } catch {
      // Skip unreadable entries.
    }
  }
  return dirs;
}

function findPoiSourcesFile(integrationDir: string): string | null {
  for (const basename of POI_SOURCES_BASENAMES) {
    const candidate = join(integrationDir, basename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isPoiSourceArray(value: unknown): value is PoiSource[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== "object" || item === null) return false;
    if (typeof (item as { domain?: unknown }).domain !== "string") return false;
    // A source is identified by EITHER an explicit `id` (global sources) OR
    // structured `parts` from which `registerPoiSource` derives the id/prefix.
    const hasId = typeof (item as { id?: unknown }).id === "string";
    const parts = (item as { parts?: unknown }).parts;
    const hasParts = typeof parts === "object" && parts !== null;
    if (!hasId && !hasParts) return false;
  }
  return true;
}

/**
 * Walks integration dirs under rootDir + optional customIntegrationsDir,
 * dynamically imports each `poi-sources.{js,ts}` module, calls
 * `declarePoiSources()`, and feeds the result into the shared registry.
 *
 * Failures are isolated per integration — one broken community module does
 * not crash the data-manager. The drift guard (A-bis.4) surfaces persistent
 * cross-process discrepancies.
 *
 * Prod note: data-manager runs `tsx` in dev (.ts imports work) and node in
 * prod (.js only). For .ts files to load in prod, the runtime must include
 * a tsx/esm loader hook (--import tsx); otherwise that integration is
 * skipped with a warning.
 */
export async function discoverPoiSources(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const importFn = opts.importModule ?? ((url: string) => import(url));
  const builtin = listIntegrationDirs(resolve(opts.rootDir, "integrations"));
  const community = listIntegrationDirs(opts.customIntegrationsDir);
  const dirs = [...builtin, ...community];

  const result: DiscoveryResult = {
    scanned: dirs.length,
    withSources: 0,
    registered: 0,
    errors: [],
  };

  for (const dir of dirs) {
    const integrationName = dir.split("/").pop() ?? dir;
    const file = findPoiSourcesFile(dir);
    if (!file) continue;

    try {
      const mod = (await importFn(pathToFileURL(file).href)) as {
        declarePoiSources?: unknown;
      };
      const decl = mod.declarePoiSources;
      if (typeof decl !== "function") {
        opts.logger.warn(
          "poi-source-discovery: poi-sources module has no declarePoiSources() export",
          { integration: integrationName, file },
        );
        continue;
      }
      const declared = await (decl as () => unknown | Promise<unknown>)();
      if (!isPoiSourceArray(declared)) {
        opts.logger.warn("poi-source-discovery: declarePoiSources() did not return PoiSource[]", {
          integration: integrationName,
          file,
        });
        continue;
      }
      // The registry warn-and-drops cross-integration id collisions; we add
      // an integration prefix so log lines are attributable.
      registerPoiSourcesInStore(declared, {
        warn: (msg: string, ...args: unknown[]) => {
          const extra = args[0];
          if (extra && typeof extra === "object" && !Array.isArray(extra)) {
            opts.logger.warn(`[${integrationName}] ${msg}`, extra as Record<string, unknown>);
          } else {
            opts.logger.warn(`[${integrationName}] ${msg}`);
          }
        },
      });
      result.withSources += 1;
      result.registered += declared.length;
    } catch (err) {
      const reason = (err as Error).message;
      result.errors.push({ integration: integrationName, reason });
      opts.logger.warn("poi-source-discovery: failed to load integration poi-sources", {
        integration: integrationName,
        file,
        err: reason,
      });
    }
  }

  opts.logger.info("poi-source-discovery: scan complete", {
    scanned: result.scanned,
    withSources: result.withSources,
    registered: result.registered,
    errorCount: result.errors.length,
  });

  return result;
}
