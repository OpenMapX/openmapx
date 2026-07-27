/**
 * Client-side mirror of the `food-delivery` integration's contract. Kept in
 * core so the web/mobile UIs and the deep-link builder share one definition.
 */

/** Provider descriptor as returned by `GET /api/integrations/food-delivery/providers`. */
export type DeliveryAvailability = "confirmed" | "unknown" | "unavailable";
export type DeliveryLinkKind = "exact" | "search" | "browse";
export type DeliveryEvidence =
  | "provider-url"
  | "delivery-partner"
  | "delivery-no"
  | "resolver"
  | "fallback";

export interface DeliveryProviderInfo {
  id: string;
  name: string;
  /** Bare domain (e.g. `ubereats.com`) shown in the "Continue with" list. */
  domain: string;
  homepage: string;
  /** Brand colour (hex) for the provider chip mark. */
  color: string;
  /** Whether the handoff is a confirmed venue, a name search, or a broad listing. */
  linkKind: DeliveryLinkKind;
  /** Exact destination when the backend resolved one; absent for search/browse fallbacks. */
  url?: string;
}

export interface DeliveryOption extends DeliveryProviderInfo {
  availability: DeliveryAvailability;
  evidence: DeliveryEvidence;
}

/** A delivery hand-off the user triggers from a restaurant's place panel. */
export interface DeliverySearchParams {
  /** Restaurant name (the platform search term). */
  name: string;
  /** City / locality, used for region filtering and location-scoped URLs. */
  city?: string;
  /** ISO-3166-1 alpha-2 country code (lowercase). */
  countryCode?: string;
  /** Restaurant latitude — lets platforms set the delivery location. */
  lat?: number;
  /** Restaurant longitude. */
  lng?: number;
  /** Postal code, when known. */
  postcode?: string;
  /** Full formatted address, when known. */
  address?: string;
}
