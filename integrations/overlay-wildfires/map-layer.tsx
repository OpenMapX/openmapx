"use client";

import { useOverlayExclusion } from "@openmapx/core";
import { useEffect, useMemo } from "react";
import { EffisBurnedAreaLayer } from "./layers/effis-burned-area-layer";
import { HotspotLayer } from "./layers/hotspot-layer";
import { NifcPerimeterLayer } from "./layers/nifc-perimeter-layer";
import { NoaaSmokeLayer } from "./layers/noaa-smoke-layer";
import { createWildfirePopupController } from "./popup-controller";
import { useWildfireStore } from "./store";

export function WildfireLayer() {
  const layerVisible = useWildfireStore((s) => s.layerVisible);
  const showHotspots = useWildfireStore((s) => s.showHotspots);
  const showNifcPerimeters = useWildfireStore((s) => s.showNifcPerimeters);
  const showEffisBurnedAreas = useWildfireStore((s) => s.showEffisBurnedAreas);
  const showNoaaSmoke = useWildfireStore((s) => s.showNoaaSmoke);
  useOverlayExclusion("wildfires", layerVisible);
  const popupController = useMemo(createWildfirePopupController, []);
  useEffect(() => () => popupController.closeAll(), [popupController]);

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
