// integrations/hotels/types.ts

/**
 * Shared types for the hotels integration.
 *
 * Like flights/food-delivery, Tier 1 fetches NO live data — each provider is a
 * pure deep-link builder that turns a normalised HotelQuery into an OTA search
 * URL pre-filled with the hotel name, dates, and occupancy. Tier 2 (LiteAPI)
 * adds a single live "lowest rate" for display only. See
 * docs/plans/hotel-prices-and-booking.md.
 */

/** Normalised, validated hotel hand-off request. Built by query.ts. */
export interface HotelQuery {
  /** Hotel name (the OTA search term). */
  name: string;
  city?: string;
  /** ISO-3166-1 alpha-2 country code, lowercase. */
  countryCode?: string;
  lat?: number;
  lng?: number;
  address?: string;
  /** Check-in `YYYY-MM-DD`. */
  checkIn?: string;
  /** Check-out `YYYY-MM-DD`. */
  checkOut?: string;
  /** Total adult guests (1–16). */
  adults?: number;
  /** Number of rooms (1–8). */
  rooms?: number;
  /** OSM `wikidata=Q…` tag for the hotel, used to resolve exact OTA ids. */
  wikidata?: string;
}

/** Host-supplied configuration passed to every provider's build(). */
export interface HotelProviderConfig {
  /** Per-provider affiliate `{url}`-wrapper templates (see manifest). */
  affiliateTemplates?: Record<string, string>;
  /** Booking.com affiliate id, appended as `&aid=` when set. */
  bookingAid?: string;
}

/**
 * A deep-link builder for one external hotel OTA. `regions` is `"*"` (global)
 * or a list of ISO alpha-2 country codes (lowercase) the OTA primarily serves;
 * the `/providers` route filters by the place's country.
 */
export interface HotelProvider {
  id: string;
  name: string;
  homepage: string;
  color: string;
  regions: readonly string[] | "*";
  /** Build the pre-filled OTA search URL for `query`. */
  build(query: HotelQuery, config: HotelProviderConfig): string;
  /** True for OTAs that only deep-link by their internal hotel id: the compare
   *  list shows them only when an exact id resolves (no city/search fallback). */
  exactOnly?: boolean;
}

// The serialisable `/providers` response shape (HotelProviderInfo) is imported
// from @openmapx/core/server in index.ts so client + integration agree.
