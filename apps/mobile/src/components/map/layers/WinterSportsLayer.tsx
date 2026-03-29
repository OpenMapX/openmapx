import { GeoJSONSource, Layer, RasterSource } from "@maplibre/maplibre-react-native";
import { useMapStore, useWinterSportsStore } from "@openmapx/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";

const RASTER_SOURCE_ID = "openmapx-opensnowmap-source";
const RASTER_LAYER_ID = "openmapx-opensnowmap-layer";
const VECTOR_SOURCE_ID = "openmapx-winter-sports-vector";
const AREA_LAYER_ID = "openmapx-winter-areas";
const PISTE_LAYER_ID = "openmapx-winter-pistes";
const LIFT_LAYER_ID = "openmapx-winter-lifts";
const VECTOR_MIN_ZOOM = 10;

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function WinterSportsLayer() {
  const { mapRef, mapReady } = useMap();
  const layerVisible = useWinterSportsStore((s) => s.layerVisible);
  const setLoading = useWinterSportsStore((s) => s.setLoading);
  const viewportKey = useMapStore(
    (s) => `${s.center[0].toFixed(3)},${s.center[1].toFixed(3)},${s.zoom.toFixed(1)}`,
  );
  const [geojson, setGeojson] = useState<GeoJSON.FeatureCollection>(EMPTY_GEOJSON);
  const fetchedRef = useRef(false);

  const fetchFeatures = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const zoom = await map.getZoom();
    if (zoom < VECTOR_MIN_ZOOM) return;

    const bounds = await map.getBounds();
    if (!bounds) return;
    const [west, south, east, north] = bounds;

    const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "";
    const url = `${apiUrl}/api/winter-sports/features?south=${south}&west=${west}&north=${north}&east=${east}`;

    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      const features: GeoJSON.Feature[] = [];

      for (const piste of data.pistes ?? []) {
        features.push({
          type: "Feature",
          geometry: piste.geometry,
          properties: {
            featureKind: "piste",
            name: piste.name,
            difficulty: piste.difficulty,
          },
        });
      }

      for (const lift of data.lifts ?? []) {
        features.push({
          type: "Feature",
          geometry: lift.geometry,
          properties: {
            featureKind: "lift",
            name: lift.name,
            aerialway: lift.aerialway,
          },
        });
      }

      for (const area of data.areas ?? []) {
        features.push({
          type: "Feature",
          geometry: area.geometry,
          properties: {
            featureKind: "area",
            name: area.name,
          },
        });
      }

      setGeojson({ type: "FeatureCollection", features });
    } catch {
      // Silent failure
    } finally {
      setLoading(false);
    }
  }, [mapRef, setLoading]);

  useEffect(() => {
    void viewportKey;
    if (!mapReady || !layerVisible) {
      fetchedRef.current = false;
      setGeojson(EMPTY_GEOJSON);
      return;
    }
    fetchedRef.current = true;
    fetchFeatures();
  }, [mapReady, layerVisible, fetchFeatures, viewportKey]);

  if (!layerVisible) return null;

  return (
    <>
      <RasterSource
        id={RASTER_SOURCE_ID}
        tiles={["https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png"]}
        tileSize={256}
        maxzoom={16}
      >
        <Layer
          type="raster"
          id={RASTER_LAYER_ID}
          paint={{
            "raster-opacity": 0.9,
            "raster-fade-duration": 200,
          }}
        />
      </RasterSource>

      <GeoJSONSource id={VECTOR_SOURCE_ID} data={geojson}>
        <Layer
          type="fill"
          id={AREA_LAYER_ID}
          minzoom={VECTOR_MIN_ZOOM}
          filter={["==", ["get", "featureKind"], "area"]}
          paint={{
            "fill-color": "rgba(200,220,255,0.15)",
            "fill-outline-color": "rgba(100,130,200,0.4)",
          }}
        />
        <Layer
          type="line"
          id={PISTE_LAYER_ID}
          minzoom={VECTOR_MIN_ZOOM}
          filter={["==", ["get", "featureKind"], "piste"]}
          layout={{ "line-cap": "round", "line-join": "round" }}
          paint={{
            "line-color": [
              "match",
              ["get", "difficulty"],
              "novice",
              "#4CAF50",
              "easy",
              "#2196F3",
              "intermediate",
              "#F44336",
              "advanced",
              "#212121",
              "expert",
              "#FF9800",
              "freeride",
              "#FFEB3B",
              "extreme",
              "#B71C1C",
              "#888",
            ],
            "line-width": ["interpolate", ["linear"], ["zoom"], VECTOR_MIN_ZOOM, 2, 16, 4],
            "line-opacity": 0.85,
          }}
        />
        <Layer
          type="line"
          id={LIFT_LAYER_ID}
          minzoom={VECTOR_MIN_ZOOM}
          filter={["==", ["get", "featureKind"], "lift"]}
          layout={{ "line-cap": "round", "line-join": "round" }}
          paint={{
            "line-color": "#333333",
            "line-width": ["interpolate", ["linear"], ["zoom"], VECTOR_MIN_ZOOM, 1.5, 16, 3],
            "line-dasharray": [4, 2],
            "line-opacity": 0.9,
          }}
        />
      </GeoJSONSource>
    </>
  );
}
