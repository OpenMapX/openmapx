import type { DataSourceDetail } from "@integrations/data-source/types";
import type { LngLat } from "./geometry";
import type { Identified, Ids } from "./identified";
import type { OpeningHoursInfo } from "./openingHoursInfo";

export interface PlacePhoto {
  url: string;
  thumbnailUrl?: string;
  attribution: string;
  source: string;
  author?: string;
  authorUrl?: string;
  license?: string;
  licenseUrl?: string;
  pageUrl?: string;
  capturedAt?: string;
  /** Photo-specific coordinates [lng, lat] — used for minimap in gallery. */
  coordinates?: LngLat;
}

export interface PlaceFact {
  label: string;
  value: string;
}

export type AirportType =
  | "large_airport"
  | "medium_airport"
  | "small_airport"
  | "heliport"
  | "seaplane_base"
  | "balloonport"
  | "closed_airport";

export interface AirportRunwayInfo {
  /** Designator e.g. "10/28" or "10L/28R" (concatenated low/high ends). */
  ident: string;
  lengthFt?: number;
  widthFt?: number;
  /** Raw surface code from OurAirports (e.g. ASP, CON, TURF, GRS, WATER). */
  surface?: string;
  closed: boolean;
  lighted: boolean;
  /** Primary (low end) heading in degrees true. */
  headingDegT?: number;
}

export interface AirportFrequencyInfo {
  /** Service type: TWR, GND, CTAF, ATIS, UNICOM, etc. */
  type: string;
  description?: string;
  frequencyMhz: number;
}

export interface AirportNavaidInfo {
  ident: string;
  name?: string;
  /** VOR, VOR-DME, DME, NDB, NDB-DME, TACAN, VORTAC, etc. */
  type: string;
  frequencyKhz?: number;
}

export interface AirportInfo {
  /** OurAirports primary key. */
  id: number;
  /** OurAirports stable identifier (usually ICAO when present, else a synthesized code). */
  ident: string;
  type: AirportType;
  iata?: string;
  icao?: string;
  gpsCode?: string;
  localCode?: string;
  elevationFt?: number;
  scheduledService: boolean;
  municipality?: string;
  isoCountry?: string;
  isoRegion?: string;
  homeLink?: string;
  wikipediaLink?: string;
  runways?: AirportRunwayInfo[];
  frequencies?: AirportFrequencyInfo[];
  navaids?: AirportNavaidInfo[];
}

export interface PlaceReviewLink {
  platform: string;
  url: string;
  kind?: "direct" | "search";
  source?: "osm" | "wikidata" | "fallback";
  confidence?: "high" | "low";
}

/**
 * Map of all known external identifiers for a place — keyed by scheme
 * (`osm`, `wikidata`, `yelp`, `eva`, a provider id, …), valued by the
 * opaque id string in that scheme's format. The `primaryScheme` field on
 * `Place` tells downstream code which of these is canonical.
 *
 * Open-ended by design: integrations register their own schemes via the
 * id-scheme registry rather than enumerating them in a central type.
 */
export type PlaceIds = Ids;

export interface Place extends Identified {
  name: string;
  address: string;
  city?: string;
  /** ISO 3166-1 alpha-2 country code (e.g. "de", "us"). */
  countryCode?: string;
  coordinates: LngLat;
  category?: string;
  /** Raw category string from the geocoding provider (e.g. "railway/station", "highway/bus_stop"). */
  rawCategory?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  rating?: number;
  reviewCount?: number;
  osmTags?: Record<string, string>;
  photos?: PlacePhoto[];
  /** Short tagline (from Wikidata entity description). */
  description?: string;
  /** Longer article summary (from Wikipedia extract). */
  wikipediaExtract?: string;
  /** Integration ID(s) that supplied the Wikipedia extract (e.g. "knowledge-wikipedia" or "knowledge-wikidata"). */
  wikipediaExtractSource?: string | string[];
  wikipediaUrl?: string;
  facts?: PlaceFact[];
  reviewLinks?: PlaceReviewLink[];
  isOpen?: boolean;
  /** Server-precomputed opening-hours status + weekly bitmap. */
  openingHoursInfo?: OpeningHoursInfo;
  dataSourceDetail?: DataSourceDetail;
  /** OurAirports-derived structured airport detail (matched by IATA/ICAO from osmTags). */
  airport?: AirportInfo;
}
