/**
 * Registry of server-side resolvers that map a `scheme:value` place id
 * back to a Place. Each scheme (OSM, EVA, a data-source provider id, a
 * transit provider id, …) owns its resolver and registers it at boot;
 * the `/api/places/:id` route looks up the resolver by scheme instead of
 * hardcoding dispatch branches.
 */

import type { Place } from "../types/place";

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

export type PlaceResolver = (value: string, ctx: PlaceResolverContext) => Promise<Place | null>;

const registry = new Map<string, PlaceResolver>();

/**
 * Register (or replace) the resolver for a scheme. Idempotent so
 * integrations can re-register on hot reload.
 */
export function registerPlaceResolver(scheme: string, fn: PlaceResolver): void {
  registry.set(scheme, fn);
}

/** Look up the resolver for a scheme, or `undefined` if none registered. */
export function getPlaceResolver(scheme: string): PlaceResolver | undefined {
  return registry.get(scheme);
}

/** Return the set of registered scheme keys. Used by the debug endpoint. */
export function listPlaceResolverSchemes(): string[] {
  return Array.from(registry.keys());
}
