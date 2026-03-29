import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { LngLat } from "@openmapx/core";
import { useDirections, useDirectionsStore } from "@openmapx/core";
import { useEffect, useMemo } from "react";
import { useMap } from "@/lib/MapContext";

const PRIMARY_BLUE = "#4285F4";
const ALT_BLUE = "#93C5FD";

export function RouteLayer() {
  const { fitBounds } = useMap();
  const { waypoints, mode, activeRouteIndex, avoidHighways, avoidTolls, avoidFerries, units } =
    useDirectionsStore();

  const routeWaypoints = useMemo(
    () =>
      waypoints.reduce<LngLat[]>((acc, wp) => {
        if (wp.coords) acc.push(wp.coords);
        return acc;
      }, []),
    [waypoints],
  );
  const allFilled = routeWaypoints.length === waypoints.length && waypoints.length >= 2;

  const { data } = useDirections({
    waypoints: mode === "transit" ? [] : allFilled ? routeWaypoints : [],
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
  });

  // Fit bounds when route changes
  useEffect(() => {
    if (mode === "transit" || !data || data.routes.length === 0) return;

    const activeGeom = data.routes[activeRouteIndex]?.geometry;
    if (!activeGeom || activeGeom.length < 2) return;

    let minLng = activeGeom[0][0];
    let maxLng = activeGeom[0][0];
    let minLat = activeGeom[0][1];
    let maxLat = activeGeom[0][1];
    for (const [lng, lat] of activeGeom) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    fitBounds([minLng, minLat, maxLng, maxLat], 80);
  }, [data, activeRouteIndex, mode, fitBounds]);

  // Build GeoJSON
  const geojson = useMemo(() => {
    if (mode === "transit" || !data || data.routes.length === 0) {
      return {
        type: "FeatureCollection" as const,
        features: [] as Array<{
          type: "Feature";
          properties: { type: string; routeIndex: number };
          geometry: { type: "LineString"; coordinates: LngLat[] };
        }>,
      };
    }

    const features = data.routes.map((route, i) => ({
      type: "Feature" as const,
      properties: {
        type: i === activeRouteIndex ? "active" : "alt",
        routeIndex: i,
      },
      geometry: {
        type: "LineString" as const,
        coordinates: route.geometry,
      },
    }));

    // Active route on top
    features.sort((a) => (a.properties.type === "active" ? 1 : -1));

    return {
      type: "FeatureCollection" as const,
      features,
    };
  }, [data, activeRouteIndex, mode]);

  if (geojson.features.length === 0) return null;

  return (
    <GeoJSONSource id="route-source" data={geojson}>
      {/* Alternative route casing */}
      <Layer
        type="line"
        id="route-alt-casing"
        source="route-source"
        filter={["==", ["get", "type"], "alt"]}
        layout={{ "line-join": "round", "line-cap": "round" }}
        paint={{
          "line-color": "#ffffff",
          "line-width": 7,
          "line-opacity": 0.6,
        }}
      />
      {/* Alternative route line */}
      <Layer
        type="line"
        id="route-alt-line"
        source="route-source"
        filter={["==", ["get", "type"], "alt"]}
        layout={{ "line-join": "round", "line-cap": "round" }}
        paint={{
          "line-color": ALT_BLUE,
          "line-width": 5,
          "line-opacity": 0.75,
        }}
      />
      {/* Active route casing */}
      <Layer
        type="line"
        id="route-active-casing"
        source="route-source"
        filter={["==", ["get", "type"], "active"]}
        layout={{ "line-join": "round", "line-cap": "round" }}
        paint={{
          "line-color": "#ffffff",
          "line-width": 10,
        }}
      />
      {/* Active route line */}
      <Layer
        type="line"
        id="route-active-line"
        source="route-source"
        filter={["==", ["get", "type"], "active"]}
        layout={{ "line-join": "round", "line-cap": "round" }}
        paint={{
          "line-color": PRIMARY_BLUE,
          "line-width": 7,
        }}
      />
    </GeoJSONSource>
  );
}
