"use client";

import { useLayerStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useMemo } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { baseMapVectorCredits } from "@/lib/map";
import { useMapAttributions } from "@/lib/useMapAttributions";

/**
 * Always-on credits for whichever base style is active. Registered via
 * `useMapAttributions` so each entry lives as its own atomic side-channel
 * source — MapLibre's substring dedup then collapses identical credits
 * (e.g. OSM appearing in both an OpenMapTiles basemap and a satellite
 * raster overlay) without us having to track who-shows-what.
 *
 * The credit constants are defined once in `@/lib/map` and shared with
 * `baseMapCustomAttribution` (the offline / mini maps), so the metadata can't
 * drift between the two rendering paths.
 *
 * Renders no UI; the hook is the entire side-effect.
 */
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
  // OSM (data) + OpenMapTiles (our OSM-Bright-derived style: CC-BY design +
  // schema) always, plus MapTiler when their hosted tiles are used. Shared with
  // the offline/mini maps via baseMapVectorCredits so it can't drift.
  const attributions = useMemo<Attribution[]>(
    () => (showVectorBase ? baseMapVectorCredits(env) : []),
    [env, showVectorBase],
  );
  useMapAttributions("base", attributions);
  return null;
}
