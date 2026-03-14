"use client";

import { MODE_COLORS, useDirectionsStore } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE } from "@/lib/theme";

const SOURCE_ID = "transit-itinerary-source";
const WALK_LAYER_ID = "transit-itinerary-walk";
const TRANSIT_LAYER_ID = "transit-itinerary-transit";
const POINTS_SOURCE_ID = "transit-itinerary-points-source";
const POINTS_LAYER_ID = "transit-itinerary-points";

export function TransitItineraryLayer() {
  const { mapRef, mapReady, fitBounds } = useMap();
  const { mode, transitItineraries, activeItineraryIndex } = useDirectionsStore();

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const cleanup = () => {
      if (map.getLayer(POINTS_LAYER_ID)) map.removeLayer(POINTS_LAYER_ID);
      if (map.getLayer(TRANSIT_LAYER_ID)) map.removeLayer(TRANSIT_LAYER_ID);
      if (map.getLayer(WALK_LAYER_ID)) map.removeLayer(WALK_LAYER_ID);
      if (map.getSource(POINTS_SOURCE_ID)) map.removeSource(POINTS_SOURCE_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };

    const isTransit = mode === "transit";
    const itinerary = isTransit ? transitItineraries[activeItineraryIndex] : null;

    if (!isTransit || !itinerary || itinerary.legs.length === 0) {
      cleanup();
      return;
    }

    cleanup();

    // Build line features for each leg
    const lineFeatures = itinerary.legs.map((leg, i) => {
      const isWalk = leg.mode === "walking";
      const color = isWalk
        ? "#757575"
        : leg.route?.color
          ? `#${leg.route.color.replace("#", "")}`
          : (MODE_COLORS[leg.mode] ?? PRIMARY_BLUE);

      return {
        type: "Feature" as const,
        properties: { isWalk, color, index: i },
        geometry: leg.geometry,
      };
    });

    // Build transfer point features
    const pointFeatures: Array<{
      type: "Feature";
      properties: { name: string };
      geometry: { type: "Point"; coordinates: [number, number] };
    }> = [];

    for (const leg of itinerary.legs) {
      pointFeatures.push({
        type: "Feature",
        properties: { name: leg.from.name },
        geometry: { type: "Point", coordinates: [leg.from.lng, leg.from.lat] },
      });
    }
    // Add final destination
    const lastLeg = itinerary.legs[itinerary.legs.length - 1];
    pointFeatures.push({
      type: "Feature",
      properties: { name: lastLeg.to.name },
      geometry: { type: "Point", coordinates: [lastLeg.to.lng, lastLeg.to.lat] },
    });

    map.addSource(SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: lineFeatures },
    });

    // Walk legs — dashed gray
    map.addLayer({
      id: WALK_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      filter: ["==", ["get", "isWalk"], true],
      paint: {
        "line-color": "#757575",
        "line-width": 4,
        "line-dasharray": [2, 2],
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    // Transit legs — solid colored
    map.addLayer({
      id: TRANSIT_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      filter: ["==", ["get", "isWalk"], false],
      paint: {
        "line-color": ["get", "color"],
        "line-width": 5,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    // Transfer points
    map.addSource(POINTS_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: pointFeatures },
    });

    map.addLayer({
      id: POINTS_LAYER_ID,
      type: "circle",
      source: POINTS_SOURCE_ID,
      paint: {
        "circle-radius": 6,
        "circle-color": "#fff",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#333",
      },
    });

    // Fit bounds to itinerary
    const allCoords: [number, number][] = [];
    for (const leg of itinerary.legs) {
      for (const coord of leg.geometry.coordinates) {
        allCoords.push(coord);
      }
    }
    if (allCoords.length >= 2) {
      const lngs = allCoords.map((c) => c[0]);
      const lats = allCoords.map((c) => c[1]);
      fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        80,
      );
    }

    return cleanup;
  }, [mapRef, mapReady, mode, transitItineraries, activeItineraryIndex, fitBounds]);

  return null;
}
