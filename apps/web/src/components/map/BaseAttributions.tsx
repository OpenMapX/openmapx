"use client";

import { useLayerStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useMemo } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useMapAttributions } from "@/lib/useMapAttributions";

/**
 * Always-on credits for whichever base style is active. Registered via
 * `useMapAttributions` so each entry lives as its own atomic side-channel
 * source — MapLibre's substring dedup then collapses identical credits
 * (e.g. OSM appearing in both an OpenMapTiles basemap and a satellite
 * raster overlay) without us having to track who-shows-what.
 *
 * Publisher names ("OpenStreetMap contributors", "OpenMapTiles", "MapTiler")
 * are proper nouns and rendered verbatim across locales — the providers'
 * own brand guidelines treat them as untranslated identifiers, and the
 * destination license pages handle locale negotiation themselves. The
 * leading "©" is universal. Don't pipe these strings through `next-intl`.
 *
 * Renders no UI; the hook is the entire side-effect.
 */
const OSM_ATTRIBUTION: Attribution = {
  sourceId: "openstreetmap",
  name: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  spdxLicense: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/",
};

const OPENMAPTILES_ATTRIBUTION: Attribution = {
  sourceId: "openmaptiles",
  name: "© OpenMapTiles",
  url: "https://openmaptiles.org/",
  spdxLicense: "BSD-3-Clause",
  licenseUrl: "https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md",
};

const MAPTILER_ATTRIBUTION: Attribution = {
  sourceId: "maptiler",
  name: "© MapTiler",
  url: "https://www.maptiler.com/copyright/",
};

export function BaseAttributions() {
  const env = useEnv();
  const activeLayer = useLayerStore((s) => s.activeLayer);
  // When a raster overlay (satellite, terrain, cycling) is the active base,
  // it registers its own attributions via `RasterBaseLayer` and visually
  // replaces the vector basemap. Drop the vector-style credits in that case
  // and let the raster layer own its credits entirely — the strip shouldn't
  // continue advertising the vector basemap for imagery the user can't see,
  // and unrelated bases shouldn't share an unconditional OSM credit (a
  // future non-OSM raster would otherwise be misattributed to OSM).
  const showVectorBase = activeLayer === "default";
  const attributions = useMemo<Attribution[]>(() => {
    if (!showVectorBase) return [];
    return env.styleProvider === "openmapx"
      ? [OSM_ATTRIBUTION, OPENMAPTILES_ATTRIBUTION]
      : [OSM_ATTRIBUTION, MAPTILER_ATTRIBUTION];
  }, [env.styleProvider, showVectorBase]);
  useMapAttributions("base", attributions);
  return null;
}
