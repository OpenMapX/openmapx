"use client";

import { useEnv } from "@/lib/EnvProvider";

/**
 * Minimum zoom at which an overlay is usable, keyed by overlay id.
 *
 * Marker overlays fetch every feature in the viewport bbox, so a country-sized
 * view pulls — and paints — thousands of them, which is what makes panning and
 * zooming stutter. Below the threshold the overlay stops fetching, its layers
 * stay hidden, and the layer selector disables the tile with a "Zoom N+" hint so
 * the state is explained rather than silently empty.
 *
 * Values are calibrated so a German state (~z7) still works while a whole-country
 * view (~z5-6) does not. Overlays absent from this map are never zoom-gated.
 *
 * `traffic` (the TomTom raster overlay) is deliberately not listed: its threshold
 * is operator-configurable via NEXT_PUBLIC_TRAFFIC_MIN_ZOOM and is resolved by
 * {@link useOverlayMinZoom}.
 */
export const OVERLAY_MIN_ZOOM: Readonly<Record<string, number>> = {
  "road-conditions": 7,
  "live-transit": 7,
};

/** Static threshold for an overlay; 0 when it isn't zoom-gated. */
export function overlayMinZoom(overlayId: string): number {
  return OVERLAY_MIN_ZOOM[overlayId] ?? 0;
}

/**
 * Threshold for an overlay, resolving the env-configured TomTom traffic value.
 * Returns 0 when the overlay isn't zoom-gated.
 */
export function useOverlayMinZoom(overlayId: string): number {
  const { trafficMinZoom } = useEnv();
  return overlayId === "traffic" ? trafficMinZoom : overlayMinZoom(overlayId);
}

/** True when `zoom` is known and below the overlay's threshold. */
export function isBelowOverlayMinZoom(zoom: number | null, minZoom: number): boolean {
  return zoom !== null && minZoom > 0 && zoom < minZoom;
}
