"use client";

import { NAV_LANDSCAPE_PANEL_WIDTH } from "@/lib/layout";
import { useMapObstruction, useMeasuredMapObstruction } from "@/lib/mapObstructions";

/** The chrome column's outer width: the card plus its 16 px side insets. */
const NAV_COLUMN_WIDTH = NAV_LANDSCAPE_PANEL_WIDTH + 32;

/**
 * Registers what a navigation view covers: a left-hand column on wide screens,
 * the top banner on phones (the phone sheet registers itself). Nothing is
 * registered on the arrival card, which floats over the map centre.
 */
export function useNavChromeObstructions(
  prefix: "ground" | "transit",
  state: { isMobile: boolean; arrived: boolean; bannerEl: HTMLElement | null },
): void {
  const { isMobile, arrived, bannerEl } = state;
  useMapObstruction(
    `${prefix}-nav-column`,
    "left",
    !isMobile && !arrived ? NAV_COLUMN_WIDTH : null,
  );
  useMeasuredMapObstruction(`${prefix}-nav-banner`, "top", isMobile && !arrived ? bannerEl : null);
}
