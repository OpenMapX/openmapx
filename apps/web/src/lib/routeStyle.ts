import { PRIMARY_BLUE_HEX } from "./theme";

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
} as const;

/** Alternates recede, and their bands recede with them. */
export const ROUTE_ALT_OPACITY = 0.75;
