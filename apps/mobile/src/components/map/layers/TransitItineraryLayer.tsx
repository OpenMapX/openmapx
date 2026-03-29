import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { MODE_COLORS, useDirectionsStore } from "@openmapx/core";
import { useEffect, useMemo } from "react";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "transit-itinerary-source";
const POINTS_SOURCE_ID = "transit-itinerary-points-source";
const PRIMARY_BLUE_HEX = "#4285F4";

export function TransitItineraryLayer() {
  const { fitBounds } = useMap();
  const { mode, transitItineraries, activeItineraryIndex } = useDirectionsStore();

  const isTransit = mode === "transit";
  const itinerary = isTransit ? transitItineraries[activeItineraryIndex] : null;

  // Fit bounds to itinerary
  useEffect(() => {
    if (!itinerary || itinerary.legs.length === 0) return;

    const allCoords: [number, number][] = [];
    for (const leg of itinerary.legs) {
      for (const coord of leg.geometry.coordinates) {
        allCoords.push(coord);
      }
    }
    if (allCoords.length >= 2) {
      const lngs = allCoords.map((c) => c[0]);
      const lats = allCoords.map((c) => c[1]);
      fitBounds([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)], 80);
    }
  }, [itinerary, fitBounds]);

  const lineGeoJson = useMemo(() => {
    if (!itinerary || itinerary.legs.length === 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }

    const features = itinerary.legs.map((leg, i) => {
      const isWalk = leg.mode === "walking";
      const color = isWalk
        ? "#757575"
        : leg.route?.color
          ? `#${leg.route.color.replace("#", "")}`
          : (MODE_COLORS[leg.mode] ?? PRIMARY_BLUE_HEX);

      return {
        type: "Feature" as const,
        properties: { isWalk: isWalk ? 1 : 0, color, index: i },
        geometry: leg.geometry,
      };
    });

    return { type: "FeatureCollection" as const, features };
  }, [itinerary]);

  const pointsGeoJson = useMemo(() => {
    if (!itinerary || itinerary.legs.length === 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }

    const features: Array<{
      type: "Feature";
      properties: { name: string };
      geometry: { type: "Point"; coordinates: [number, number] };
    }> = [];

    for (const leg of itinerary.legs) {
      features.push({
        type: "Feature",
        properties: { name: leg.from.name },
        geometry: {
          type: "Point",
          coordinates: [leg.from.lng, leg.from.lat],
        },
      });
    }
    const lastLeg = itinerary.legs[itinerary.legs.length - 1];
    features.push({
      type: "Feature",
      properties: { name: lastLeg.to.name },
      geometry: {
        type: "Point",
        coordinates: [lastLeg.to.lng, lastLeg.to.lat],
      },
    });

    return { type: "FeatureCollection" as const, features };
  }, [itinerary]);

  if (!isTransit || !itinerary || itinerary.legs.length === 0) return null;

  return (
    <>
      <GeoJSONSource id={SOURCE_ID} data={lineGeoJson}>
        {/* Walk legs: dashed gray */}
        <Layer
          type="line"
          id="transit-itinerary-walk"
          source={SOURCE_ID}
          filter={["==", ["get", "isWalk"], 1]}
          paint={{
            "line-color": "#757575",
            "line-width": 4,
            "line-dasharray": [2, 2],
          }}
          layout={{ "line-cap": "round", "line-join": "round" }}
        />
        {/* Transit legs: solid colored */}
        <Layer
          type="line"
          id="transit-itinerary-transit"
          source={SOURCE_ID}
          filter={["==", ["get", "isWalk"], 0]}
          paint={{
            "line-color": ["get", "color"],
            "line-width": 5,
          }}
          layout={{ "line-cap": "round", "line-join": "round" }}
        />
      </GeoJSONSource>
      <GeoJSONSource id={POINTS_SOURCE_ID} data={pointsGeoJson}>
        <Layer
          type="circle"
          id="transit-itinerary-points"
          source={POINTS_SOURCE_ID}
          paint={{
            "circle-radius": 6,
            "circle-color": "#fff",
            "circle-stroke-width": 2.5,
            "circle-stroke-color": "#333",
          }}
        />
      </GeoJSONSource>
    </>
  );
}
