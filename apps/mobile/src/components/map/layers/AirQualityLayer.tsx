import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { useAirQualityStore, useMapStore } from "@openmapx/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";

const AQ_SOURCE_ID = "openaq-air-quality";
const AQ_LAYER_ID = "air-quality-layer";

interface AQStation {
  id: number;
  name: string;
  lat: number;
  lng: number;
  aqi: number;
  pm25: number;
  lastUpdated: string;
  attribution: { name: string; url: string } | null;
  license: string | null;
}

function buildGeoJson(stations: AQStation[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: stations.map((s) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
      properties: {
        id: s.id,
        name: s.name,
        aqi: s.aqi,
        pm25: s.pm25,
      },
    })),
  };
}

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function AirQualityLayer() {
  const { mapRef, mapReady } = useMap();
  const layerVisible = useAirQualityStore((s) => s.layerVisible);
  const setLoading = useAirQualityStore((s) => s.setLoading);
  const viewportKey = useMapStore(
    (s) => `${s.center[0].toFixed(3)},${s.center[1].toFixed(3)},${s.zoom.toFixed(1)}`,
  );
  const [geojson, setGeojson] = useState<GeoJSON.FeatureCollection>(EMPTY_GEOJSON);
  const fetchedRef = useRef(false);

  const fetchStations = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const bounds = await map.getBounds();
    if (!bounds) return;
    const [west, south, east, north] = bounds;

    const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "";
    const url = `${apiUrl}/api/air-quality/stations?south=${south}&west=${west}&north=${north}&east=${east}`;

    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const stations = (await res.json()) as AQStation[];
      setGeojson(buildGeoJson(stations));
    } catch {
      // Silent fetch failure
    } finally {
      setLoading(false);
    }
  }, [mapRef, setLoading]);

  // Refetch on region change (viewportKey changes when center/zoom changes)
  useEffect(() => {
    // viewportKey is intentionally consumed to trigger refetch on viewport change
    void viewportKey;
    if (!mapReady || !layerVisible) {
      fetchedRef.current = false;
      setGeojson(EMPTY_GEOJSON);
      return;
    }
    fetchedRef.current = true;
    fetchStations();
  }, [mapReady, layerVisible, fetchStations, viewportKey]);

  if (!layerVisible) return null;

  return (
    <GeoJSONSource id={AQ_SOURCE_ID} data={geojson}>
      <Layer
        type="circle"
        id={AQ_LAYER_ID}
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 4, 8, 8, 12, 14],
          "circle-color": [
            "step",
            ["get", "aqi"],
            "#009966",
            51,
            "#ffde33",
            101,
            "#ff9933",
            151,
            "#cc0033",
            201,
            "#660099",
            301,
            "#7e0023",
          ],
          "circle-opacity": 0.75,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
          "circle-stroke-opacity": 0.5,
        }}
      />
    </GeoJSONSource>
  );
}
