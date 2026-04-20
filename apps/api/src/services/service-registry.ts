import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { services } from "@openmapx/core/server";

const {
  DEFAULT_SELECTED_SERVICE_IDS,
  expandServiceSelection,
  normalizeServiceIds,
  parseServiceIdList,
  resolveRequirement,
  SERVICE_SELECTION_ENV,
  ServiceRegistry,
} = services;
type IntegrationManifestRequires = NonNullable<services.IntegrationRequirement[] | undefined>;

let registry: InstanceType<typeof ServiceRegistry> | null = null;
const warnings: string[] = [];
const SERVICE_SELECTION_FILE = "service-selection.json";

function readSelectionFile(rootDir: string): string[] | null {
  const filePath = join(rootDir, "infra", "docker", SERVICE_SELECTION_FILE);
  if (!existsSync(filePath)) return null;

  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as { selected?: unknown };
  if (!Array.isArray(raw.selected)) {
    throw new Error(`Malformed service selection file at ${filePath}: expected "selected" array`);
  }

  return normalizeServiceIds(raw.selected);
}

export async function initServiceRegistry(): Promise<void> {
  // Reset warnings on each init so a hot-reload path doesn't accumulate stale entries.
  warnings.length = 0;
  const rootDir = resolve(process.cwd(), "..", "..");
  registry = new ServiceRegistry({ rootDir, warnings });
  await registry.load();
  const envSelection = parseServiceIdList(process.env[SERVICE_SELECTION_ENV]);
  let fileSelection: string[] | null = null;
  if (envSelection === null) {
    try {
      fileSelection = readSelectionFile(rootDir);
    } catch (error) {
      warnings.push((error as Error).message);
    }
  }
  const selection = expandServiceSelection(
    registry.list(),
    envSelection ?? fileSelection ?? DEFAULT_SELECTED_SERVICE_IDS,
    {
      allowMissingSelected: envSelection === null && fileSelection === null,
    },
  );
  if (selection.missingIds.length > 0) {
    warnings.push(`Selected service(s) are not installed: ${selection.missingIds.join(", ")}`);
  }
  warnings.push(...selection.warnings);
  registry.applyEnabledIds(selection.enabledIds);
}

export function getServiceRegistry(): InstanceType<typeof ServiceRegistry> {
  if (!registry) throw new Error("Service registry not initialized");
  return registry;
}

export function getServiceRegistryWarnings(): string[] {
  return [...warnings];
}

/**
 * Resolve a reachable URL for a service by its id, using internal Docker networking.
 * Services only expose `expose:` ports (no host binding by default), reachable by
 * service hostname within the `openmapx` network.
 */
export function serviceUrl(serviceId: string): string | null {
  if (!registry) return null;
  const svc = registry.get(serviceId);
  if (!svc?.enabled) return null;
  const port = svc.manifest.container.expose?.[0];
  if (!port) return null;
  return `http://${serviceId}:${port}`;
}

export interface ResolvedRequiredService {
  serviceId: string;
  url: string;
  enabled: boolean;
}

export interface ResolveRequiresOptions {
  manifestId: string;
  requires: IntegrationManifestRequires | undefined;
  loadedServices: ReturnType<InstanceType<typeof ServiceRegistry>["list"]>;
  bindings: Map<string, string>;
  /** Called for each unsatisfied non-optional requirement so the caller can warn. */
  onUnsatisfied?: (req: services.IntegrationRequirement, reason: string) => void;
}

/**
 * Resolve every `requires:` entry on an integration manifest into a map keyed by
 * service slug or capability name. Used by both `initIntegrations` and the
 * dev-mode reload path so behaviour stays consistent across cold start + reload.
 */
export function resolveRequiresForIntegration(
  opts: ResolveRequiresOptions,
): Map<string, ResolvedRequiredService> {
  const out = new Map<string, ResolvedRequiredService>();
  if (!registry) return out;

  for (const req of opts.requires ?? []) {
    const result = resolveRequirement(opts.loadedServices, req, { bindings: opts.bindings });
    if (!result.satisfied || !result.match) {
      if (!req.optional) {
        opts.onUnsatisfied?.(req, result.reason ?? "unknown");
      }
      continue;
    }

    // requireEntrySchema's refine guarantees exactly one of service/capability is set.
    const key = req.service ?? req.capability;
    if (!key) continue;

    const url = serviceUrl(result.match.serviceId);
    if (!url) continue;

    const svc = registry.get(result.match.serviceId);
    out.set(key, {
      serviceId: result.match.serviceId,
      url,
      enabled: svc?.enabled ?? false,
    });
  }

  return out;
}
