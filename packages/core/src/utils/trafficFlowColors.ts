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
  [0, "#7e0023"],
  [0.25, "#e8112d"],
  [0.5, "#ff8c00"],
  [0.75, "#ffd500"],
  [1, "#2ecc40"],
];

export const FLOW_LOS_COLORS: Readonly<Record<string, string>> = {
  queuing: "#e8112d",
  stationary: "#7e0023",
  blocked: "#7e0023",
  heavy: "#ff8c00",
  free_flow: "#2ecc40",
  unknown: "#2ecc40",
};

export const FLOW_FALLBACK_COLOR = "#2ecc40";

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
