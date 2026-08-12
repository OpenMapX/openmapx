"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useMemo, useRef } from "react";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { HotspotLayer, type WildfirePopupController } from "./layers/hotspot-layer";
import { useWildfireStore } from "./store";

export function WildfireLayer() {
  const layerVisible = useWildfireStore((s) => s.layerVisible);
  const showHotspots = useWildfireStore((s) => s.showHotspots);
  useIntegrationAttribution("overlay-wildfires", layerVisible);
  useOverlayExclusion("wildfires", layerVisible);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const popupController = useMemo<WildfirePopupController>(
    () => ({
      open: (popup) => {
        popupRef.current?.remove();
        popupRef.current = popup;
      },
      close: () => {
        popupRef.current?.remove();
        popupRef.current = null;
      },
    }),
    [],
  );

  return <HotspotLayer active={layerVisible && showHotspots} popupController={popupController} />;
}
