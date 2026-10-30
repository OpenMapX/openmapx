import { claimMapClickForMarker } from "./mapClickOwnership";

export interface MapMarkerActivationOptions {
  /** Runs on a pointer click or Enter/Space. Omit for a marker that only keeps its clicks off the map. */
  onActivate?: () => void;
  /**
   * Read on every click. While it returns false the marker is see-through: the
   * click reaches the map as if the marker were not there.
   */
  isEnabled?: () => boolean;
}

/**
 * Makes a DOM marker element own the clicks that land on it.
 *
 * MapLibre mounts marker elements inside the map's canvas container, so a click
 * on one bubbles to the map and fires the map's `click` event at that point.
 * Unclaimed, every map click handler treats it as a click on the map
 * underneath: the plain-map handler drops a grey pin and closes the place
 * panel, and layer handlers open whatever feature lies below the marker.
 *
 * The click is claimed through map click ownership rather than stopped, so it
 * still reaches listeners outside the map, such as the context menu's
 * click-away dismissal. A click an active picker or tool owns (repositioning a
 * parked car, placing a report, measuring) stays the picker's: the marker
 * neither activates nor claims it.
 */
export function bindMapMarkerActivation(
  element: HTMLElement,
  { onActivate, isEnabled }: MapMarkerActivationOptions = {},
): void {
  element.addEventListener("click", (event) => {
    if (isEnabled && !isEnabled()) return;
    if (!claimMapClickForMarker(event)) return;
    onActivate?.();
  });
  if (!onActivate) return;
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isEnabled && !isEnabled()) return;
    event.preventDefault();
    // The key was handled here; nothing behind the marker should act on it too.
    event.stopPropagation();
    onActivate();
  });
}
