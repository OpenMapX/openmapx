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

let cache: {
  value: DataUsePolicy;
  at: number;
  // Memoized gated sets, derived from the policy + the integration registry.
  // Recomputed lazily on first use and shared with the same lifetime as the
  // policy, so the per-response preSerialization hook doesn't re-scan every
  // integration on each request. Cleared together by invalidateDataUsePolicy().
  gatedSources?: Set<string>;
  gatedIntegrations?: Set<string>;
} | null = null;
const CACHE_TTL_MS = 30_000;

/** Drop the cached policy (call after an admin settings write). */
export function invalidateDataUsePolicy(): void {
  cache = null;
}

export async function getDataUsePolicy(): Promise<DataUsePolicy> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

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

  const value: DataUsePolicy = {
    allowNonCommercial: envNC ?? dbNC ?? true,
    allowGreyArea: envGrey ?? dbGrey ?? true,
  };
  cache = { value, at: now };
  return value;
}

/**
 * The set of `sourceId`s excluded by the current policy: `commercialUse: "no"`
 * sources when non-commercial is disallowed, and `"unknown"` sources when
 * grey-area is disallowed. Empty when the policy permits both.
 */
export async function getGatedSourceIds(): Promise<Set<string>> {
  const policy = await getDataUsePolicy();
  if (cache?.gatedSources) return cache.gatedSources;
  const gated = new Set<string>();
  if (!(policy.allowNonCommercial && policy.allowGreyArea)) {
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
  }
  if (cache) cache.gatedSources = gated;
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
export async function getGatedIntegrationIds(): Promise<Set<string>> {
  const gatedSources = await getGatedSourceIds();
  if (cache?.gatedIntegrations) return cache.gatedIntegrations;
  const result = new Set<string>();
  if (gatedSources.size > 0) {
    for (const integration of getAllIntegrations()) {
      const sources = integration.manifest.dataSources ?? [];
      if (sources.length === 0) continue;
      if (sources.every((ds) => gatedSources.has(ds.sourceId))) {
        result.add(integration.id);
      }
    }
  }
  if (cache) cache.gatedIntegrations = result;
  return result;
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
