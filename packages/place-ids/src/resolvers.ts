/**
 * Registry of server-side resolvers that map a `scheme:value` place id
 * back to a host-defined place type. Each scheme (OSM, EVA, a data-source
 * provider id, a transit provider id, …) owns its resolver and registers it
 * at boot; a dispatcher (e.g. `/api/places/:id`) looks up the resolver by
 * scheme instead of hardcoding dispatch branches.
 *
 * The resolved value type is host-defined via the `TPlace` type parameter,
 * so this package has no dependency on any specific place schema. Hosts
 * typically alias the registry once for ergonomics:
 *
 * ```ts
 * import type { PlaceResolver as RawResolver } from "@openmapx/place-ids";
 * import type { MyPlace } from "./types";
 * export type PlaceResolver = RawResolver<MyPlace>;
 * ```
 */

export interface PlaceResolverContext {
  /** Accept-Language preference — raw query value, may be undefined. */
  lang?: string;
  /** Latitude hint, provided by the client for coordinate-aware lookups. */
  lat?: number;
  /** Longitude hint. */
  lng?: number;
  /**
   * Caller already has an address for this place (e.g. a data-source detail
   * supplied one). Resolvers may use this to skip reverse-geocoding fallbacks
   * that would only duplicate what the caller will keep anyway.
   */
  hasAddress?: boolean;
}

export type PlaceResolver<TPlace = unknown> = (
  value: string,
  ctx: PlaceResolverContext,
) => Promise<TPlace | null>;

const registry = new Map<string, PlaceResolver<unknown>>();
let stagedRegistry: Map<string, PlaceResolver<unknown>> | null = null;

/**
 * Register (or replace) the resolver for a scheme. Idempotent so
 * integrations can re-register on hot reload.
 */
export function registerPlaceResolver<TPlace = unknown>(
  scheme: string,
  fn: PlaceResolver<TPlace>,
): void {
  (stagedRegistry ?? registry).set(scheme, fn as PlaceResolver<unknown>);
}

/** Begin a detached resolver generation for an atomic integration reload. */
export function beginPlaceResolverStaging(): void {
  if (stagedRegistry) throw new Error("Place resolver staging is already active");
  stagedRegistry = new Map();
}

/** Replace the active resolver generation after every integration staged successfully. */
export function commitPlaceResolverStaging(): void {
  if (!stagedRegistry) throw new Error("Place resolver staging is not active");
  registry.clear();
  for (const [scheme, resolver] of stagedRegistry) registry.set(scheme, resolver);
  stagedRegistry = null;
}

/** Discard resolver registrations from a failed integration generation. */
export function rollbackPlaceResolverStaging(): void {
  stagedRegistry = null;
}

/** Look up the resolver for a scheme, or `undefined` if none registered. */
export function getPlaceResolver<TPlace = unknown>(
  scheme: string,
): PlaceResolver<TPlace> | undefined {
  return registry.get(scheme) as PlaceResolver<TPlace> | undefined;
}

/** Return the set of registered scheme keys. Used by the debug endpoint. */
export function listPlaceResolverSchemes(): string[] {
  return Array.from(registry.keys());
}
