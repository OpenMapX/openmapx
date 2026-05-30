/**
 * Shared types for the flight-search integration.
 *
 * This integration does NOT fetch live flight data — no free, fresh,
 * commercially-licensable open flight schedule/price feed exists (see
 * docs/plans/flights-in-directions.md). Instead each provider is a pure
 * deep-link builder: it turns a normalised {@link FlightSearchQuery} into a
 * URL that opens a pre-filled search on an external flight engine. Adding a
 * new engine (e.g. another metasearch site) is a single file in `providers/`
 * plus one line in `providers/index.ts`.
 */

export type CabinClass = "economy" | "premiumeconomy" | "business" | "first";

/** Normalised, validated flight-search request. Built by `query.ts`. */
export interface FlightSearchQuery {
  /** Origin airport, 3-letter IATA, uppercase. */
  from: string;
  /** Destination airport, 3-letter IATA, uppercase. */
  to: string;
  /** Outbound date, `YYYY-MM-DD`. */
  departDate: string;
  /** Inbound date, `YYYY-MM-DD`. Absent ⇒ one-way. */
  returnDate?: string;
  adults: number;
  children: number;
  infants: number;
  cabin: CabinClass;
  /** Prefer non-stop / direct flights only. */
  directOnly: boolean;
}

/**
 * Which fields of a {@link FlightSearchQuery} a provider can actually encode
 * into its URL. The UI dims inputs a provider can't honour so the user knows
 * what will and won't be carried across.
 */
export interface FlightProviderCapabilities {
  returnDate: boolean;
  adults: boolean;
  children: boolean;
  infants: boolean;
  cabin: boolean;
  directOnly: boolean;
}

/** Host-supplied configuration passed to every provider's `build()`. */
export interface FlightProviderConfig {
  /** Skyscanner Impact affiliate id; enables the referral URL schema. */
  skyscannerMediaPartnerId?: string;
}

/** A deep-link builder for one external flight-search engine. */
export interface FlightProvider {
  /** Stable id used in URLs and config, e.g. `skyscanner`. */
  id: string;
  /** Display name shown in the UI, e.g. `Skyscanner`. */
  name: string;
  /** Provider landing page (shown as the link-out hint). */
  homepage: string;
  capabilities: FlightProviderCapabilities;
  /** Build the pre-filled external search URL for `query`. */
  build(query: FlightSearchQuery, config: FlightProviderConfig): string;
}

/** Serialisable provider descriptor returned by `GET /providers`. */
export interface FlightProviderInfo {
  id: string;
  name: string;
  homepage: string;
  capabilities: FlightProviderCapabilities;
  isDefault: boolean;
}
