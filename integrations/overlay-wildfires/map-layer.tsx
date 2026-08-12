"use client";

import { useOverlayExclusion } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useMemo, useRef } from "react";
import { useIntegrationSourceAttributions } from "@/lib/useIntegrationAttribution";
import { EffisBurnedAreaLayer } from "./layers/effis-burned-area-layer";
import {
  HotspotLayer,
  type WildfirePopupController,
  type WildfirePopupOwner,
} from "./layers/hotspot-layer";
import { NifcPerimeterLayer } from "./layers/nifc-perimeter-layer";
import { NoaaSmokeLayer } from "./layers/noaa-smoke-layer";
import { useWildfireStore } from "./store";

export function WildfireLayer() {
  const layerVisible = useWildfireStore((s) => s.layerVisible);
  const showHotspots = useWildfireStore((s) => s.showHotspots);
  const showNifcPerimeters = useWildfireStore((s) => s.showNifcPerimeters);
  const showEffisBurnedAreas = useWildfireStore((s) => s.showEffisBurnedAreas);
  const showNoaaSmoke = useWildfireStore((s) => s.showNoaaSmoke);
  const firmsStatus = useWildfireStore((s) => s.statuses.firms);
  const nifcStatus = useWildfireStore((s) => s.statuses.nifc);
  const effisStatus = useWildfireStore((s) => s.statuses.effis);
  const noaaStatus = useWildfireStore((s) => s.statuses["noaa-hms"]);
  const attributionSourceIds = useMemo(() => {
    if (!layerVisible) return [];
    const sourceIds: string[] = [];
    if (showHotspots && (firmsStatus.loading || firmsStatus.featureCount !== null)) {
      sourceIds.push("firms");
    }
    if (showNifcPerimeters && (nifcStatus.loading || nifcStatus.featureCount !== null)) {
      sourceIds.push("nifc-wfigs");
    }
    if (showEffisBurnedAreas && (effisStatus.loading || effisStatus.featureCount !== null)) {
      sourceIds.push("effis");
    }
    if (showNoaaSmoke && (noaaStatus.loading || noaaStatus.featureCount !== null)) {
      sourceIds.push("noaa-hms");
    }
    return sourceIds;
  }, [
    effisStatus.featureCount,
    effisStatus.loading,
    firmsStatus.featureCount,
    firmsStatus.loading,
    layerVisible,
    nifcStatus.featureCount,
    nifcStatus.loading,
    noaaStatus.featureCount,
    noaaStatus.loading,
    showEffisBurnedAreas,
    showHotspots,
    showNifcPerimeters,
    showNoaaSmoke,
  ]);
  useIntegrationSourceAttributions("overlay-wildfires", attributionSourceIds);
  useOverlayExclusion("wildfires", layerVisible);
  const popupRef = useRef<{ owner: WildfirePopupOwner; popup: maplibregl.Popup } | null>(null);
  const popupController = useMemo<WildfirePopupController>(
    () => ({
      open: (owner, popup) => {
        popupRef.current?.popup.remove();
        popupRef.current = { owner, popup };
      },
      close: (owner) => {
        if (popupRef.current?.owner !== owner) return;
        popupRef.current.popup.remove();
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
      <NoaaSmokeLayer active={layerVisible && showNoaaSmoke} popupController={popupController} />
    </>
  );
}
