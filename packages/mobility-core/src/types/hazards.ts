import type { ContributingRecord } from "../contributors.js";
import type { Attribution } from "./attribution.js";

/** CAP's severity scale. */
export type CapSeverity = "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";

/**
 * A weather or civil-protection alert, from the OpenConditions `alert`
 * situations. Alerts without a geometry are not returned.
 */
export interface HazardAlert extends ContributingRecord {
  id: string;
  /** Alerts of one CAP message, or of one update chain, share it. */
  groupId?: string;
  type: string;
  subtype?: string;
  geometry: GeoJSON.Geometry;
  event: string;
  headline?: string;
  /** The publisher's text, verbatim: some licences forbid altering an alert's content. */
  description?: string;
  instruction?: string;
  areaDescription?: string;
  severity: CapSeverity;
  urgency: string;
  certainty: string;
  /** ISO 8601 instants. */
  sent: string;
  effective?: string;
  onset?: string;
  expires?: string;
  senderName?: string;
  web?: string;
  sources: string[];
  attributions: Attribution[];
  /** Notices the publishers require to accompany any display of the alert. */
  notices: string[];
}

export type NaturalHazardType =
  | "wildfire"
  | "flood"
  | "smoke"
  | "landslide"
  | "avalanche"
  | "earthquake"
  | "volcanic_ash"
  | "dust_storm"
  | "tropical_cyclone"
  | "volcano"
  | "drought"
  | "sea_ice";

/** A natural hazard from the OpenConditions `natural_hazard` situations. */
export interface NaturalHazard extends ContributingRecord {
  id: string;
  type: NaturalHazardType;
  subtype?: string;
  geometry: GeoJSON.Geometry;
  /** Where to draw the hazard as one mark: `[lon, lat]`. */
  point: [number, number];
  name?: string;
  headline?: string;
  /** ISO 8601 instants. */
  start?: string;
  end?: string;
  ended: boolean;
  updatedAt?: string;
  severity?: {
    label: "minor" | "moderate" | "major" | "critical" | "unknown";
    level?: number;
    /** The publisher's own word for it, e.g. a GDACS alert level. */
    declared?: string;
  };
  areaHa?: number;
  containmentPct?: number;
  discoveredAt?: string;
  perimeterAt?: string;
  ignitionCause?: "natural" | "human" | "undetermined";
  density?: "light" | "medium" | "heavy";
  detection?: { satellite?: string; start?: string; end?: string };
  magnitude?: { value: number; scale: string };
  depthM?: number;
  /** Large event in an oceanic region: not a tsunami warning. */
  tsunamiFlag?: boolean;
  feltReports?: number;
  mmi?: number;
  reviewed?: boolean;
  maxWindKmh?: number;
  populationAffected?: number;
  country?: string;
  region?: string;
  locality?: string;
  detailUrl?: string;
  sources: string[];
  attributions: Attribution[];
}

/** VIIRS (NOAA-20 and -21), MODIS (Terra and Aqua) or SLSTR (Sentinel-3A and -3B). */
export type FireInstrument = "viirs" | "modis" | "slstr";

/** One satellite fire detection. */
export interface FirePixel extends ContributingRecord {
  id: string;
  /** `[lon, lat]`. */
  point: [number, number];
  observedAt: string;
  frpMW: number;
  brightnessK?: number;
  instrument: FireInstrument;
  satellite?: string;
  confidence?: { level?: "low" | "nominal" | "high"; percent?: number };
  dayNight?: "day" | "night";
  sources: string[];
}

/** Fire detections aggregated into one grid cell. */
export interface FireDensityCell extends ContributingRecord {
  /** Exact native input IDs for policy, separate from canonical display identities. */
  nativeSources?: readonly string[];
  /** False when some counted historical inputs have no captured receipt. */
  lineageComplete?: boolean;
  /** Exact cell suppliers, independent of whole-grid diagnostic sources. */
  sources?: readonly string[];
  /** The cell's position, `[lon, lat]`. */
  point: [number, number];
  count: number;
  frpSumMW: number;
  frpMaxMW: number;
}
