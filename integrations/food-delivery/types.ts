/**
 * Shared types for the food-delivery integration.
 *
 * Most providers are pure deep-link builders because their public APIs are
 * merchant/POS-side. Uber Eats additionally has a conservative, lazy exact-page
 * resolver; it must degrade to the same location-scoped search on any ambiguity
 * or upstream failure. Adding a provider remains one registry entry.
 */

/** Normalised, validated delivery hand-off request. Built by `query.ts`. */
export interface DeliveryQuery {
  /** Restaurant name (used as the platform search term). */
  name: string;
  /** City / locality, used for region filtering and location-scoped URLs. */
  city?: string;
  /** ISO-3166-1 alpha-2 country code, lowercase. */
  countryCode?: string;
  /** Latitude of the restaurant — used to set the platform's delivery location. */
  lat?: number;
  /** Longitude of the restaurant. */
  lng?: number;
  /** Postal code, when known (improves the delivery-location blob). */
  postcode?: string;
  /** Full formatted address, used to build a precise delivery location. */
  address?: string;
}

/** Host-supplied configuration passed to every provider's `build()`. */
export interface DeliveryProviderConfig {
  /**
   * Optional per-provider affiliate-link wrapper templates. Keyed by provider
   * id; the value is a URL template containing the literal token `{url}` which
   * is replaced with the URL-encoded destination link. This is how an
   * operator plugs in an Awin / Impact / Partnerize deep-link wrapper without
   * us hard-coding any one network. Absent ⇒ plain (non-affiliate) link.
   */
  affiliateTemplates?: Record<string, string>;
  /** Uber Eats Impact click-id, appended as `&scid=` when set. */
  uberEatsScid?: string;
}

export type DeliveryFallbackKind = "search" | "browse";

export type DeliveryResolveResult = { kind: "exact"; url: string } | { kind: "not_found" };

/**
 * A deep-link builder for one external food-delivery platform.
 *
 * `regions` is either `"*"` (operates ~everywhere) or a list of ISO alpha-2
 * country codes (lowercase) the platform serves. The `/providers` route filters
 * by the place's country so we never show Lieferando in the US.
 */
export interface DeliveryProvider {
  /** Stable id used in URLs and config, e.g. `ubereats`. */
  id: string;
  /** Display name shown in the UI, e.g. `Uber Eats`. */
  name: string;
  /** Provider landing page; the host strips it to a domain for the UI hint. */
  homepage: string;
  /** Brand colour (hex) for the provider chip fallback mark. */
  color: string;
  /** Countries served, or `"*"` for global. */
  regions: readonly string[] | "*";
  /** Honest description of what `build()` opens when no exact venue is resolved. */
  fallbackKind: DeliveryFallbackKind;
  /** Build the pre-filled external search URL for `query` (synchronous, always available). */
  build(query: DeliveryQuery, config: DeliveryProviderConfig): string;
  /**
   * Optional async resolver to a precise restaurant URL (e.g. an Uber Eats
   * `/store/<slug>/<uuid>` page) by querying the platform server-side. A valid
   * miss is distinct from a thrown transport/schema failure so only real misses
   * receive negative caching. Runs on the API host.
   */
  resolve?(query: DeliveryQuery, config: DeliveryProviderConfig): Promise<DeliveryResolveResult>;
}

// The serialisable `/providers` response shape (DeliveryProviderInfo) is the
// shared wire contract — imported from `@openmapx/core/server` so the client
// and this integration agree on one definition.
