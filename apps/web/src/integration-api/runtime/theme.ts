import type { DelayBand } from "@openmapx/core";

/**
 * Brand colour palette — matches MUI `primary.main` and the landing page's brand
 * green. Uses CSS custom properties for automatic light/dark switching.
 */
export const BRAND = "var(--omx-brand)";
export const BRAND_LIGHT = "var(--omx-brand-light)";

/** Route/navigation blue. Uses CSS variable for dark mode. */
export const PRIMARY_BLUE = "var(--omx-primary-blue)";

/** Raw hex values for contexts that don't support CSS variables (e.g. MapLibre paint). */
export const PRIMARY_BLUE_HEX = "#1A73E8";
export const BRAND_HEX = "#207E23";

/**
 * Traffic-delay text colours, keyed by the shared `TrafficBand` names. CSS
 * variables rather than hexes so light/dark switching stays in CSS, matching
 * BRAND above. `freeFlow` is absent by design: a delay below the display
 * threshold is not shown at all, and a green ETA would imply we had verified
 * the route is clear.
 */
export const TRAFFIC_TEXT_COLOR: Record<DelayBand, string> = {
  light: "var(--omx-traffic-light)",
  moderate: "var(--omx-traffic-moderate)",
  heavy: "var(--omx-traffic-heavy)",
  severe: "var(--omx-traffic-severe)",
};
