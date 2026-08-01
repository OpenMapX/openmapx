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

function lerpHex(from: string, to: string, t: number): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  const mix = (at: number) =>
    Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(1)}${mix(3)}${mix(5)}`;
}

/** The ramp evaluated in plain JS — for tests, legends and any non-MapLibre consumer. */
export function flowColorFor(los: string, speedRatio?: number | null): string {
  if (speedRatio == null || !Number.isFinite(speedRatio)) {
    return FLOW_LOS_COLORS[los] ?? FLOW_FALLBACK_COLOR;
  }
  const ratio = Math.min(1, Math.max(0, speedRatio));
  for (let i = 1; i < FLOW_RATIO_STOPS.length; i++) {
    const [lowStop, lowColor] = FLOW_RATIO_STOPS[i - 1];
    const [highStop, highColor] = FLOW_RATIO_STOPS[i];
    if (ratio <= highStop) {
      const span = highStop - lowStop;
      return span === 0 ? highColor : lerpHex(lowColor, highColor, (ratio - lowStop) / span);
    }
  }
  return FLOW_RATIO_STOPS[FLOW_RATIO_STOPS.length - 1][1];
}
