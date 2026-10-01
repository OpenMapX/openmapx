import type { MapInsets } from "@/lib/mapObstructions";

export const HOVER_CARD_WIDTH = 300;
/** Space between the POI's anchor point and the card's near edge. */
const ICON_GAP = 14;
/** Minimum distance kept from the free map area's edges. */
const EDGE_MARGIN = 8;

export interface HoverCardPlacement {
  left: number;
  /** The card sits below the POI and grows downward from `top`… */
  top?: number;
  /** …or above it, growing upward from `bottom` (both relative to the map container). */
  bottom?: number;
  side: "above" | "below";
}

/**
 * Where the hover card goes for a POI at `point` (map-container pixels):
 * centred on it, below it in the upper half of the free map area and above it
 * in the lower half, so the card always opens toward the larger space and
 * grows away from the icon as details load. Horizontally it is kept clear of
 * the side panel, search bar and other chrome registered as obstructions.
 */
export function hoverCardPlacement({
  point,
  mapSize,
  insets,
}: {
  point: { x: number; y: number };
  mapSize: { width: number; height: number };
  insets: MapInsets;
}): HoverCardPlacement {
  const minLeft = insets.left + EDGE_MARGIN;
  const maxLeft = mapSize.width - insets.right - EDGE_MARGIN - HOVER_CARD_WIDTH;
  const centred = point.x - HOVER_CARD_WIDTH / 2;
  const left = maxLeft < minLeft ? minLeft : Math.min(maxLeft, Math.max(minLeft, centred));

  const freeTop = insets.top;
  const freeBottom = mapSize.height - insets.bottom;
  const below = point.y < (freeTop + freeBottom) / 2;
  return below
    ? { left, top: point.y + ICON_GAP, side: "below" }
    : { left, bottom: mapSize.height - point.y + ICON_GAP, side: "above" };
}
