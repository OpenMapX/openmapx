import type { Map as MaplibreMap } from "maplibre-gl";
import { createContext, type RefObject, useContext } from "react";

/**
 * Curated host map surface exposed to community frontend overlays. The host
 * (apps/web) provides the concrete value via `HostMapContext.Provider`; a
 * community `map-layer.tsx` reads it with `useHostMap()`. Because this lives in
 * `@openmapx/integration-framework/react` (a runtime external resolved through
 * the page's import map to the host's singleton), a community bundle reads the
 * SAME context the host provides — so `mapRef.current` is the real host map.
 *
 * Pair this with `maplibre-gl` (also a runtime external) for `Popup`/expressions
 * that must operate on the host's maplibre instance.
 */
export interface HostMapApi {
  /** Ref to the live MapLibre map. Stable for the map's lifetime. */
  mapRef: RefObject<MaplibreMap | null>;
  /** True once the base style has loaded (safe to add sources/layers). */
  mapReady: boolean;
  /** Increments on every style reload — include in effect deps to re-attach layers after a base-map switch. */
  styleVersion: number;
  /** Id of the first symbol (label) layer, for inserting overlays beneath labels. */
  getFirstSymbolLayerId(): string | undefined;
  /** Move a layer beneath the label layers (call after adding it / when styleVersion changes). */
  anchorBelowLabels(layerId: string): void;
  /** Register/unregister a layer as interactive so host click handling doesn't clear the selection. */
  setLayerInteractive(layerId: string, interactive: boolean): void;
}

export const HostMapContext = createContext<HostMapApi | null>(null);

export function useHostMap(): HostMapApi {
  const ctx = useContext(HostMapContext);
  if (!ctx) {
    throw new Error("useHostMap must be used within the OpenMapX host map provider");
  }
  return ctx;
}
