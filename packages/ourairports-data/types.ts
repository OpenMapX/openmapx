import type { AirportInfo } from "@openmapx/core";

/**
 * In-memory representation of one OurAirports airport. Extends the public
 * `AirportInfo` shape (used by the knowledge integration to enrich a Place)
 * with the fields required by overlay rendering and search indexing.
 */
export interface AirportRecord extends AirportInfo {
  /** WGS84 latitude in degrees. */
  lat: number;
  /** WGS84 longitude in degrees. */
  lng: number;
  /** Official airport name (e.g. "Frankfurt am Main Airport"). */
  name: string;
  /** "AF" | "AN" | "AS" | "EU" | "NA" | "OC" | "SA" — OurAirports continent code. */
  continent?: string;
  /** Comma-separated alternate names / codes / search terms from the CSV. */
  keywords?: string;
}
