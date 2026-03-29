import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { useWildfireStore } from "@openmapx/core";
import { useCallback, useEffect, useRef, useState } from "react";

const SOURCE_ID = "openmapx-wildfires-source";
const CIRCLE_LAYER_ID = "openmapx-wildfires-circles";

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function WildfireLayer() {
  const layerVisible = useWildfireStore((s) => s.layerVisible);
  const dayRange = useWildfireStore((s) => s.dayRange);
  const source = useWildfireStore((s) => s.source);
  const setLoading = useWildfireStore((s) => s.setLoading);
  const setLastUpdated = useWildfireStore((s) => s.setLastUpdated);
  const [geojson, setGeojson] = useState<GeoJSON.FeatureCollection>(EMPTY_GEOJSON);
  const fetchedRef = useRef(false);

  const fetchWildfires = useCallback(async () => {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "";
    const url = `${apiUrl}/api/wildfires?dayRange=${dayRange}&source=${source}`;

    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as GeoJSON.FeatureCollection;
      setGeojson(data);
      setLastUpdated(Date.now());
    } catch {
      // Silent fetch failure
    } finally {
      setLoading(false);
    }
  }, [dayRange, source, setLoading, setLastUpdated]);

  useEffect(() => {
    if (!layerVisible) {
      fetchedRef.current = false;
      setGeojson(EMPTY_GEOJSON);
      return;
    }
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchWildfires();
    }
  }, [layerVisible, fetchWildfires]);

  // Auto-refresh
  useEffect(() => {
    if (!layerVisible) return;
    const intervals: Record<number, number> = {
      1: 300_000,
      2: 600_000,
      3: 900_000,
    };
    const interval = setInterval(() => fetchWildfires(), intervals[dayRange] ?? 300_000);
    return () => clearInterval(interval);
  }, [layerVisible, dayRange, fetchWildfires]);

  if (!layerVisible) return null;

  return (
    <GeoJSONSource id={SOURCE_ID} data={geojson}>
      <Layer
        type="circle"
        id={CIRCLE_LAYER_ID}
        paint={{
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "frp"],
            0,
            3,
            10,
            5,
            50,
            8,
            200,
            13,
            500,
            18,
            1000,
            24,
          ],
          "circle-color": [
            "interpolate",
            ["linear"],
            ["get", "ageMs"],
            0,
            "#ef4444",
            3_600_000,
            "#f97316",
            21_600_000,
            "#fb923c",
            43_200_000,
            "#fbbf24",
            86_400_000,
            "#fcd34d",
            172_800_000,
            "#fde68a",
          ],
          "circle-opacity": 0.8,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 0.8,
        }}
      />
    </GeoJSONSource>
  );
}
