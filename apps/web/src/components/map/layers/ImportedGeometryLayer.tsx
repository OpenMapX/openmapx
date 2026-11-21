"use client";

import type { ImportedGeometry } from "@openmapx/core";
import { geoJsonBBox, useImportedGeometryStore } from "@openmapx/core";
import { useEffect, useMemo, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";

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
  const { mapReady, fitBounds } = useMap();
  const imported = useImportedGeometryStore((s) => s.imported);
  // The import this layer has already framed the camera to, so a style reload
  // never yanks the camera back and discards the user's pan.
  const fittedRef = useRef<ImportedGeometry | null>(null);

  useRenderedMapAttributions("imported-geometry", [FILL, LINE, POINT], Boolean(imported));

  const group = useMemo<MapLayerGroup | null>(
    () =>
      imported
        ? {
            sources: { [SOURCE]: { type: "geojson", data: imported.geojson } },
            layers: [
              {
                id: FILL,
                type: "fill",
                source: SOURCE,
                filter: ["==", "$type", "Polygon"],
                paint: { "fill-color": COLOR, "fill-opacity": 0.12 },
                slot: "area-overlays",
                order: 11,
              },
              {
                id: LINE,
                type: "line",
                source: SOURCE,
                filter: ["in", "$type", "LineString", "Polygon"],
                layout: { "line-join": "round", "line-cap": "round" },
                paint: { "line-color": COLOR, "line-width": 3, "line-opacity": 0.9 },
                slot: "overlay-lines",
                order: 15,
              },
              {
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
                slot: "overlay-points",
                order: 16,
              },
            ],
          }
        : null,
    [imported],
  );
  useMapLayerGroup(group);

  // Frame each imported file once.
  useEffect(() => {
    if (!mapReady || !imported) {
      if (!imported) fittedRef.current = null;
      return;
    }
    if (fittedRef.current === imported) return;
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
  }, [imported, mapReady, fitBounds]);

  return null;
}
