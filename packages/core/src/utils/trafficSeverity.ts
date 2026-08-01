/**
 * Shared traffic-severity vocabulary: the five colour stops the traffic-flow
 * overlay strokes roads with, and the mapping from a route's live-traffic
 * delay to one of those bands.
 *
 * The hexes are map colours. They are deliberately NOT usable as text — the
 * lightest two fall well below the 4.5:1 AA floor on a white surface. Text
 * tones live as CSS custom properties (`--omx-traffic-*`) so light/dark
 * switching stays in CSS.
 */

export type TrafficBand = "freeFlow" | "light" | "moderate" | "heavy" | "severe";

/**
 * The bands a delay can actually land in. `freeFlow` is excluded at the type
 * level: below the display threshold nothing is shown, so a caller never has to
 * write a dead branch for it.
 */
export type DelayBand = Exclude<TrafficBand, "freeFlow">;

/** Map stroke colour per band, green (free) through dark red (severe). */
export const TRAFFIC_BAND_COLORS: Record<TrafficBand, string> = {
  freeFlow: "#2ecc40",
  light: "#ffd500",
  moderate: "#ff8c00",
  heavy: "#e8112d",
  severe: "#7e0023",
};

/**
 * Below this fraction of extra travel time, a delay is not worth surfacing:
 * a 90-second difference on a two-hour drive tells the user nothing and would
 * make every route look congested.
 */
const MIN_DISPLAY_RATIO = 0.1;

/**
 * Band for a route-level delay fraction `(live - baseline) / baseline`.
 *
 * Deliberately keyed on delay fraction rather than the overlay's `speed_ratio`:
 * a route-level speed ratio is diluted by every free-flowing kilometre, so a
 * ten-minute jam inside a ninety-minute drive lands near 0.89 and would read as
 * green. `freeFlow` is therefore not in the return type — below the threshold
 * the caller shows nothing at all, because a green ETA would imply we had
 * verified the route is clear when most segments carry no measurement.
 */
export function bandForDelayRatio(delayFraction: number): DelayBand | null {
  if (!Number.isFinite(delayFraction) || delayFraction < MIN_DISPLAY_RATIO) return null;
  if (delayFraction < 0.25) return "light";
  if (delayFraction < 0.5) return "moderate";
  if (delayFraction < 1) return "heavy";
  return "severe";
}
