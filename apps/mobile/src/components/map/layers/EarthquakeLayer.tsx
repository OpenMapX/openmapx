import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { useEarthquakeStore } from "@openmapx/core";
import { useCallback, useEffect, useRef, useState } from "react";

const SOURCE_ID = "openmapx-earthquakes-source";
const CIRCLE_LAYER_ID = "openmapx-earthquakes-circles";

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function EarthquakeLayer() {
  const layerVisible = useEarthquakeStore((s) => s.layerVisible);
  const timeRange = useEarthquakeStore((s) => s.timeRange);
  const minMagnitude = useEarthquakeStore((s) => s.minMagnitude);
  const colorMode = useEarthquakeStore((s) => s.colorMode);
  const setLoading = useEarthquakeStore((s) => s.setLoading);
  const setLastUpdated = useEarthquakeStore((s) => s.setLastUpdated);
  const [geojson, setGeojson] = useState<GeoJSON.FeatureCollection>(EMPTY_GEOJSON);
  const fetchedRef = useRef(false);

  const fetchEarthquakes = useCallback(async () => {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "";
    const url = `${apiUrl}/api/earthquakes?timeRange=${timeRange}&minMagnitude=${minMagnitude}`;

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
  }, [timeRange, minMagnitude, setLoading, setLastUpdated]);

  useEffect(() => {
    if (!layerVisible) {
      fetchedRef.current = false;
      setGeojson(EMPTY_GEOJSON);
      return;
    }
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchEarthquakes();
    }
  }, [layerVisible, fetchEarthquakes]);

  // Auto-refresh
  useEffect(() => {
    if (!layerVisible) return;
    const intervals: Record<string, number> = {
      hour: 60_000,
      day: 120_000,
      week: 300_000,
      month: 600_000,
    };
    const interval = setInterval(() => fetchEarthquakes(), intervals[timeRange] ?? 300_000);
    return () => clearInterval(interval);
  }, [layerVisible, timeRange, fetchEarthquakes]);

  if (!layerVisible) return null;

  const depthColor = colorMode === "depth";

  return (
    <GeoJSONSource id={SOURCE_ID} data={geojson}>
      <Layer
        type="circle"
        id={CIRCLE_LAYER_ID}
        paint={{
          "circle-radius": [
            "interpolate",
            ["exponential", 2],
            ["get", "mag"],
            0,
            2,
            2,
            3,
            3,
            5,
            4,
            8,
            5,
            13,
            6,
            20,
            7,
            30,
            8,
            42,
          ],
          "circle-color": depthColor
            ? [
                "interpolate",
                ["linear"],
                ["get", "depth"],
                0,
                "#ff4500",
                33,
                "#ff8c00",
                70,
                "#ffd700",
                150,
                "#32cd32",
                300,
                "#1e90ff",
                500,
                "#8b00ff",
              ]
            : [
                "interpolate",
                ["linear"],
                ["get", "ageMs"],
                0,
                "#ef4444",
                3_600_000,
                "#f97316",
                86_400_000,
                "#eab308",
                604_800_000,
                "#94a3b8",
              ],
          "circle-opacity": 0.85,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        }}
      />
    </GeoJSONSource>
  );
}
