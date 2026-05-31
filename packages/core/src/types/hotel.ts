/** Serialisable `/providers` row — the shared client/integration contract. */
export interface HotelProviderInfo {
  id: string;
  name: string;
  /** Bare domain (e.g. `booking.com`) shown in the compare list. */
  domain: string;
  homepage: string;
  /** Brand colour (hex) for the provider chip fallback mark. */
  color: string;
}

/** Client→backend hotel hand-off parameters. */
export interface HotelSearchParams {
  /** Hotel name (the OTA search term). */
  name: string;
  city?: string;
  /** ISO-3166-1 alpha-2 country code (lowercase). */
  countryCode?: string;
  lat?: number;
  lng?: number;
  address?: string;
  /** Check-in date, `YYYY-MM-DD`. */
  checkIn?: string;
  /** Check-out date, `YYYY-MM-DD`. */
  checkOut?: string;
  /** Adult guests (total). */
  adults?: number;
  /** Number of rooms. */
  rooms?: number;
  /** ISO-4217 currency for live (Tier 2) rates, e.g. "EUR". */
  currency?: string;
  /**
   * ISO-3166-1 alpha-2 guest nationality for live rates, e.g. "DE". Case-
   * insensitive on input — `useHotelSearchStore.setGuestNationality` upper-cases
   * it (unlike `countryCode` above, which is lowercase), so a lowercase value
   * passed here is normalised before it reaches the backend.
   */
  guestNationality?: string;
}

/** Tier 2 client config: whether live prices are on + the currency to preset. */
export interface HotelConfig {
  liveEnabled: boolean;
  defaultCurrency: string;
}

/** One live rate (Tier 2 — LiteAPI). */
export interface HotelOffer {
  /** Provider/source id, e.g. `liteapi`. */
  source: string;
  /** Lowest total price for the whole stay, in `currency`. */
  total: number;
  /** Lowest nightly price (total / nights), rounded. */
  nightlyFrom: number;
  currency: string;
  /** Operator-marked-up selling price, when LiteAPI returns one. */
  suggestedSellingPrice?: number;
  /** True when at least one matched rate is fully refundable. */
  refundable: boolean;
}

/** Tier 2 `/offers` response. */
export interface HotelOffersResponse {
  /** Best (lowest) offer found for the matched hotel, or null when none. */
  best: HotelOffer | null;
  /** Source attribution id (matches a manifest dataSource sourceId). */
  attributionId?: string;
}
