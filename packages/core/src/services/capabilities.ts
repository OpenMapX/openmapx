// Well-known capabilities and data types used in service manifests.
//
// `provides:` (and integration `requires.capability:`) holds **service
// capabilities** — what kind of role a service plays in the stack
// (routing-engine, geocoder, database, …). `produces.type:` and
// `consumes.type:` hold **data types** — what kind of dataset flows between
// services (osm-pbf, gtfs, tile-fonts, …). The two are different namespaces
// and we register them separately.
//
// Community plugins are allowed to introduce new strings, but they must
// namespace them as `<vendor>/<name>` (e.g. `acme/routing-engine`,
// `acme/satellite-imagery`) to avoid colliding with future well-known
// values. The validator reports a warning — not an error — when it sees a
// non-conforming string, so existing manifests keep loading while operators
// see a flag in the admin UI / CLI.

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
  // Source-data delivery — data-manager exposes these as service-role
  // capabilities ("I'm the kind of service that delivers OSM/GTFS/tile
  // assets"). The corresponding produces TYPES (the actual on-disk format)
  // live in WELL_KNOWN_DATA_TYPES below: `osm-data` covers `osm-pbf` /
  // `osm-pbf-bz2`; `gtfs-data` covers `gtfs`; `tile-asset-data` covers
  // `tile-fonts`.
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

/**
 * Classify a capability or data-type string. Used by the manifest validator to
 * emit warnings (not errors) for non-conforming values.
 */
export function checkCapabilityName(value: string, kind: CapabilityKind): CapabilityCheck {
  const set = kind === "capability" ? WELL_KNOWN_CAPABILITIES : WELL_KNOWN_DATA_TYPES;
  const wellKnown = set.has(value);
  const namespaced = NAMESPACED_NAME_REGEX.test(value);
  return { ok: wellKnown || namespaced, wellKnown, namespaced };
}

export interface CapabilityWarning {
  /** Where in the manifest this came from (e.g. `provides[0]`, `produces[1].type`). */
  path: string;
  /** The unrecognised string. */
  value: string;
  kind: CapabilityKind;
  /** Human-readable summary suitable for logging / surface in the admin UI. */
  message: string;
}

/**
 * Walk a service manifest and return one warning per non-conforming
 * capability or data-type string. Returns an empty array when everything is
 * either well-known or properly namespaced.
 *
 * The shape parameter is intentionally loose so this can be called with the
 * raw parsed JSON before full Zod validation has run. `provides:` accepts
 * either form (bare string or `{ capability, metadata? }`).
 */
export function collectCapabilityWarnings(manifest: {
  id?: string;
  provides?: Array<string | { capability?: string }>;
  produces?: Array<{ type?: string }>;
  consumes?: Array<{ type?: string }>;
}): CapabilityWarning[] {
  const warnings: CapabilityWarning[] = [];

  for (let i = 0; i < (manifest.provides ?? []).length; i++) {
    const entry = manifest.provides?.[i];
    const value = typeof entry === "string" ? entry : entry?.capability;
    if (typeof value !== "string") continue;
    const check = checkCapabilityName(value, "capability");
    if (!check.ok) {
      warnings.push({
        path: `provides[${i}]`,
        value,
        kind: "capability",
        message: `"${value}" is not a well-known capability and not namespaced; community capabilities should use "<vendor>/<name>" (e.g. "acme/${value}")`,
      });
    }
  }

  for (let i = 0; i < (manifest.produces ?? []).length; i++) {
    const value = manifest.produces?.[i]?.type;
    if (typeof value !== "string") continue;
    const check = checkCapabilityName(value, "data-type");
    if (!check.ok) {
      warnings.push({
        path: `produces[${i}].type`,
        value,
        kind: "data-type",
        message: `"${value}" is not a well-known data type and not namespaced; community data types should use "<vendor>/<name>"`,
      });
    }
  }

  for (let i = 0; i < (manifest.consumes ?? []).length; i++) {
    const value = manifest.consumes?.[i]?.type;
    if (typeof value !== "string") continue;
    const check = checkCapabilityName(value, "data-type");
    if (!check.ok) {
      warnings.push({
        path: `consumes[${i}].type`,
        value,
        kind: "data-type",
        message: `"${value}" is not a well-known data type and not namespaced; community data types should use "<vendor>/<name>"`,
      });
    }
  }

  return warnings;
}
