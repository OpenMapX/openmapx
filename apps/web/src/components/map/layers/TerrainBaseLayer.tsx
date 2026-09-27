"use client";

import { useColorScheme } from "@mui/material/styles";
import { useLayerStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useEffect, useMemo } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useMapAttributions } from "@/integration-api/overlay/useMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useOfflinePackageActive } from "@/lib/offlineAreas";
import { syncTerrainStyle } from "./terrainStyle";

export function TerrainBaseLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const activeLayer = useLayerStore((state) => state.activeLayer);
  const offlinePackageActive = useOfflinePackageActive();
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === "system" ? systemMode : mode) === "dark";
  const enabled = activeLayer === "terrain" && !offlinePackageActive;

  const attributions = useMemo<Attribution[]>(
    () =>
      enabled
        ? [
            {
              sourceId: "terrain-elevation",
              name: env.terrainAttributionName,
              url: env.terrainAttributionUrl,
            },
          ]
        : [],
    [enabled, env.terrainAttributionName, env.terrainAttributionUrl],
  );
  useMapAttributions("terrain-elevation", attributions);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    return subscribeStyleLoaded(map, () =>
      syncTerrainStyle(map, enabled, {
        demUrl: env.terrainDemTilejsonUrl,
        contoursUrl: env.terrainContourTilejsonUrl,
        dark,
      }),
    );
  }, [
    mapRef,
    mapReady,
    styleVersion,
    enabled,
    env.terrainDemTilejsonUrl,
    env.terrainContourTilejsonUrl,
    dark,
  ]);

  return null;
}
