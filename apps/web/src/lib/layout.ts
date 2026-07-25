/** Shared layout constants for the sidebar panels. */
export const PANEL_WIDTH = 400;

/**
 * Width of the left-hand nav-chrome column on wide viewports (desktop and
 * phone-landscape, both above the `sm` breakpoint). Both the driving and transit
 * navigation views confine their banner + bottom panel to this width so the map
 * stays visible on the right.
 */
export const NAV_LANDSCAPE_PANEL_WIDTH = 400;

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
