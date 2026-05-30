/**
 * Client-side mirror of the `flights` integration's contract. Kept in core so
 * the web/mobile UIs and the deep-link builder share one definition.
 */

export type CabinClass = "economy" | "premiumeconomy" | "business" | "first";

/** Which query fields a flight provider can encode into its deep link. */
export interface FlightProviderCapabilities {
  returnDate: boolean;
  adults: boolean;
  children: boolean;
  infants: boolean;
  cabin: boolean;
  directOnly: boolean;
}

/** Provider descriptor as returned by `GET /api/integrations/flights/providers`. */
export interface FlightProviderInfo {
  id: string;
  name: string;
  homepage: string;
  capabilities: FlightProviderCapabilities;
  isDefault: boolean;
}

/** A flight search the user has assembled in the directions panel. */
export interface FlightSearchParams {
  /** Origin airport, 3-letter IATA. */
  from: string;
  /** Destination airport, 3-letter IATA. */
  to: string;
  /** Outbound date, `YYYY-MM-DD`. */
  departDate: string;
  /** Inbound date, `YYYY-MM-DD`. Absent ⇒ one-way. */
  returnDate?: string;
  adults: number;
  children: number;
  infants: number;
  cabin: CabinClass;
  directOnly: boolean;
}
