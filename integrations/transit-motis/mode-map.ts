import type { Mode } from "@motis-project/motis-client";
import type { TransportMode } from "@openmapx/mobility-core/transit";

const MOTIS_MODE_MAP: Partial<Record<Mode | "MONORAIL", TransportMode>> = {
  WALK: "walking",
  // Non-transit street modes for intermodal first/last-mile + direct legs.
  BIKE: "cycling",
  RENTAL: "cycling",
  CAR: "driving",
  CAR_PARKING: "driving",
  CAR_DROPOFF: "driving",
  // On-demand / flexible transit — closest base category is bus; the leg's
  // `flex` metadata drives the distinct "book ahead" treatment in the UI.
  ODM: "bus",
  RIDE_SHARING: "bus",
  FLEX: "bus",
  TRAM: "tram",
  SUBWAY: "subway",
  FERRY: "ferry",
  BUS: "bus",
  COACH: "bus",
  RAIL: "rail",
  HIGHSPEED_RAIL: "rail",
  LONG_DISTANCE: "rail",
  NIGHT_RAIL: "rail",
  REGIONAL_FAST_RAIL: "rail",
  REGIONAL_RAIL: "rail",
  SUBURBAN: "rail",
  FUNICULAR: "funicular",
  AERIAL_LIFT: "gondola",
  OTHER: "bus",
  MONORAIL: "monorail",
};

/** Map a MOTIS Mode to our TransportMode. Unknown modes default to "bus". */
export function motisMode(mode: Mode | string | undefined): TransportMode {
  if (!mode) return "bus";
  return MOTIS_MODE_MAP[mode as Mode] ?? "bus";
}

/**
 * Map a MOTIS leg to our TransportMode, refining `RENTAL` by GBFS form factor:
 * car-like rentals (CAR/MOPED) become "driving"; everything else uses the static
 * {@link motisMode} table (RENTAL/BIKE → cycling). Keeps the form-factor decision
 * in one place instead of patching motisMode's output at the call site.
 */
export function motisLegMode(leg: {
  mode?: Mode | string;
  rental?: { formFactor?: string | null } | null;
}): TransportMode {
  const form = leg.rental?.formFactor;
  if (form === "CAR" || form === "MOPED") return "driving";
  return motisMode(leg.mode);
}

/** Deduplicate mapped transport modes. */
export function uniqueModes(modes: (Mode | string)[]): TransportMode[] {
  return [...new Set(modes.map((m) => motisMode(m)))];
}
