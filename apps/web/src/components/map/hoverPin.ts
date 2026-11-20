import type { Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";

/**
 * Whether the pointer is on the hover pin's DOM element. The pin is drawn
 * above every map feature, so a layer keeps its hover there even when a
 * neighbouring marker or label lies underneath the pin.
 */
export function onHoverPinElement(event: MapMouseEvent | undefined): boolean {
  const target = event?.originalEvent?.target;
  return target instanceof Element && Boolean(target.closest("[data-openmapx-pin-marker]"));
}

/**
 * Whether the pointer is inside the box the hover pin covers above its
 * result's point. Moving from the result up onto the pin keeps the hover
 * even before the pointer reaches the pin's element.
 */
export function withinHoverPinBox(
  map: MaplibreMap,
  event: MapMouseEvent | undefined,
  pin: [number, number] | null,
): boolean {
  if (!event || !pin) return false;
  const point = map.project(pin);
  return (
    Math.abs(event.point.x - point.x) <= 16 &&
    event.point.y >= point.y - 36 &&
    event.point.y <= point.y + 8
  );
}
