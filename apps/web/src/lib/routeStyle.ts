import { type RouteWidthExpression, routeWidthExpression } from "@openmapx/core";
import { PRIMARY_BLUE_HEX } from "@/integration-api/runtime/theme";

/** One lane: the navigation route grows to this real width once it is wider than its pixels. */
export const ROUTE_LANE_METRES = 3.2;

/**
 * Navigation route widths for a latitude: 11/8/7 px (casing/line/travelled)
 * until a lane is wider than the line, then a lane-wide ribbon with the casing
 * still 3 px wider and the travelled line 1 px narrower.
 */
export function navRouteWidths(latitude: number): {
  line: RouteWidthExpression;
  casing: RouteWidthExpression;
  traveled: RouteWidthExpression;
} {
  const base = ROUTE_WIDTHS.nav.line;
  return {
    line: routeWidthExpression(base, ROUTE_LANE_METRES, latitude),
    casing: routeWidthExpression(base, ROUTE_LANE_METRES, latitude, ROUTE_WIDTHS.nav.casing - base),
    traveled: routeWidthExpression(
      base,
      ROUTE_LANE_METRES,
      latitude,
      ROUTE_WIDTHS.nav.traveled - base,
    ),
  };
}

/**
 * Route line geometry, in one place, because three layers draw the same route
 * and the congestion bands have to match the line they sit on exactly: a band
 * is painted at the line's width so the casing still frames it on both sides.
 */
export const ROUTE_WIDTHS = {
  planning: { casing: 10, line: 7, altCasing: 7, altLine: 5 },
  nav: { casing: 11, line: 8, traveled: 7, altLine: 6 },
} as const;

export const ROUTE_COLORS = {
  active: PRIMARY_BLUE_HEX,
  casing: "#ffffff",
  alt: "#93C5FD",
  navAlt: "#80868b",
  traveled: "#9aa0a6",
  /** Pending faster-route offer, distinct from the active and alternate lines. */
  proposed: "#207E23",
} as const;

/** Alternates recede, and their bands recede with them. */
export const ROUTE_ALT_OPACITY = 0.75;
