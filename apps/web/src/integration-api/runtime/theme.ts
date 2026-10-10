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
 * BRAND above. Green ETAs use BRAND separately and require complete, fresh
 * congestion coverage; a small recosting difference alone is insufficient.
 */
export const TRAFFIC_TEXT_COLOR: Record<DelayBand, string> = {
  light: "var(--omx-traffic-light)",
  moderate: "var(--omx-traffic-moderate)",
  heavy: "var(--omx-traffic-heavy)",
  severe: "var(--omx-traffic-severe)",
};
