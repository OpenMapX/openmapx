import { join } from "node:path";
import { findRepoRoot, services } from "@openmapx/core/server";
import { readCommunityServices } from "./community-repositories";

const {
  APPLIED_SERVICES_ENV,
  expandServiceSelection,
  parseServiceIdList,
  readAppliedServiceIds,
  readDesiredSelection,
  resolveRequirement,
  ServiceRegistry,
} = services;
type IntegrationManifestRequires = NonNullable<services.IntegrationRequirement[] | undefined>;

let registry: InstanceType<typeof ServiceRegistry> | null = null;
const warnings: string[] = [];

/**
 * The services the applied generation enabled. Its render bakes them into
 * app-api; an API running on the host (development) reads the deployment
 * itself, and before any render, the operator's selection.
 */
function appliedServiceIds(
  rootDir: string,
  loaded: readonly services.LoadedService[],
): ReadonlySet<string> {
  const baked = parseServiceIdList(process.env[APPLIED_SERVICES_ENV]);
  if (baked) return new Set(baked);
  const infraDir = join(rootDir, "infra", "docker");
  const applied = readAppliedServiceIds(infraDir, loaded);
  if (applied) return applied;
  const desired = readDesiredSelection(infraDir);
  const selection = expandServiceSelection([...loaded], desired.roots, {
    allowMissingSelected: desired.source === "default",
  });
  if (selection.missingIds.length > 0) {
    warnings.push(`Selected service(s) are not installed: ${selection.missingIds.join(", ")}`);
  }
  warnings.push(...selection.warnings);
  return selection.enabledIds;
}

const COMMUNITY_READ_TIMEOUT_MS = 15_000;
const COMMUNITY_RETRY_MS = 60_000;
const AGENT_UNREACHABLE = "The operations agent is unreachable";

interface CommunityServices {
  services: services.LoadedService[];
  repositoryByService: Map<string, string>;
}

/** The last community services the operations agent reported. */
let lastCommunityServices: CommunityServices | null = null;
let communityRetry: NodeJS.Timeout | null = null;

function scheduleCommunityRetry(): void {
  if (communityRetry) return;
  communityRetry = setTimeout(() => {
    communityRetry = null;
    refreshCommunityServices().catch(() => {});
  }, COMMUNITY_RETRY_MS);
  communityRetry.unref();
}

/**
 * Community services from the operations agent, which owns its community
 * store; the app-api container has no host checkout. While the
 * agent is unreachable the last reported list stays in use and a retry is
 * scheduled, unless `strict` asks for the failure instead. An API run on the
 * host without an agent configured (development) returns null and scans the
 * checkout instead.
 */
async function readAgentCommunityServices(strict: boolean): Promise<CommunityServices | null> {
  if (!process.env.OPS_AGENT_URL?.trim()) return null;
  try {
    const snapshot = await readCommunityServices({
      signal: AbortSignal.timeout(COMMUNITY_READ_TIMEOUT_MS),
    });
    for (let index = warnings.length - 1; index >= 0; index -= 1) {
      if (warnings[index]?.startsWith(AGENT_UNREACHABLE)) warnings.splice(index, 1);
    }
    warnings.push(...snapshot.problems);
    lastCommunityServices = {
      services: snapshot.services.map((service) => ({
        // Nothing verifies a repository's own label, so the admin never shows
        // one of its services as verified.
        manifest: { ...service.manifest, quality: "community" },
        directory: service.directory,
        isBuiltIn: false,
        enabled: false,
      })),
      repositoryByService: new Map(
        snapshot.services.map((service) => [service.manifest.id, service.repository]),
      ),
    };
  } catch (error) {
    if (strict) throw error;
    warnings.push(
      lastCommunityServices
        ? `${AGENT_UNREACHABLE}; community services are shown as last reported.`
        : `${AGENT_UNREACHABLE}; community services are not shown yet.`,
    );
    scheduleCommunityRetry();
  }
  return lastCommunityServices ?? { services: [], repositoryByService: new Map() };
}

/** The enabled set last applied to the registry, including ids it has not loaded yet. */
let appliedIds: ReadonlySet<string> = new Set();

class ApiServiceRegistry extends ServiceRegistry {
  override applyEnabledIds(enabledIds: Set<string>): void {
    appliedIds = new Set(enabledIds);
    super.applyEnabledIds(enabledIds);
  }
}

async function loadRegistry(
  community: CommunityServices | null,
): Promise<InstanceType<typeof ServiceRegistry>> {
  const next = new ApiServiceRegistry({
    rootDir: findRepoRoot(),
    warnings,
    ...(community ? { communityServices: community.services } : {}),
  });
  await next.load();
  return next;
}

/**
 * Load the registry and the services the applied generation enabled. With
 * `strict`, an unreachable operations agent fails the call instead of falling
 * back to the last reported community services; an extension change must see
 * what the agent holds now.
 */
export async function initServiceRegistry(options: { strict?: boolean } = {}): Promise<void> {
  // Reset warnings on each init so a hot-reload path doesn't accumulate stale entries.
  warnings.length = 0;
  const next = await loadRegistry(await readAgentCommunityServices(options.strict === true));
  next.applyEnabledIds(new Set(appliedServiceIds(findRepoRoot(), next.list())));
  registry = next;
}

/**
 * Pick up the agent's community services after it was unreachable, keeping the
 * enabled set last applied rather than re-reading the selection baked in at
 * startup. That set can name community services the registry only now loads.
 */
async function refreshCommunityServices(): Promise<void> {
  const next = await loadRegistry(await readAgentCommunityServices(false));
  if (!registry) return;
  next.applyEnabledIds(new Set(appliedIds));
  registry = next;
}

/** The repository a community service was installed from, as the operations agent reports it. */
export function communityServiceRepository(serviceId: string): string | undefined {
  return lastCommunityServices?.repositoryByService.get(serviceId);
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
