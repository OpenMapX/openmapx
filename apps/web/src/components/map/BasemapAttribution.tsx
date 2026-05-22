"use client";

import { useLayerStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useMemo } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useRegisterMapAttribution } from "@/lib/mapAttributionStore";

const OSM_ATTRIBUTION: Attribution = {
  sourceId: "openstreetmap",
  name: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  spdxLicense: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/",
};

const MAPTILER_BASEMAP: Attribution[] = [
  {
    sourceId: "maptiler",
    name: "© MapTiler",
    url: "https://www.maptiler.com/copyright/",
    licenseUrl: "https://www.maptiler.com/copyright/",
  },
  OSM_ATTRIBUTION,
];

const OPENMAPX_BASEMAP: Attribution[] = [
  {
    sourceId: "openmaptiles",
    name: "© OpenMapTiles",
    url: "https://openmaptiles.org/",
    spdxLicense: "BSD-3-Clause",
    licenseUrl: "https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md",
  },
  OSM_ATTRIBUTION,
];

/**
 * Registers the basemap (vector tile style) attribution with the React-driven
 * attribution strip. The basemap is always present when no raster overlay
 * (satellite, terrain, cycling) has replaced it — those raster layers
 * register their own contributions via `RasterBaseLayer`.
 */
export function BasemapAttribution() {
  const env = useEnv();
  const activeLayer = useLayerStore((s) => s.activeLayer);
  // Basemap shows the standard vector style; raster overlays don't replace
  // attribution outright (they sit above and may keep showing OSM data
  // underneath) — but per existing behavior they're treated as a swap. Match
  // that: only register when the active layer is the default vector base.
  const showBasemap = activeLayer === "default";
  const attributions = useMemo<Attribution[]>(
    () => (env.styleProvider === "openmapx" ? OPENMAPX_BASEMAP : MAPTILER_BASEMAP),
    [env.styleProvider],
  );
  useRegisterMapAttribution("basemap", showBasemap ? attributions : []);
  return null;
}
