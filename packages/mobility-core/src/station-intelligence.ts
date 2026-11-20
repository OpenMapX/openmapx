import type {
  TransitInterchangeComplexity,
  TransitPlatformDetail,
  TransitStationIntelligence,
  TransitStopAreaSummary,
  TransitStopParking,
  TransportMode,
} from "./types/transit.js";

export interface StationIntelligenceInput {
  /** The stop the caller asked for, when the provider resolves one. */
  requestedStop?: TransitStopAreaSummary;
  /** The stop the provider treats as the station itself, when it differs. */
  canonicalStop?: TransitStopAreaSummary;
  parentStop?: TransitStopAreaSummary;
  siblingStops: TransitStopAreaSummary[];
  childStops: TransitStopAreaSummary[];
  platforms: TransitPlatformDetail[];
  parking: TransitStopParking[];
}

/**
 * How complex a station is to change at, from the modes it serves, the stop
 * areas it connects and its platforms, so every provider grades stations the
 * same way.
 */
export function deriveStationIntelligence(
  input: StationIntelligenceInput,
): TransitStationIntelligence {
  const modeSet = new Set<TransportMode>([
    ...(input.requestedStop?.modes ?? []),
    ...(input.canonicalStop?.modes ?? []),
    ...(input.parentStop?.modes ?? []),
    ...input.siblingStops.flatMap((stop) => stop.modes),
    ...input.childStops.flatMap((stop) => stop.modes),
    ...input.platforms.flatMap((platform) => platform.modes),
  ]);
  const modeCount = modeSet.size;
  const connectedStopAreaCount =
    input.childStops.length > 0
      ? input.childStops.length + 1
      : input.siblingStops.length > 0
        ? input.siblingStops.length + 1
        : 1;
  const platformCount = input.platforms.length;

  let complexity: TransitInterchangeComplexity = "simple_stop";
  if (
    platformCount >= 8 ||
    connectedStopAreaCount >= 4 ||
    (modeCount >= 3 && platformCount >= 5) ||
    (modeCount >= 4 && connectedStopAreaCount >= 3)
  ) {
    complexity = "major_interchange";
  } else if (
    platformCount >= 4 ||
    connectedStopAreaCount >= 3 ||
    (modeCount >= 3 && platformCount >= 3) ||
    (modeCount >= 2 && connectedStopAreaCount >= 2 && platformCount >= 2)
  ) {
    complexity = "regional_hub";
  } else if (
    modeCount >= 2 ||
    connectedStopAreaCount >= 2 ||
    platformCount >= 2 ||
    input.parking.length > 0
  ) {
    complexity = "interchange";
  }

  return {
    complexity,
    modeCount,
    hasParking: input.parking.length > 0,
    hasRealtimeParking: input.parking.some(
      (parking) => parking.hasRealtimeData && typeof parking.freeSpaces === "number",
    ),
  };
}
