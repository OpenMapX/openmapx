"use client";

import { greatCircleArc, useDirectionsStore, useFlightStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";
import type { MapLayerGroup, SlottedLayer } from "./mapLayerGroup";
import { useMapLayerGroup } from "./useMapLayerGroup";

const SOURCE_ID = "flight-arc-source";
const LAYER_LINE = "flight-arc-line";
const LAYER_POINTS = "flight-arc-points";
const LAYER_LABELS = "flight-arc-labels";

const EMPTY = { type: "FeatureCollection" as const, features: [] };

function withSlot(
  layer: maplibregl.AddLayerObject,
  slot: SlottedLayer["slot"],
  order: number,
): maplibregl.AddLayerObject & Pick<SlottedLayer, "slot" | "order"> {
  return { ...layer, slot, order };
}

/**
 * Draws the great-circle flight line + airport endpoints when the directions
 * panel is in flight ("flying") mode. Reads the two resolved airports from
 * `useFlightStore` (populated by `FlightPanel`).
 */
export function FlightArcLayer() {
  const { mapRef, fitBounds } = useMap();
  const mode = useDirectionsStore((s) => s.mode);
  const from = useFlightStore((s) => s.from);
  const to = useFlightStore((s) => s.to);

  const arcFeatures = useMemo(() => {
    if (mode !== "flying" || !from || !to) return EMPTY;

    const arc = greatCircleArc(from.coordinates, to.coordinates, 96);
    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: { kind: "line" },
          geometry: { type: "LineString" as const, coordinates: arc },
        },
        {
          type: "Feature" as const,
          properties: { kind: "point", label: from.iata },
          geometry: { type: "Point" as const, coordinates: from.coordinates },
        },
        {
          type: "Feature" as const,
          properties: { kind: "point", label: to.iata },
          geometry: { type: "Point" as const, coordinates: to.coordinates },
        },
      ],
    };
  }, [mode, from, to]);

  const group = useMemo<MapLayerGroup>(
    () => ({
      sources: { [SOURCE_ID]: { type: "geojson", data: arcFeatures } },
      layers: [
        withSlot(
          {
            id: LAYER_LINE,
            type: "line",
            source: SOURCE_ID,
            filter: ["==", ["get", "kind"], "line"],
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": PRIMARY_BLUE_HEX,
              "line-width": 3,
              "line-dasharray": [2, 1.5],
            },
          },
          "overlay-lines",
          19,
        ),
        withSlot(
          {
            id: LAYER_POINTS,
            type: "circle",
            source: SOURCE_ID,
            filter: ["==", ["get", "kind"], "point"],
            paint: {
              "circle-radius": 5,
              "circle-color": "#ffffff",
              "circle-stroke-color": PRIMARY_BLUE_HEX,
              "circle-stroke-width": 2.5,
            },
          },
          "overlay-points",
          22,
        ),
        withSlot(
          {
            id: LAYER_LABELS,
            type: "symbol",
            source: SOURCE_ID,
            filter: ["==", ["get", "kind"], "point"],
            layout: {
              "text-field": ["get", "label"],
              "text-size": 12,
              "text-offset": [0, -1.2],
              "text-anchor": "bottom",
              "text-allow-overlap": true,
            },
            paint: {
              "text-color": PRIMARY_BLUE_HEX,
              "text-halo-color": "#ffffff",
              "text-halo-width": 1.5,
            },
          },
          "overlay-markers",
          15,
        ),
      ] satisfies SlottedLayer[],
    }),
    [arcFeatures],
  );
  useMapLayerGroup(group);

  // Keep the camera effect's existing dependency contract independent of drawing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: preserve the camera effect's existing dependency contract
  useEffect(() => {
    if (mode !== "flying" || !from || !to) return;

    const arc = greatCircleArc(from.coordinates, to.coordinates, 96);
    let minLng = arc[0][0];
    let maxLng = arc[0][0];
    let minLat = arc[0][1];
    let maxLat = arc[0][1];
    for (const [lng, lat] of arc) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      80,
    );
  }, [mode, from, to, mapRef, fitBounds]);

  return null;
}
