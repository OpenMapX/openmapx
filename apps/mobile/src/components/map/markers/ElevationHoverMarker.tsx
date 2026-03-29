import { Marker } from "@maplibre/maplibre-react-native";
import type { ElevationPoint, LngLat } from "@openmapx/core";
import { useDirections, useDirectionsStore, useElevation } from "@openmapx/core";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useElevationHover } from "@/lib/ElevationHoverContext";

const TEAL = "#007b8b";

/**
 * Finds the interpolated LngLat along the route geometry at a given distance.
 */
function lngLatAtDistance(
  geometry: LngLat[],
  points: ElevationPoint[],
  targetDistance: number,
): LngLat | null {
  if (geometry.length < 2 || points.length < 2) return null;

  // Find the two points bracketing the target distance
  for (let i = 1; i < points.length; i++) {
    if (points[i].distance >= targetDistance) {
      const prev = points[i - 1];
      const curr = points[i];
      const segLen = curr.distance - prev.distance;
      if (segLen <= 0) return [prev.lngLat[0], prev.lngLat[1]];
      const frac = (targetDistance - prev.distance) / segLen;
      return [
        prev.lngLat[0] + (curr.lngLat[0] - prev.lngLat[0]) * frac,
        prev.lngLat[1] + (curr.lngLat[1] - prev.lngLat[1]) * frac,
      ];
    }
  }

  const last = points[points.length - 1];
  return last.lngLat;
}

export function ElevationHoverMarker() {
  const { distance } = useElevationHover();
  const { waypoints, mode, avoidHighways, avoidTolls, avoidFerries, units } = useDirectionsStore();

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

  const route = data?.routes[useDirectionsStore.getState().activeRouteIndex];
  const { data: profile } = useElevation({ route: route ?? null, enabled: !!route });

  const lngLat = useMemo(() => {
    if (distance === null || !route || !profile) return null;
    return lngLatAtDistance(route.geometry, profile.points, distance);
  }, [distance, route, profile]);

  if (!lngLat) return null;

  return (
    <Marker id="elevation-hover-marker" lngLat={lngLat} anchor="center">
      <View style={styles.dot} />
    </Marker>
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: TEAL,
    borderWidth: 2,
    borderColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
});
