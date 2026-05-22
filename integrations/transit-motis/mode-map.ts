import type { Mode } from "@motis-project/motis-client";
import type { TransportMode } from "@openmapx/mobility-core/transit";

const MOTIS_MODE_MAP: Partial<Record<Mode | "MONORAIL", TransportMode>> = {
  WALK: "walking",
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

/** Deduplicate mapped transport modes. */
export function uniqueModes(modes: (Mode | string)[]): TransportMode[] {
  return [...new Set(modes.map((m) => motisMode(m)))];
}
