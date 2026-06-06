import type { TransportMode, TripItinerary } from "@openmapx/mobility-core/transit";

export const MODE_COLORS: Record<TransportMode, string> = {
  rail: "#1A73E8",
  subway: "#E53935",
  tram: "#F9A825",
  bus: "#0F9D58",
  ferry: "#00ACC1",
  gondola: "#8E24AA",
  funicular: "#8E24AA",
  cable_car: "#8E24AA",
  monorail: "#1A73E8",
  walking: "#757575",
  cycling: "#34A853",
  driving: "#5F6368",
};

/**
 * Resolve a transit route's display colour: its own GTFS colour (normalised to a
 * leading "#") when present, else the per-mode default from {@link MODE_COLORS}.
 * `fallback` is returned only when the route carries neither a colour nor a known
 * mode (e.g. a partial or absent route object).
 */
export function routeColor(
  route: { color?: string | null; mode?: TransportMode } | null | undefined,
  fallback: string = MODE_COLORS.bus,
): string {
  if (route?.color) return `#${route.color.replace(/^#/, "")}`;
  const mode = route?.mode;
  return (mode && MODE_COLORS[mode]) || fallback;
}

/**
 * Single-select "first/last mile" access mode for intermodal transit planning,
 * mirroring Google Maps' "Bike + Transit" / park-and-ride options. `walk` is the
 * MOTIS default (no pre/post modes set). `bike`/`car` request access legs to and
 * from stops plus a `direct` (door-to-door) option so a pure bike/drive
 * alternative shows up next to the transit itineraries.
 */
export const TRANSIT_ACCESS_OPTIONS = ["walk", "bike", "car"] as const;
export type TransitAccessMode = (typeof TRANSIT_ACCESS_OPTIONS)[number];

export interface TransitAccessMotisModes {
  preTransitModes?: string[];
  postTransitModes?: string[];
  directModes?: string[];
}

/** Expand a UI access mode into the MOTIS `/plan` mode params it implies. */
export const TRANSIT_ACCESS_MOTIS_MODES: Record<TransitAccessMode, TransitAccessMotisModes> = {
  walk: {},
  // `RENTAL` brings GBFS bike/scooter-share into first/last-mile + direct legs
  // alongside the user's own bike (no-op where no GBFS feeds are configured).
  bike: {
    preTransitModes: ["BIKE", "RENTAL"],
    postTransitModes: ["BIKE", "RENTAL"],
    directModes: ["BIKE", "RENTAL"],
  },
  car: {
    preTransitModes: ["CAR_PARKING"],
    postTransitModes: ["CAR_PARKING"],
    directModes: ["CAR"],
  },
};

/**
 * User-facing transit mode preferences shown in the "Prefer" column of the
 * Route options panel (mirrors Google Maps). A selection acts as an allow-list:
 * MOTIS treats `transitModes` as a hard filter, so checking Bus + Train returns
 * only bus and train journeys. With nothing checked we send the `TRANSIT`
 * meta-mode (all modes, no restriction).
 */
export const TRANSIT_PREFER_OPTIONS = ["bus", "subway", "train", "tram"] as const;
export type TransitPreferKey = (typeof TRANSIT_PREFER_OPTIONS)[number];

/**
 * Maps each UI preference to the concrete MOTIS `Mode` enum strings it expands
 * to. `train` deliberately excludes `SUBWAY` so the Subway and Train toggles
 * stay distinct; `bus` includes `COACH` so intercity coaches count as buses.
 */
export const TRANSIT_PREFER_MOTIS_MODES: Record<TransitPreferKey, string[]> = {
  bus: ["BUS", "COACH"],
  subway: ["SUBWAY"],
  train: [
    "HIGHSPEED_RAIL",
    "LONG_DISTANCE",
    "NIGHT_RAIL",
    "REGIONAL_FAST_RAIL",
    "REGIONAL_RAIL",
    "SUBURBAN",
  ],
  tram: ["TRAM"],
};

/**
 * Expand a set of UI preferences into the comma-joinable MOTIS `transitModes`
 * list. Returns `undefined` when nothing is selected so callers fall back to
 * the MOTIS default (`TRANSIT`).
 */
export function preferredModesToMotis(keys: TransitPreferKey[]): string[] | undefined {
  if (keys.length === 0) return undefined;
  const out: string[] = [];
  for (const key of keys) {
    for (const mode of TRANSIT_PREFER_MOTIS_MODES[key]) {
      if (!out.includes(mode)) out.push(mode);
    }
  }
  return out;
}

/**
 * MOTIS transit modes covered by the German Deutschlandticket — i.e. all local
 * and regional transport (Nahverkehr/SPNV/ÖPNV). The excluded long-distance
 * modes are HIGHSPEED_RAIL (ICE), LONG_DISTANCE (IC/EC/FlixTrain), NIGHT_RAIL,
 * COACH (long-distance buses like FlixBus) and AIRPLANE. Local FERRY/FUNICULAR/
 * AERIAL_LIFT are kept in — most that surface in transit routing are ÖPNV
 * services (e.g. HVV ferries, Stuttgart Zahnradbahn).
 *
 * This is a vehicle-category approximation, matching Google Maps and DB's
 * "Nur Nahverkehr" filter. It does not honour the handful of IC
 * "Nahverkehrsfreigabe" route exceptions where DB accepts the ticket on
 * specific long-distance segments, so those connections are hidden.
 */
export const DEUTSCHLANDTICKET_MOTIS_MODES = [
  "REGIONAL_FAST_RAIL",
  "REGIONAL_RAIL",
  "SUBURBAN",
  "SUBWAY",
  "TRAM",
  "BUS",
  "FERRY",
  "FUNICULAR",
  "AERIAL_LIFT",
] as const;

/**
 * Constrain a requested `transitModes` allow-list to only Deutschlandticket-
 * covered modes. With no prior preference the full covered set is used; an
 * existing preference is intersected with it (e.g. "Train" drops its ICE/IC
 * modes, keeping only REGIONAL_RAIL + SUBURBAN). Never returns an empty list —
 * an empty intersection falls back to the full covered set so the plan still
 * routes instead of MOTIS computing no transit at all.
 */
export function applyDeutschlandticketFilter(modes: string[] | undefined): string[] {
  const covered = new Set<string>(DEUTSCHLANDTICKET_MOTIS_MODES);
  if (!modes || modes.length === 0) return [...DEUTSCHLANDTICKET_MOTIS_MODES];
  const filtered = modes.filter((m) => covered.has(m));
  return filtered.length > 0 ? filtered : [...DEUTSCHLANDTICKET_MOTIS_MODES];
}

/**
 * Single-select route optimisation, mirroring Google Maps' "Routes" column.
 * `wheelchair` maps to MOTIS `pedestrianProfile=WHEELCHAIR`; `fewerTransfers`
 * and `lessWalking` re-rank the Pareto front MOTIS returns (see
 * {@link rankItineraries}); `best` keeps the engine's own order.
 */
export type TransitRoutePreference = "best" | "fewerTransfers" | "lessWalking" | "wheelchair";

/**
 * Re-order itineraries client-side to honour the selected route preference.
 * MOTIS has no transfer/walk penalty knobs (it is Pareto-multi-criteria), so we
 * sort the returned alternatives instead of constraining the request, which
 * never risks an empty result. Returns a new array; the input is untouched.
 */
export function rankItineraries(
  itineraries: TripItinerary[],
  preference: TransitRoutePreference,
): TripItinerary[] {
  if (preference === "fewerTransfers") {
    return [...itineraries].sort((a, b) => a.transfers - b.transfers || a.duration - b.duration);
  }
  if (preference === "lessWalking") {
    return [...itineraries].sort(
      (a, b) => a.walkDistance - b.walkDistance || a.duration - b.duration,
    );
  }
  return itineraries;
}
