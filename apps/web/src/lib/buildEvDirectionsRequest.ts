import type { EvDirectionsRequest, LngLat } from "@openmapx/core";

/**
 * Single source of truth for building the `POST /directions/ev` request body.
 * `DirectionsPanelContent` (the plan card) and `RouteLayer` (the map line +
 * charge-stop pins) each run their own independent `useEvDirections(req)`
 * call — same pattern `useDirections` already uses for the non-EV route — so
 * both must build byte-identical requests for the query cache to hit. Do NOT
 * inline this construction in either caller; extend this function instead.
 */
export interface EvDirectionsRequestInput {
  isEvMode: boolean;
  waypoints: LngLat[];
  allWaypointsFilled: boolean;
  vehicleId: string | null;
  socStartPct: number;
  socArrivalMinPct: number;
  socTargetPct: number;
  departAt?: string;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
  avoidClosures: boolean;
  preferredNetworks: string[];
  avoidedNetworks: string[];
  /** Persisted hard-whitelist preference. */
  exclusiveNetworks: boolean;
  /** Transient one-shot override from the "route without the network restriction" recovery action. */
  forceNonExclusive: boolean;
  preferCheaper: boolean;
  homePricePerKwh: number | null;
  homeCurrency: string;
  units: "metric" | "imperial";
  lang: string;
}

export function buildEvDirectionsRequest(
  input: EvDirectionsRequestInput,
): EvDirectionsRequest | null {
  if (!input.isEvMode || !input.allWaypointsFilled || !input.vehicleId) return null;
  return {
    waypoints: input.waypoints,
    vehicleId: input.vehicleId,
    socStartPct: input.socStartPct,
    socArrivalMinPct: input.socArrivalMinPct,
    socTargetPct: input.socTargetPct,
    departAt: input.departAt,
    avoidClosures: input.avoidClosures,
    avoidTolls: input.avoidTolls,
    avoidHighways: input.avoidHighways,
    avoidFerries: input.avoidFerries,
    preferredNetworks: input.preferredNetworks,
    avoidedNetworks: input.avoidedNetworks,
    exclusiveNetworks: input.forceNonExclusive ? false : input.exclusiveNetworks,
    preferCheaper: input.preferCheaper,
    homePricePerKwh: input.homePricePerKwh ?? undefined,
    homeCurrency: input.homeCurrency,
    units: input.units,
    lang: input.lang,
  };
}
