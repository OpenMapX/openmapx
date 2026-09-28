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
import { contourDemTileUrl, generatedContourUrl } from "./generatedContours";
import { syncTerrainStyle, type TerrainRelief } from "./terrainStyle";

/**
 * Elevation on the vector basemap: soft mountain shading on the default street
 * map, and the full relief with contours and 3D terrain on the Terrain base.
 * Raster bases cover the vector land cover, so they get none.
 */
export function TerrainBaseLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const activeLayer = useLayerStore((state) => state.activeLayer);
  const offlinePackageActive = useOfflinePackageActive();
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === "system" ? systemMode : mode) === "dark";
  const relief: TerrainRelief = offlinePackageActive
    ? "off"
    : activeLayer === "terrain"
      ? "full"
      : activeLayer === "default"
        ? "subtle"
        : "off";
  const enabled = relief !== "off";

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
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const subscribe = (contourUrl?: string) => {
      if (disposed) return;
      unsubscribe = subscribeStyleLoaded(map, () =>
        syncTerrainStyle(map, relief, {
          demUrl: env.terrainDemTilejsonUrl,
          contoursUrl: contourUrl === "" ? "" : env.terrainContourTilejsonUrl,
          demEncoding: env.terrainDemEncoding,
          generatedContourUrl: contourUrl,
          dark,
        }),
      );
    };
    if (relief === "full" && env.terrainContourMode === "generated") {
      void contourDemTileUrl(env.terrainDemTileUrlTemplate, env.terrainDemTilejsonUrl)
        .then((tileUrl) => generatedContourUrl(tileUrl, env.terrainDemEncoding))
        .then(subscribe)
        .catch(() => {
          // A failed optional contour worker must not suppress hillshade/3D.
          subscribe("");
        });
    } else {
      subscribe();
    }
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [
    mapRef,
    mapReady,
    styleVersion,
    relief,
    env.terrainDemTilejsonUrl,
    env.terrainDemTileUrlTemplate,
    env.terrainDemEncoding,
    env.terrainContourMode,
    env.terrainContourTilejsonUrl,
    dark,
  ]);

  return null;
}
