"use client";

import { useOverlayExclusion } from "@openmapx/core";
import { useEffect, useMemo } from "react";
import { useSourceAttributions } from "@/integration-api/overlay/useIntegrationAttribution";
import { EffisBurnedAreaLayer } from "./layers/effis-burned-area-layer";
import { HotspotLayer } from "./layers/hotspot-layer";
import { NifcPerimeterLayer } from "./layers/nifc-perimeter-layer";
import { NoaaSmokeLayer } from "./layers/noaa-smoke-layer";
import { createWildfirePopupController } from "./popup-controller";
import { useWildfireStore } from "./store";

const NO_SOURCES: readonly string[] = [];

export function WildfireLayer() {
  const layerVisible = useWildfireStore((s) => s.layerVisible);
  const showHotspots = useWildfireStore((s) => s.showHotspots);
  const showNifcPerimeters = useWildfireStore((s) => s.showNifcPerimeters);
  const showEffisBurnedAreas = useWildfireStore((s) => s.showEffisBurnedAreas);
  const showNoaaSmoke = useWildfireStore((s) => s.showNoaaSmoke);
  // The credits name exactly the sources behind what the shown layers last drew. Joined into a
  // string so that a status change that keeps the same sources does not re-register them.
  const sourceKey = useWildfireStore((s) => {
    if (!s.layerVisible) return "";
    const ids = new Set<string>();
    const shown = [
      [s.showHotspots, s.statuses.firms],
      [s.showNifcPerimeters, s.statuses.nifc],
      [s.showEffisBurnedAreas, s.statuses.effis],
      [s.showNoaaSmoke, s.statuses["noaa-hms"]],
    ] as const;
    for (const [visible, status] of shown) {
      if (visible) for (const id of status.sources) ids.add(id);
    }
    return [...ids].sort().join(",");
  });
  const sourceIds = useMemo(() => (sourceKey ? sourceKey.split(",") : NO_SOURCES), [sourceKey]);
  useSourceAttributions("wildfires", sourceIds);
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
