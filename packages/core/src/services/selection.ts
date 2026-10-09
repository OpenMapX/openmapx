import { readExternalProxyNetwork } from "./external-proxy";
import type { LoadedService, ServiceConsumes, ServiceProduces } from "./types";

export const SERVICE_SELECTION_ENV = "OPENMAPX_ENABLED_SERVICES";
const APP_API_ENV_PASSTHROUGH_PREFIXES = ["INTEGRATION_", "SERVICE_"] as const;

export const DEFAULT_SELECTED_SERVICE_IDS = [
  "traefik",
  "well-known",
  "app-api",
  "app-web",
  "postgis",
  "redis",
  "data-manager",
] as const;

export interface ExpandedServiceSelection {
  /** Operator-requested root service ids before dependency expansion. */
  requestedIds: string[];
  /** Effective enabled ids after adding required dependencies and producers. */
  enabledIds: Set<string>;
  /** Effective enabled ids in registry order, useful for stable env/config output. */
  enabledIdsOrdered: string[];
  /** Requested ids that were not installed. */
  missingIds: string[];
  /** Non-fatal dependency-resolution warnings. */
  warnings: string[];
}

export interface ExpandServiceSelectionOptions {
  /**
   * Default selections are allowed to reference services absent from a reduced
   * test/plugin checkout. Explicit user selections should keep this false.
   */
  allowMissingSelected?: boolean;
  /** Include the built-in proxy when selected services expose proxy routes. */
  includeProxyForProxiedServices?: boolean;
  /**
   * Docker network of an operator-run reverse proxy. While one is configured
   * the bundled `traefik` is never selected, not even as a requested root, so
   * it cannot claim the host's ports 80/443. `undefined` reads
   * `OPENMAPX_PROXY_NETWORK`; `null` ignores the environment.
   */
  externalProxyNetwork?: string | null;
}

interface ProducerEntry {
  producerId: string;
  produces: ServiceProduces;
}

interface ProducerIndex {
  default: Map<string, ProducerEntry>;
  instanced: Map<string, ProducerEntry>;
  byType: Map<string, ProducerEntry[]>;
}

function buildProducerIndex(services: LoadedService[]): ProducerIndex {
  const index: ProducerIndex = {
    default: new Map(),
    instanced: new Map(),
    byType: new Map(),
  };

  for (const svc of services) {
    for (const produces of svc.manifest.produces ?? []) {
      const entry: ProducerEntry = { producerId: svc.manifest.id, produces };
      if (produces.instance === undefined && !index.default.has(produces.type)) {
        index.default.set(produces.type, entry);
      }
      if (produces.instance !== undefined) {
        const key = `${produces.type}/${produces.instance}`;
        if (!index.instanced.has(key)) index.instanced.set(key, entry);
      }
      const list = index.byType.get(produces.type) ?? [];
      list.push(entry);
      index.byType.set(produces.type, list);
    }
  }

  return index;
}

function resolveProducer(consumes: ServiceConsumes, index: ProducerIndex): ProducerEntry | null {
  if (consumes.instance !== undefined) {
    return index.instanced.get(`${consumes.type}/${consumes.instance}`) ?? null;
  }

  const def = index.default.get(consumes.type);
  if (def) return def;

  const candidates = index.byType.get(consumes.type) ?? [];
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export function normalizeServiceIds(ids: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    for (const token of raw.split(/[,\s]+/)) {
      const id = token.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function parseServiceIdList(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  return normalizeServiceIds([raw]);
}

export function formatServiceIdList(ids: Iterable<string>): string {
  return [...ids].join(",");
}

/**
 * Map of service id → env var name for backends that the API reaches via
 * `process.env` rather than through the live service-registry `serviceUrl()`.
 *
 * - `overpass`: `packages/core/src/utils/overpass/client.ts` reads
 *   `process.env.OVERPASS_URL` directly (module-level initialisation).
 * - `nominatim`: `packages/mobility-core/nominatim.ts` reads
 *   `process.env.NOMINATIM_URL` at module load time.
 * - `motis`: `packages/mobility-core/motis-rentals.ts` reads
 *   `process.env.MOTIS_URL` at module load time for the local-MOTIS rentals
 *   instance. (The `apps/api` motis manager additionally consults
 *   `serviceUrl("motis")` at runtime, so this entry mainly fixes the rentals
 *   client.)
 *
 * All other built-in backends (valhalla, osrm, pelias, photon, otp) are
 * resolved at runtime through the live service registry (`serviceUrl()`), so
 * their manifest env-var defaults are never consulted while those services
 * are enabled. `transitous` is a public API only — there is no in-cluster
 * service to point at — so its URL stays as the manifest default.
 *
 * When a service is co-deployed its Docker-internal address replaces the
 * manifest default (public API), unless the operator's env names one.
 */
const SERVICE_ENV_URL_MAP: Array<{ serviceId: string; envVar: string; internalPort: number }> = [
  { serviceId: "overpass", envVar: "OVERPASS_URL", internalPort: 80 },
  { serviceId: "nominatim", envVar: "NOMINATIM_URL", internalPort: 8080 },
  { serviceId: "motis", envVar: "MOTIS_URL", internalPort: 8080 },
];

/**
 * The services a generation enabled, baked into app-api: the API has no view
 * of the deployment files, and `OPENMAPX_ENABLED_SERVICES` stays the
 * operator's override.
 */
export const APPLIED_SERVICES_ENV = "OPENMAPX_APPLIED_SERVICES";

/**
 * app-api's generated environment. It never holds a host env value: env
 * settings are Compose references, resolved from `infra/docker/.env` when the
 * stack starts, so the same render serves the CLI and the ops-agent.
 */
export function buildAppApiServiceEnv(
  enabledServices: LoadedService[],
  existingEnv: Record<string, unknown> = {},
  passthroughKeys: Iterable<string> = [],
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existingEnv,
    [APPLIED_SERVICES_ENV]: formatServiceIdList(
      enabledServices.map((service) => service.manifest.id),
    ),
  };

  // For services that the API reaches via process.env rather than the live
  // service registry, default to the Docker-internal URL when the service is
  // co-deployed, so self-hosted instances are used instead of the public API.
  const enabledIds = new Set(enabledServices.map((s) => s.manifest.id));
  for (const { serviceId, envVar, internalPort } of SERVICE_ENV_URL_MAP) {
    if (enabledIds.has(serviceId)) {
      next[envVar] = `\${${envVar}:-http://${serviceId}:${internalPort}}`;
    }
  }

  // The schema-backed integration and service settings, as references: the
  // values stay in the operator's `.env` and never reach the rendered YAML.
  for (const key of passthroughKeys) {
    if (!APP_API_ENV_PASSTHROUGH_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    next[key] = `\${${key}:-}`;
  }

  return next;
}

export function expandServiceSelection(
  services: LoadedService[],
  requestedIds: Iterable<string>,
  opts: ExpandServiceSelectionOptions = {},
): ExpandedServiceSelection {
  const requested = normalizeServiceIds(requestedIds);
  const byId = new Map(services.map((svc) => [svc.manifest.id, svc]));
  const producerIndex = buildProducerIndex(services);
  const enabledIds = new Set<string>();
  const missingIds: string[] = [];
  const warnings: string[] = [];
  const queue: string[] = [];
  const externalProxy =
    opts.externalProxyNetwork === null
      ? undefined
      : (opts.externalProxyNetwork ?? readExternalProxyNetwork());

  function enqueue(id: string, reason: string): void {
    if (externalProxy && id === "traefik") return;
    const svc = byId.get(id);
    if (!svc) {
      warnings.push(`Service "${id}" referenced by ${reason} is not installed`);
      return;
    }
    if (enabledIds.has(id)) return;
    enabledIds.add(id);
    queue.push(id);
  }

  for (const id of requested) {
    if (byId.has(id)) {
      enqueue(id, "selection");
    } else if (!opts.allowMissingSelected) {
      missingIds.push(id);
    }
  }

  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (!id) continue;
    const svc = byId.get(id);
    if (!svc) continue;

    for (const dependency of svc.manifest.selectionDependencies ?? []) {
      enqueue(dependency, `selectionDependencies of "${id}"`);
    }

    for (const dep of svc.manifest.container.dependsOn ?? []) {
      enqueue(dep.service, `container.dependsOn of "${id}"`);
    }

    if (
      opts.includeProxyForProxiedServices !== false &&
      id !== "traefik" &&
      svc.manifest.exposure?.proxy?.enabled &&
      byId.has("traefik")
    ) {
      enqueue("traefik", `proxy exposure of "${id}"`);
    }

    for (const consumes of svc.manifest.consumes ?? []) {
      const producer = resolveProducer(consumes, producerIndex);
      if (producer) {
        if (producer.producerId !== id) {
          enqueue(producer.producerId, `data dependency "${consumes.type}" of "${id}"`);
        }
      } else if (consumes.required !== false) {
        warnings.push(
          `Service "${id}" consumes required data type "${consumes.type}" but no unique producer is installed`,
        );
      }
    }
  }

  const enabledIdsOrdered = services
    .map((svc) => svc.manifest.id)
    .filter((id) => enabledIds.has(id));

  return {
    requestedIds: requested,
    enabledIds,
    enabledIdsOrdered,
    missingIds,
    warnings,
  };
}
