"use client";

import type { ImportedGeometry } from "@openmapx/core";
import { geoJsonBBox, useImportedGeometryStore } from "@openmapx/core";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";
import { removeLayerAndSource, upsertGeoJsonSource } from "./layerStyleUtils";

const SOURCE = "imported-geometry-source";
const FILL = "imported-geometry-fill";
const LINE = "imported-geometry-line";
const POINT = "imported-geometry-point";
// Purple — distinct from the route (blue) and admin-boundary (red) overlays.
const COLOR = "#7c3aed";

/**
 * Draws the user-imported GPX/GeoJSON/KML overlay: polygons (filled), lines, and
 * points, in a distinct purple. Fits the map to the import once per file.
 */
export function ImportedGeometryLayer() {
  const { mapRef, mapReady, styleVersion, fitBounds } = useMap();
  const imported = useImportedGeometryStore((s) => s.imported);
  // The import this layer has already framed the camera to. Keyed on the
  // imported object identity so a style/theme reload (which re-runs this effect
  // to re-add the layers) doesn't yank the camera back and discard the user's pan.
  const fittedRef = useRef<ImportedGeometry | null>(null);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (!imported) {
      removeLayerAndSource(map, [POINT, LINE, FILL], SOURCE);
      fittedRef.current = null;
      return;
    }

    const apply = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", apply);
        return;
      }
      upsertGeoJsonSource(map, SOURCE, imported.geojson);
      if (!map.getLayer(FILL)) {
        map.addLayer({
          id: FILL,
          type: "fill",
          source: SOURCE,
          filter: ["==", "$type", "Polygon"],
          paint: { "fill-color": COLOR, "fill-opacity": 0.12 },
        });
      }
      if (!map.getLayer(LINE)) {
        map.addLayer({
          id: LINE,
          type: "line",
          source: SOURCE,
          filter: ["in", "$type", "LineString", "Polygon"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": COLOR, "line-width": 3, "line-opacity": 0.9 },
        });
      }
      if (!map.getLayer(POINT)) {
        map.addLayer({
          id: POINT,
          type: "circle",
          source: SOURCE,
          filter: ["==", "$type", "Point"],
          paint: {
            "circle-radius": 5,
            "circle-color": COLOR,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          },
        });
      }
      // Fit only the first time we show this file — not on later style reloads.
      if (fittedRef.current !== imported) {
        fittedRef.current = imported;
        const box = geoJsonBBox(imported.geojson);
        if (box) {
          fitBounds(
            [
              [box[0], box[1]],
              [box[2], box[3]],
            ],
            60,
          );
        }
      }
    };

    // Re-add after a style/theme swap (which wipes all sources): `styledata`
    // re-fires on each style load and the in-apply `once("idle")` covers the
    // mid-load case, whereas `once("load")` fires only once — so the overlay
    // would silently disappear on a theme change.
    apply();
    map.on("styledata", apply);
    return () => {
      map.off("styledata", apply);
    };
  }, [imported, mapReady, styleVersion, mapRef, fitBounds]);

  return null;
}
