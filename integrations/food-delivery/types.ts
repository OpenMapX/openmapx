/**
 * Shared types for the food-delivery integration.
 *
 * Like the `flights` integration, this fetches NO live data from the delivery
 * platforms — no public consumer API resolves "this restaurant → its order
 * page", and the platform APIs are merchant/POS-side. Each provider is therefore a
 * pure deep-link builder that turns a normalised {@link DeliveryQuery} into a
 * URL that opens the platform pre-filled with the restaurant name AND a delivery
 * location (so results are scoped to the right city, not the platform default).
 * Adding a platform is one entry in `providers.ts`.
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
  /** Build the pre-filled external search URL for `query` (synchronous, always available). */
  build(query: DeliveryQuery, config: DeliveryProviderConfig): string;
  /**
   * Optional async resolver to a precise restaurant URL (e.g. an Uber Eats
   * `/store/<slug>/<uuid>` page) by querying the platform server-side. Returns
   * null when it can't resolve; the host then falls back to {@link build}. Runs
   * on the API host (it sets a Cookie + calls the platform cross-origin).
   */
  resolve?(query: DeliveryQuery, config: DeliveryProviderConfig): Promise<string | null>;
}

// The serialisable `/providers` response shape (DeliveryProviderInfo) is the
// shared wire contract — imported from `@openmapx/core/server` so the client
// and this integration agree on one definition.
