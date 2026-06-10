import { db } from "../db";
import { systemSettings } from "../db/schema";
import { getAllIntegrations } from "../integration-host";

/**
 * Operator policy for licence-restricted data sources. Both non-commercial
 * (`commercialUse: "no"`) and grey-area (`commercialUse: "unknown"`) sources are
 * *allowed* by default — the project's default deployment is non-commercial, and
 * most grey-area sources are public APIs whose terms are merely undocumented. An
 * operator running a commercial deployment can tighten either control to exclude
 * the corresponding sources. Resolved env-first (OPENMAPX_ALLOW_NONCOMMERCIAL /
 * OPENMAPX_ALLOW_GREY_AREA), then the `system_settings` row set in the admin
 * panel, then the default.
 */
export interface DataUsePolicy {
  /** Allow sources whose licence forbids commercial use (`commercialUse: "no"`). */
  allowNonCommercial: boolean;
  /** Allow sources with unclear/undocumented terms (`commercialUse: "unknown"`). */
  allowGreyArea: boolean;
}

const ENV_NON_COMMERCIAL = "OPENMAPX_ALLOW_NONCOMMERCIAL";
const ENV_GREY_AREA = "OPENMAPX_ALLOW_GREY_AREA";

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return v === "true" || v === "1";
}

interface PolicyCache {
  value: DataUsePolicy;
  at: number;
  // Gated sets derived from the policy + the integration registry, recomputed
  // together on every refresh so the synchronous getters (used by the hot
  // per-response preSerialization hook) always have an answer without awaiting.
  gatedSources: Set<string>;
  gatedIntegrations: Set<string>;
}

let cache: PolicyCache | null = null;
let inFlight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const CACHE_TTL_MS = 30_000;
const EMPTY: Set<string> = new Set();

async function loadPolicy(): Promise<DataUsePolicy> {
  const envNC = envBool(ENV_NON_COMMERCIAL);
  const envGrey = envBool(ENV_GREY_AREA);

  let dbNC: boolean | undefined;
  let dbGrey: boolean | undefined;
  // Only hit the DB for the keys not already pinned by an env var.
  if (envNC === undefined || envGrey === undefined) {
    try {
      const rows = await db.select().from(systemSettings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      if (typeof map.allowNonCommercial === "boolean") dbNC = map.allowNonCommercial;
      if (typeof map.allowGreyArea === "boolean") dbGrey = map.allowGreyArea;
    } catch {
      // DB unavailable — fall back to defaults.
    }
  }

  return {
    allowNonCommercial: envNC ?? dbNC ?? true,
    allowGreyArea: envGrey ?? dbGrey ?? true,
  };
}

/**
 * The set of `sourceId`s excluded by the current policy: `commercialUse: "no"`
 * sources when non-commercial is disallowed, and `"unknown"` sources when
 * grey-area is disallowed. Empty when the policy permits both.
 */
function computeGatedSources(policy: DataUsePolicy): Set<string> {
  const gated = new Set<string>();
  if (policy.allowNonCommercial && policy.allowGreyArea) return gated;
  for (const integration of getAllIntegrations()) {
    for (const ds of integration.manifest.dataSources ?? []) {
      const cu = ds.commercialUse;
      if (
        (cu === "no" && !policy.allowNonCommercial) ||
        (cu === "unknown" && !policy.allowGreyArea)
      ) {
        gated.add(ds.sourceId);
      }
    }
  }
  return gated;
}

/**
 * Integration ids whose data sources are *entirely* gated by the current policy.
 * Used by orchestrators that key on the integration/provider rather than a
 * per-item `source` field — transit (`provider.id` ≠ `sourceId`), knowledge
 * (results merge into one untagged object), and the AQI route — where the
 * per-item response filter can't reach the data. An integration with at least
 * one still-allowed source is kept; its permitted data flows and any gated
 * per-item rows are handled by `filterGatedSources` downstream.
 */
function computeGatedIntegrations(gatedSources: Set<string>): Set<string> {
  const result = new Set<string>();
  if (gatedSources.size === 0) return result;
  for (const integration of getAllIntegrations()) {
    const sources = integration.manifest.dataSources ?? [];
    if (sources.length === 0) continue;
    if (sources.every((ds) => gatedSources.has(ds.sourceId))) result.add(integration.id);
  }
  return result;
}

/**
 * Reload the policy from env + DB and recompute the gated sets into the cache.
 * Side-effect-only so the lazy async path and the background timer can share it.
 * `loadPolicy` swallows DB errors (falling back to defaults), so this resolves
 * even when the DB is down.
 */
export async function refreshDataUsePolicy(): Promise<void> {
  const value = await loadPolicy();
  const gatedSources = computeGatedSources(value);
  const gatedIntegrations = computeGatedIntegrations(gatedSources);
  cache = { value, at: Date.now(), gatedSources, gatedIntegrations };
}

async function ensureFresh(): Promise<PolicyCache> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  inFlight ??= refreshDataUsePolicy().finally(() => {
    inFlight = null;
  });
  await inFlight;
  return cache as PolicyCache;
}

/**
 * Warm the cache once (call before the server starts listening) and start a
 * background refresh on the same TTL; the interval is `unref`'d so it never
 * keeps the process alive on its own. The eagerly-warm cache is what lets the
 * preSerialization hook read the gated set *synchronously* — and a synchronous
 * hook cannot open the resolve-undefined-races-a-second-send window that an
 * async one does (see [[project-fastify-return-reply-contract]]).
 */
export async function startDataUsePolicyRefresh(): Promise<void> {
  await refreshDataUsePolicy();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshDataUsePolicy().catch(() => {
      // Keep serving the last-good gated sets; the next tick retries.
    });
  }, CACHE_TTL_MS);
  refreshTimer.unref?.();
}

/**
 * Mark the cached policy stale so the next async read reloads it. The
 * last-computed gated sets are deliberately KEPT for the synchronous getters
 * until a refresh replaces them, so a policy change never opens an
 * "allow everything" window in the response filter mid-transition. Call after an
 * admin settings write or an integration reload.
 */
export function invalidateDataUsePolicy(): void {
  if (cache) cache.at = 0;
}

export async function getDataUsePolicy(): Promise<DataUsePolicy> {
  return (await ensureFresh()).value;
}

export async function getGatedSourceIds(): Promise<Set<string>> {
  return (await ensureFresh()).gatedSources;
}

export async function getGatedIntegrationIds(): Promise<Set<string>> {
  return (await ensureFresh()).gatedIntegrations;
}

/**
 * Synchronous view of the gated source ids for the per-response
 * preSerialization hook. Returns the last refreshed set (empty until the first
 * refresh, which `startDataUsePolicyRefresh` runs before the server listens).
 */
export function getGatedSourceIdsSync(): Set<string> {
  return cache?.gatedSources ?? EMPTY;
}

/** Synchronous companion to {@link getGatedIntegrationIds}. */
export function getGatedIntegrationIdsSync(): Set<string> {
  return cache?.gatedIntegrations ?? EMPTY;
}

/**
 * Does a single result item come *only* from gated sources? Provenance is read
 * from the item's own `source`/`sources`, or — for GeoJSON features, which carry
 * it one level down — from `properties.source`/`properties.sources`. Without the
 * `properties` fallback a gated feature would slip past the array filter and have
 * its `properties` nulled by the recursion below instead of being dropped.
 */
function itemFullyGated(item: unknown, gated: Set<string>): boolean {
  if (!item || typeof item !== "object") return false;
  const o = item as {
    source?: unknown;
    sources?: unknown;
    properties?: { source?: unknown; sources?: unknown } | null;
  };
  const source =
    typeof o.source === "string"
      ? o.source
      : typeof o.properties?.source === "string"
        ? o.properties.source
        : undefined;
  if (source !== undefined) return gated.has(source);
  const sources = Array.isArray(o.sources)
    ? o.sources
    : Array.isArray(o.properties?.sources)
      ? o.properties.sources
      : undefined;
  if (sources && sources.length > 0) {
    return sources.every((s) => typeof s === "string" && gated.has(s));
  }
  return false;
}

/**
 * Recursively strip data sourced solely from gated sources out of an API
 * response payload:
 *   - array items whose `source` / `sources` are all gated are removed;
 *   - a structured single-source object (e.g. a weather `{ source: "open-meteo", … }`
 *     response) collapses to `null`.
 * Keys on `sourceId` (data-source metadata / attribution) are deliberately NOT
 * matched, so the integration registry and the /privacy + /terms disclosure
 * tables keep listing every source regardless of policy.
 */
export function filterGatedSources<T>(value: T, gated: Set<string>): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !itemFullyGated(item, gated))
      .map((item) => filterGatedSources(item, gated)) as unknown as T;
  }
  if (value && typeof value === "object") {
    // A standalone object sourced solely from gated sources collapses to null —
    // e.g. a single-source weather `{ source: "open-meteo", … }` response. Uses
    // the same predicate as the array filter, so an object whose provenance is a
    // fully-gated `sources` array or a GeoJSON `properties.source` is caught too.
    if (itemFullyGated(value, gated)) return null as unknown as T;
    // Rebuild into a fresh object instead of mutating in place: the
    // preSerialization payload may be a reference the handler still holds (or has
    // cached in memory), and an in-place strip would corrupt it for later reads.
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = filterGatedSources(obj[key], gated);
    }
    return out as unknown as T;
  }
  return value;
}
