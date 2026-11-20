import { lerpHex } from "./hexColor";
import { TRAFFIC_BAND_COLORS } from "./trafficSeverity";

/**
 * The one traffic ramp. The flow overlay paints roads with it and the route's
 * congestion bands paint the route with it, so a jam cannot be one colour on
 * the road and another where the route runs along that same road.
 *
 * `speedRatio` (current ÷ free flow) drives the colour where it was measured.
 * A segment with no measured ratio is coloured by its declared level instead of
 * defaulting to green, so a DATEX-declared jam still reads as a jam.
 */
export const FLOW_RATIO_STOPS: ReadonlyArray<readonly [number, string]> = [
  [0, TRAFFIC_BAND_COLORS.severe],
  [0.25, TRAFFIC_BAND_COLORS.heavy],
  [0.5, TRAFFIC_BAND_COLORS.moderate],
  [0.75, TRAFFIC_BAND_COLORS.light],
  [1, TRAFFIC_BAND_COLORS.freeFlow],
];

export const FLOW_LOS_COLORS: Readonly<Record<string, string>> = {
  queuing: TRAFFIC_BAND_COLORS.heavy,
  stationary: TRAFFIC_BAND_COLORS.severe,
  blocked: TRAFFIC_BAND_COLORS.severe,
  heavy: TRAFFIC_BAND_COLORS.moderate,
  free_flow: TRAFFIC_BAND_COLORS.freeFlow,
  unknown: TRAFFIC_BAND_COLORS.freeFlow,
};

export const FLOW_FALLBACK_COLOR = TRAFFIC_BAND_COLORS.freeFlow;

/** The ramp evaluated in plain JS — for tests, legends and any non-MapLibre consumer. */
export function flowColorFor(los: string, speedRatio?: number | null): string {
  if (speedRatio == null || !Number.isFinite(speedRatio)) {
    return FLOW_LOS_COLORS[los] ?? FLOW_FALLBACK_COLOR;
  }
  const ratio = Math.min(1, Math.max(0, speedRatio));
  let low = FLOW_RATIO_STOPS[0];
  for (const high of FLOW_RATIO_STOPS.slice(1)) {
    if (!low) break;
    const [lowStop, lowColor] = low;
    const [highStop, highColor] = high;
    if (ratio <= highStop) {
      const span = highStop - lowStop;
      return span === 0 ? highColor : lerpHex(lowColor, highColor, (ratio - lowStop) / span);
    }
    low = high;
  }
  return FLOW_RATIO_STOPS.at(-1)?.[1] ?? FLOW_FALLBACK_COLOR;
}
