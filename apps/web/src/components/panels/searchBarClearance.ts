"use client";

import { createContext, useContext } from "react";

/**
 * How a sidebar panel keeps its content out from under the floating search bar,
 * which overlaps the top of the desktop rail:
 *
 * - `"shell"`: the shell pads the rail by `SEARCH_BAR_CLEARANCE`, so the panel
 *   lays out as if the bar were not there. The default for every panel.
 * - `"content"`: the panel runs under the bar (a full-bleed photo, a layout
 *   sized to the viewport) and offsets its own parts with
 *   `useSearchBarClearance()`.
 * - `"none"`: the search bar is hidden while this panel is open.
 *
 * Mobile sheets sit below the bar, so none of these apply there.
 */
export type SearchBarClearance = "shell" | "content" | "none";

export const SearchBarClearanceContext = createContext<string | null>(null);

/**
 * The top inset, as a CSS length, that a `"content"` panel's parts need to
 * stay clear of the floating search bar. Null wherever the bar covers nothing:
 * on mobile, in the detail card, and inside panels the shell already pads.
 */
export function useSearchBarClearance(): string | null {
  return useContext(SearchBarClearanceContext);
}
