// Well-known capabilities and data types used in service manifests.
//
// `provides:` (and integration `requires.capability:`) holds **service
// capabilities** — what kind of role a service plays in the stack
// (routing-engine, geocoder, database, …). `produces.type:` and
// `consumes.type:` hold **data types** — what kind of dataset flows between
// services (osm-pbf, gtfs, tile-fonts, …). The two are different namespaces
// and we register them separately.
//
// Community manifests may introduce new strings, but they must namespace them
// as `<vendor>/<name>` (e.g. `acme/routing-engine`, `acme/satellite-imagery`)
// so they never collide with a future well-known value. A community manifest
// that uses any other string fails validation.

/** Capabilities a service may offer in `provides:` / an integration may match in `requires.capability:`. */
export const WELL_KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
  // Routing
  "routing-engine",
  // Transit
  "transit-engine",
  "transit-engine-staging",
  // Geocoding
  "geocoder",
  // Tiles
  "tile-server",
  // OSM queries
  "osm-query",
  // Infrastructure
  "database",
  "cache",
  "proxy",
  // Location history
  "timeline",
  // Local model inference
  "llm-inference",
  // Source-data delivery — service-role capabilities a service may declare
  // ("I'm the kind of service that delivers OSM/GTFS/tile assets"). No
  // built-in service declares or requires them today; the built-in
  // data-manager delivers data through `produces:`. The corresponding
  // produces TYPES (the actual on-disk format) live in WELL_KNOWN_DATA_TYPES
  // below: `osm-data` covers `osm-pbf` / `osm-pbf-bz2`; `gtfs-data` covers
  // `gtfs`; `tile-asset-data` covers `tile-fonts`.
  "osm-data",
  "gtfs-data",
  "tile-asset-data",
]);

/** Data types a service may produce/consume in `produces.type:` / `consumes.type:`. */
export const WELL_KNOWN_DATA_TYPES: ReadonlySet<string> = new Set([
  "osm-pbf",
  "osm-pbf-bz2",
  "osrm-graph",
  "otp-graph",
  "motis-data",
  "motis-staging-data",
  "motis-feed-proxy-config",
  "gtfs",
  "tile-mbtiles",
  "tile-fonts",
  "pelias-placeholder-data",
  "pelias-whosonfirst-data",
]);

/**
 * Vendor-namespaced shape (e.g. `acme/routing-engine`). Two slug-like segments
 * separated by exactly one slash. Same syntax for capabilities and data types.
 */
export const NAMESPACED_NAME_REGEX = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

export type CapabilityKind = "capability" | "data-type";

export interface CapabilityCheck {
  /** Whether the value is acceptable (well-known OR namespaced). */
  ok: boolean;
  /** Whether the value matched a well-known entry exactly. */
  wellKnown: boolean;
  /** Whether the value matched the `<vendor>/<name>` shape. */
  namespaced: boolean;
}

/** Classify a capability or data-type string. */
export function checkCapabilityName(value: string, kind: CapabilityKind): CapabilityCheck {
  const set = kind === "capability" ? WELL_KNOWN_CAPABILITIES : WELL_KNOWN_DATA_TYPES;
  const wellKnown = set.has(value);
  const namespaced = NAMESPACED_NAME_REGEX.test(value);
  return { ok: wellKnown || namespaced, wellKnown, namespaced };
}

/**
 * One error per capability or data-type string in a community service
 * manifest that is neither well-known nor namespaced as `<vendor>/<name>`.
 * `provides:` accepts either form (bare string or `{ capability, metadata? }`).
 */
export function capabilityNameErrors(manifest: {
  provides?: Array<string | { capability?: string }>;
  produces?: Array<{ type?: string }>;
  consumes?: Array<{ type?: string }>;
}): string[] {
  const errors: string[] = [];
  const check = (path: string, value: string | undefined, kind: CapabilityKind) => {
    if (typeof value !== "string" || checkCapabilityName(value, kind).ok) return;
    const label = kind === "capability" ? "capability" : "data type";
    errors.push(
      `${path}: "${value}" is neither a well-known ${label} nor namespaced as "<vendor>/<name>" (e.g. "acme/${value}")`,
    );
  };
  for (const [i, entry] of (manifest.provides ?? []).entries())
    check(`provides[${i}]`, typeof entry === "string" ? entry : entry?.capability, "capability");
  for (const [i, entry] of (manifest.produces ?? []).entries())
    check(`produces[${i}].type`, entry?.type, "data-type");
  for (const [i, entry] of (manifest.consumes ?? []).entries())
    check(`consumes[${i}].type`, entry?.type, "data-type");
  return errors;
}
