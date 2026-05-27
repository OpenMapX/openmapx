import type { BBox, PoiSource } from "./types";

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

const REGISTRY = new Map<string, PoiSource>();

/**
 * Read-only snapshot of all currently-registered sources. The result is a
 * fresh array each call — safe to mutate without affecting the underlying
 * registry. Order is registration-order.
 */
export function getAllPoiSources(): readonly PoiSource[] {
  return Array.from(REGISTRY.values());
}

export function getPoiSource(id: string): PoiSource | undefined {
  return REGISTRY.get(id);
}

export function getPoiSourcesByDomain(domain: string): readonly PoiSource[] {
  const out: PoiSource[] = [];
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
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
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
  const id = src.id;

  if (!ID_RE.test(id)) {
    errors.push(`source "${id}": id must match ${ID_RE} (table-name-safe)`);
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
  const errors = collectErrorsForSource(source);
  if (errors.length > 0) {
    throw new Error(
      `registerPoiSource: invalid declaration for "${source.id}":\n  - ${errors.join("\n  - ")}`,
    );
  }
  const existing = REGISTRY.get(source.id);
  if (existing) {
    if (existing === source) return;
    log?.warn(
      `registerPoiSource: id "${source.id}" already registered; ignoring duplicate registration`,
    );
    return;
  }
  REGISTRY.set(source.id, source);
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
    const prev = seen.get(src.id);
    if (prev !== undefined) {
      errors.push(`duplicate source id "${src.id}" at indexes ${prev} and ${i}`);
    } else {
      seen.set(src.id, i);
    }
    errors.push(...collectErrorsForSource(src));
  }

  if (errors.length > 0) {
    throw new Error(
      `validatePoiSourceRegistry found ${errors.length} problem(s):\n  - ${errors.join("\n  - ")}`,
    );
  }
}
