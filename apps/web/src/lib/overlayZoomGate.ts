"use client";

import { integrationIdToOverlayId, useMapStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useMemo } from "react";

/**
 * Zoom gating for overlays, declared per integration as
 * `frontend.overlay.minZoom` in its manifest.
 *
 * Below the threshold an overlay is treated as unusable: the layer selector
 * disables its control and shows a "Zoom N+" hint instead of toggling on
 * something that would render nothing, and overlays that fetch viewport-bbox
 * data skip fetching entirely — which is what keeps a country-sized view from
 * pulling (and painting) thousands of features.
 *
 * An absent or zero `minZoom` means the overlay is never gated. That is the
 * right default for raster/vector-tile overlays, whose tile pyramid already
 * handles zoom cheaply, and for global feeds meant to be read at world view.
 */

/** Manifest `minZoom` for an overlay; 0 when it isn't zoom-gated. */
export function useOverlayMinZoom(overlayId: string): number {
  const registry = useIntegrationRegistry();
  return useMemo(() => {
    const match = registry
      .getAll()
      .find((integration) => integrationIdToOverlayId(integration.id) === overlayId);
    return match?.frontend?.overlay?.minZoom ?? 0;
  }, [registry, overlayId]);
}

export interface OverlayZoomGate {
  /** Manifest threshold; 0 when ungated. */
  minZoom: number;
  /** True when the overlay is gated and the map is currently below it. */
  belowMinZoom: boolean;
}

/**
 * Resolve an overlay's gate against the live map zoom. Reads the shared map
 * store rather than subscribing each caller to map events, so the many layer
 * selector tiles don't each attach their own listener.
 */
export function useOverlayZoomGate(overlayId: string): OverlayZoomGate {
  const minZoom = useOverlayMinZoom(overlayId);
  const zoom = useMapStore((s) => s.zoom);
  return { minZoom, belowMinZoom: minZoom > 0 && zoom < minZoom };
}
