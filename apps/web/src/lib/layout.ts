/** Shared layout constants for the sidebar panels. */

/**
 * Padding that keeps a full-screen surface's content out of the system bars
 * and display cutouts. The installed app and an installed web app draw the
 * page under them (`viewport-fit=cover`); in a plain browser tab the insets
 * are 0, so this changes nothing there.
 */
export const SAFE_AREA_PADDING = {
  pt: "var(--omx-safe-top)",
  pb: "var(--omx-safe-bottom)",
  pl: "var(--omx-safe-left)",
  pr: "var(--omx-safe-right)",
} as const;
export const PANEL_WIDTH = 400;

/**
 * Gap between the status bar (or a display cutout) and the chrome floating
 * below it, the same 8px Google Maps leaves above its search bar on Android.
 * The status bar already sets the chrome apart from the screen edge, so the
 * page's own edge spacing on top of it reads as wasted space.
 */
export const STATUS_BAR_GAP = 8;

/**
 * Top offset for chrome that floats `edge` px below the top of the page. Under
 * a status bar (the installed app, an installed web app) the chrome sits
 * `STATUS_BAR_GAP` below the bar instead; in a browser tab the inset is 0 and
 * `edge` applies. `below` adds the height of the rows stacked above it.
 */
export function topInset(edge: number, below = 0): string {
  const base = `max(${edge}px, var(--omx-safe-top) + ${STATUS_BAR_GAP}px)`;
  return below ? `calc(${base} + ${below}px)` : base;
}

/** Offset of the floating search bar from the top and left edges of the map. */
export const SEARCH_BAR_INSET = 12;
/** Height of the floating search bar's input row. */
export const SEARCH_BAR_HEIGHT = 48;
/** Top of the floating search bar. */
export const SEARCH_BAR_TOP = topInset(SEARCH_BAR_INSET);

/**
 * Top strip of the desktop sidebar that the floating search bar covers, plus
 * `SEARCH_BAR_INSET` of breathing room below the bar. Panels keep their
 * content out of this strip; see `searchBarClearance` in the panels directory.
 */
export const SEARCH_BAR_CLEARANCE = topInset(
  SEARCH_BAR_INSET,
  SEARCH_BAR_HEIGHT + SEARCH_BAR_INSET,
);

/**
 * Width of the left-hand nav-chrome column on wide viewports (desktop and
 * phone-landscape, both above the `sm` breakpoint). Both the driving and transit
 * navigation views confine their banner + bottom panel to this width so the map
 * stays visible on the right.
 */
export const NAV_LANDSCAPE_PANEL_WIDTH = 400;

/**
 * Gap (px) between the turn-by-turn chrome (maneuver banner, bottom bar) and
 * the safe-area edges of the screen. Overlays shown over that chrome (the
 * search-along-route picker and stop card) use it too, so they line up.
 */
export const NAV_CHROME_INSET = 16;
/** Top of the turn-by-turn chrome and the overlays that line up with it. */
export const NAV_CHROME_TOP = topInset(NAV_CHROME_INSET);

/**
 * Whether the left sidebar panel is currently occupying horizontal space, so
 * bottom-anchored map chrome (the footer's legal links + credits, the overlay
 * legends) must clear it by shifting right `PANEL_WIDTH`.
 *
 * False while navigating: turn-by-turn hides the panel even though it stays
 * "open" in the sidebar store (it is restored when navigation ends — see
 * `HideDuringNavigation`), so anything positioned against the panel must treat
 * it as absent. Every consumer shares this one predicate so they can't drift
 * apart on that rule again.
 */
export function isPanelShiftActive(state: {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  navigating: boolean;
}): boolean {
  return state.sidebarOpen && !state.sidebarCollapsed && !state.navigating;
}

/**
 * Whether the layer selector is actually covered by a panel rather than merely
 * sharing the map with an expanded sidebar. Desktop sidebars occupy a stable
 * left rail, so the selector can remain available beside them. Mobile sheets
 * only need the legacy avoidance rule while a selected place is open in the
 * sidebar; a detail panel always covers the selector on either viewport.
 */
export function shouldHideLayerSelector(state: {
  desktop: boolean;
  detailOpen: boolean;
  sidebarOpen: boolean;
  selectedPlace: boolean;
}): boolean {
  return state.detailOpen || (!state.desktop && state.sidebarOpen && state.selectedPlace);
}
