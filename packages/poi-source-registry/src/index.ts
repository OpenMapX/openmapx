import { feedIdPartsSchema, feedIdSchema } from "@openmapx/core";
import { resolvePoiSourceId } from "./derive";
import type { BBox, PoiSource, RegisteredPoiSource } from "./types";

export { resolvePoiSourceId } from "./derive";
export * from "./types";

/**
 * Canonical Redis key for the cross-process live-state hash that
 * `services/data-manager`'s `write-live` stage populates and the
 * `@openmapx/integration-framework` POI reader reads.
 *
 * Format: `poi:live:<sourceId>` — deliberately NOT integration-prefixed
 * since data-manager has no concept of integration ids, only the source
 * ids registered here. Both halves of the round-trip MUST use this helper
 * (or an equivalent literal) to avoid silent key-namespace drift.
 */
export function poiLiveHashKey(sourceId: string): string {
  return `poi:live:${sourceId}`;
}

const REGISTRY = new Map<string, RegisteredPoiSource>();
/**
 * Tracks the raw (pre-normalization) object passed to `registerPoiSource`,
 * keyed by derived id. Used only for the same-object-reregistered identity
 * check below — `REGISTRY` itself holds the normalized copy so downstream
 * consumers always see a defined `id`/`stationIdPrefix`.
 */
const RAW_SOURCES = new Map<string, PoiSource>();

/**
 * Read-only snapshot of all currently-registered sources. The result is a
 * fresh array each call — safe to mutate without affecting the underlying
 * registry. Order is registration-order.
 */
export function getAllPoiSources(): readonly RegisteredPoiSource[] {
  return Array.from(REGISTRY.values());
}

export function getPoiSource(id: string): RegisteredPoiSource | undefined {
  return REGISTRY.get(id);
}

export function getPoiSourcesByDomain(domain: string): readonly RegisteredPoiSource[] {
  const out: RegisteredPoiSource[] = [];
  for (const src of REGISTRY.values()) {
    if (src.domain === domain) out.push(src);
  }
  return out;
}

/**
 * Test-only: empty the registry. Production callers never invoke this; tests
 * use it in `beforeEach` to isolate per-test state.
 */
export function __clearPoiSourceRegistry(): void {
  REGISTRY.clear();
  RAW_SOURCES.clear();
}

const CRON_RE = /^[\d*/,-]+(\s+[\d*/,-]+){4}$/;

function checkBBox(id: string, bbox: BBox): string[] {
  const errors: string[] = [];
  const [west, south, east, north] = bbox;
  if (!(west < east))
    errors.push(`source "${id}": coverage west (${west}) must be < east (${east})`);
  if (!(south < north))
    errors.push(`source "${id}": coverage south (${south}) must be < north (${north})`);
  if (west < -180 || west > 180)
    errors.push(`source "${id}": coverage west (${west}) out of range [-180,180]`);
  if (east < -180 || east > 180)
    errors.push(`source "${id}": coverage east (${east}) out of range [-180,180]`);
  if (south < -90 || south > 90)
    errors.push(`source "${id}": coverage south (${south}) out of range [-90,90]`);
  if (north < -90 || north > 90)
    errors.push(`source "${id}": coverage north (${north}) out of range [-90,90]`);
  return errors;
}

function collectErrorsForSource(src: PoiSource): string[] {
  const errors: string[] = [];
  const id = resolvePoiSourceId(src).id;

  if (!feedIdSchema.safeParse(id).success) {
    errors.push(
      `source "${id}": id must be a valid feed id (lowercase, hyphen-separated, table-name-safe)`,
    );
  }

  if (src.parts && !feedIdPartsSchema.safeParse(src.parts).success) {
    errors.push(
      `source "${id}": parts tokens must be lowercase alphanumeric (country /^[a-z]{2}$/, others /^[a-z0-9]+$/)`,
    );
  }

  const hasStatic = (src as { static?: unknown }).static !== undefined;
  const hasBundled = (src as { bundled?: unknown }).bundled !== undefined;
  const hasLive = (src as { live?: unknown }).live !== undefined;

  if (hasStatic && hasBundled) {
    errors.push(`source "${id}": cannot set both "static" and "bundled"`);
  } else if (!hasStatic && !hasBundled) {
    errors.push(`source "${id}": must set exactly one of "static" or "bundled"`);
  }

  if (hasLive && !hasStatic) {
    errors.push(`source "${id}": "live" requires "static" (not allowed with "bundled")`);
  }

  if (hasStatic) {
    const cron = (src as { static: { cron: string } }).static.cron;
    if (!CRON_RE.test(cron)) {
      errors.push(`source "${id}": static.cron "${cron}" is not a valid 5-field cron expression`);
    }
  }
  if (hasLive) {
    const cron = (src as { live: { cron: string } }).live.cron;
    if (!CRON_RE.test(cron)) {
      errors.push(`source "${id}": live.cron "${cron}" is not a valid 5-field cron expression`);
    }
  }
  if (hasBundled) {
    const cron = (src as { bundled: { cron: string } }).bundled.cron;
    if (!CRON_RE.test(cron)) {
      errors.push(`source "${id}": bundled.cron "${cron}" is not a valid 5-field cron expression`);
    }
  }

  if (src.coverage) {
    errors.push(...checkBBox(id, src.coverage));
  }

  return errors;
}

export interface PoiRegistryLogger {
  warn(message: string, ...args: unknown[]): void;
}

/**
 * Register one source. Throws synchronously on invalid declarations — a bad
 * integration fails loudly on load rather than silently shipping a broken
 * source. Re-registering the SAME object by the same id is a no-op (silent);
 * re-registering a DIFFERENT object with the same id is also silent — first
 * registration wins, the duplicate is dropped with a warning. This is
 * intentional: integration code that runs multiple times (e.g. hot reload)
 * shouldn't crash, and a third-party integration colliding on id should fail
 * detectably but not crash the host.
 */
export function registerPoiSource(source: PoiSource, log?: PoiRegistryLogger): void {
  const { id, stationIdPrefix } = resolvePoiSourceId(source);
  const normalized = { ...source, id, stationIdPrefix } as RegisteredPoiSource;

  const errors = collectErrorsForSource(normalized);
  if (errors.length > 0) {
    throw new Error(
      `registerPoiSource: invalid declaration for "${id}":\n  - ${errors.join("\n  - ")}`,
    );
  }
  const existingRaw = RAW_SOURCES.get(id);
  if (existingRaw) {
    if (existingRaw === source) return;
    log?.warn(`registerPoiSource: id "${id}" already registered; ignoring duplicate registration`);
    return;
  }
  RAW_SOURCES.set(id, source);
  REGISTRY.set(id, normalized);
}

/** Bulk variant. Each source validated independently; first error halts. */
export function registerPoiSources(sources: readonly PoiSource[], log?: PoiRegistryLogger): void {
  for (const src of sources) registerPoiSource(src, log);
}

/**
 * Validator that runs across an explicit list (or the current registry
 * snapshot). Useful for tests + the data-manager's boot-time sanity check
 * after the discovery scanner runs.
 */
export function validatePoiSourceRegistry(
  sources: readonly PoiSource[] = getAllPoiSources(),
): void {
  const errors: string[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i] as PoiSource;
    const id = resolvePoiSourceId(src).id;
    const prev = seen.get(id);
    if (prev !== undefined) {
      errors.push(`duplicate source id "${id}" at indexes ${prev} and ${i}`);
    } else {
      seen.set(id, i);
    }
    errors.push(...collectErrorsForSource(src));
  }

  if (errors.length > 0) {
    throw new Error(
      `validatePoiSourceRegistry found ${errors.length} problem(s):\n  - ${errors.join("\n  - ")}`,
    );
  }
}
