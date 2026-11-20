import type { Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";

/**
 * Whether the pointer is over the hover pin drawn above a result: its DOM
 * element, or the box it covers above the result's point. A layer keeps its
 * hover there, so moving onto the pin does not take the pin away.
 */
export function overHoverPin(
  map: MaplibreMap,
  event: MapMouseEvent | undefined,
  pin: [number, number] | null,
): boolean {
  if (!event) return false;
  const target = event.originalEvent?.target;
  if (target instanceof Element && target.closest("[data-openmapx-pin-marker]")) return true;
  if (!pin) return false;
  const point = map.project(pin);
  return (
    Math.abs(event.point.x - point.x) <= 16 &&
    event.point.y >= point.y - 36 &&
    event.point.y <= point.y + 8
  );
}
