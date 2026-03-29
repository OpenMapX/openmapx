import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { MODE_COLORS, usePlaceStore, useRouteStops, useTransitRoute } from "@openmapx/core";
import { useEffect, useMemo } from "react";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "transit-route-detail-source";
const STOPS_SOURCE_ID = "transit-route-detail-stops-source";
const PRIMARY_BLUE_HEX = "#4285F4";

export function TransitRouteLayer() {
  const { fitBounds } = useMap();
  const { selectedPlace, activeRouteId } = usePlaceStore();
  const { data: route } = useTransitRoute(activeRouteId);
  const { data: stops } = useRouteStops(activeRouteId);

  const lineColor = route?.color
    ? `#${route.color.replace("#", "")}`
    : route?.mode
      ? MODE_COLORS[route.mode]
      : PRIMARY_BLUE_HEX;

  // Fit bounds when stops change
  useEffect(() => {
    if (!activeRouteId || !stops?.length) return;

    const routeGeometry = route?.geometry;
    const lineCoords: [number, number][] = routeGeometry
      ? routeGeometry.type === "MultiLineString"
        ? (routeGeometry.coordinates as [number, number][][]).flat()
        : (routeGeometry.coordinates as [number, number][])
      : stops.map((s): [number, number] => [s.lng, s.lat]);

    if (lineCoords.length >= 2) {
      const lngs = lineCoords.map((c) => c[0]);
      const lats = lineCoords.map((c) => c[1]);
      fitBounds([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)], 60);
    }
  }, [activeRouteId, route, stops, fitBounds]);

  const lineGeoJson = useMemo(() => {
    if (!stops?.length) {
      return { type: "FeatureCollection" as const, features: [] };
    }

    const routeGeometry = route?.geometry;
    const geometry = routeGeometry
      ? routeGeometry.type === "MultiLineString"
        ? {
            type: "MultiLineString" as const,
            coordinates: routeGeometry.coordinates as [number, number][][],
          }
        : {
            type: "LineString" as const,
            coordinates: routeGeometry.coordinates as [number, number][],
          }
      : {
          type: "LineString" as const,
          coordinates: stops.map((s): [number, number] => [s.lng, s.lat]),
        };

    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: {},
          geometry,
        },
      ],
    };
  }, [route, stops]);

  const stopsGeoJson = useMemo(() => {
    if (!stops?.length) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    return {
      type: "FeatureCollection" as const,
      features: stops.map((s) => ({
        type: "Feature" as const,
        properties: {
          id: s.id,
          name: s.name,
          isCurrent: s.id === selectedPlace?.id ? 1 : 0,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [s.lng, s.lat],
        },
      })),
    };
  }, [stops, selectedPlace?.id]);

  if (!activeRouteId || !stops?.length) return null;

  return (
    <>
      <GeoJSONSource id={SOURCE_ID} data={lineGeoJson}>
        <Layer
          type="line"
          id="transit-route-detail-line"
          source={SOURCE_ID}
          paint={{
            "line-color": lineColor,
            "line-width": 4,
            "line-opacity": 0.8,
          }}
          layout={{ "line-cap": "round", "line-join": "round" }}
        />
      </GeoJSONSource>
      <GeoJSONSource id={STOPS_SOURCE_ID} data={stopsGeoJson}>
        <Layer
          type="circle"
          id="transit-route-detail-stops"
          source={STOPS_SOURCE_ID}
          filter={["!=", ["get", "isCurrent"], 1]}
          paint={{
            "circle-radius": 5,
            "circle-color": "#fff",
            "circle-stroke-width": 2.5,
            "circle-stroke-color": lineColor,
          }}
        />
        <Layer
          type="circle"
          id="transit-route-detail-current-stop"
          source={STOPS_SOURCE_ID}
          filter={["==", ["get", "isCurrent"], 1]}
          paint={{
            "circle-radius": 8,
            "circle-color": lineColor,
            "circle-stroke-width": 3,
            "circle-stroke-color": "#fff",
          }}
        />
      </GeoJSONSource>
    </>
  );
}
