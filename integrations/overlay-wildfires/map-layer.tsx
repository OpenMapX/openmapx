"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useMemo, useRef } from "react";
import { useIntegrationSourceAttributions } from "@/lib/useIntegrationAttribution";
import { EffisBurnedAreaLayer } from "./layers/effis-burned-area-layer";
import { HotspotLayer, type WildfirePopupController } from "./layers/hotspot-layer";
import { NifcPerimeterLayer } from "./layers/nifc-perimeter-layer";
import { useWildfireStore } from "./store";

export function WildfireLayer() {
  const layerVisible = useWildfireStore((s) => s.layerVisible);
  const showHotspots = useWildfireStore((s) => s.showHotspots);
  const showNifcPerimeters = useWildfireStore((s) => s.showNifcPerimeters);
  const showEffisBurnedAreas = useWildfireStore((s) => s.showEffisBurnedAreas);
  const nifcStatus = useWildfireStore((s) => s.statuses.nifc);
  const effisStatus = useWildfireStore((s) => s.statuses.effis);
  const attributionSourceIds = useMemo(() => {
    if (!layerVisible) return [];
    const sourceIds: string[] = [];
    if (showHotspots) sourceIds.push("firms");
    if (showNifcPerimeters && (nifcStatus.loading || nifcStatus.featureCount !== null)) {
      sourceIds.push("nifc-wfigs");
    }
    if (showEffisBurnedAreas && (effisStatus.loading || effisStatus.featureCount !== null)) {
      sourceIds.push("effis");
    }
    return sourceIds;
  }, [
    effisStatus.featureCount,
    effisStatus.loading,
    layerVisible,
    nifcStatus.featureCount,
    nifcStatus.loading,
    showEffisBurnedAreas,
    showHotspots,
    showNifcPerimeters,
  ]);
  useIntegrationSourceAttributions("overlay-wildfires", attributionSourceIds);
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

  return (
    <>
      <HotspotLayer active={layerVisible && showHotspots} popupController={popupController} />
      <EffisBurnedAreaLayer
        active={layerVisible && showEffisBurnedAreas}
        popupController={popupController}
      />
      <NifcPerimeterLayer
        active={layerVisible && showNifcPerimeters}
        popupController={popupController}
      />
    </>
  );
}
