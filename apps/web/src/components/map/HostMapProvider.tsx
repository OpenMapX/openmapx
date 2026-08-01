"use client";

import { type HostMapApi, HostMapContext } from "@openmapx/integration-framework/react";
import { useMemo } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { getFirstSymbolLayerId } from "./layers/layerStyleUtils";

/**
 * Bridges the app-internal MapContext to the curated `HostMapApi` that community
 * code overlays consume via `useHostMap()` (from `@openmapx/integration-framework/react`,
 * a runtime external). Built-ins keep using `@/lib/MapContext` directly; this
 * exposes a stable, minimal surface to bundled community frontends without
 * leaking apps/web internals.
 */
export function HostMapProvider({ children }: { children: React.ReactNode }) {
  const { mapRef, mapReady, styleVersion } = useMap();

  const api = useMemo<HostMapApi>(
    () => ({
      mapRef,
      mapReady,
      styleVersion,
      getFirstSymbolLayerId: () => {
        const m = mapRef.current;
        return m ? getFirstSymbolLayerId(m) : undefined;
      },
      anchorBelowLabels: (layerId: string) => {
        // Inlined rather than calling into the (now-deleted) declared-slot
        // machinery: community overlays reached via this SDK surface aren't
        // registered in the host's slot registry, so they still need the
        // literal "move below the first symbol layer" behaviour.
        const m = mapRef.current;
        if (!m?.getLayer(layerId)) return;
        const beforeLayerId = getFirstSymbolLayerId(m);
        if (beforeLayerId) {
          m.moveLayer(layerId, beforeLayerId);
          return;
        }
        m.moveLayer(layerId);
      },
      setLayerInteractive: (layerId: string, interactive: boolean) => {
        if (interactive) INTERACTIVE_LAYER_IDS.add(layerId);
        else INTERACTIVE_LAYER_IDS.delete(layerId);
      },
    }),
    [mapRef, mapReady, styleVersion],
  );

  return <HostMapContext.Provider value={api}>{children}</HostMapContext.Provider>;
}
