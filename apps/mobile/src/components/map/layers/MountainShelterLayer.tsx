import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { useHikingStore, useMapStore } from "@openmapx/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "openmapx-shelters-source";
const CIRCLE_LAYER_ID = "openmapx-shelters-circles";
const LABEL_LAYER_ID = "openmapx-shelters-labels";
const MIN_ZOOM = 10;

const SHELTER_COLORS: Record<string, string> = {
  refuge: "#D84315",
  cabane: "#795548",
  gite: "#5D4037",
  pt_eau: "#0288D1",
  pt_passage: "#546E7A",
};

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function MountainShelterLayer() {
  const { mapRef, mapReady } = useMap();
  const layerVisible = useHikingStore((s) => s.layerVisible);
  const viewportKey = useMapStore(
    (s) => `${s.center[0].toFixed(3)},${s.center[1].toFixed(3)},${s.zoom.toFixed(1)}`,
  );
  const [geojson, setGeojson] = useState<GeoJSON.FeatureCollection>(EMPTY_GEOJSON);
  const fetchedRef = useRef(false);

  const fetchShelters = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const zoom = await map.getZoom();
    if (zoom < MIN_ZOOM) return;

    const bounds = await map.getBounds();
    if (!bounds) return;
    const [west, south, east, north] = bounds;

    const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "";
    const url = `${apiUrl}/api/integrations/overlay-hiking/hiking/shelters?south=${south}&west=${west}&north=${north}&east=${east}`;

    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as GeoJSON.FeatureCollection;
      setGeojson(data);
    } catch {
      // Silent failure
    }
  }, [mapRef]);

  useEffect(() => {
    void viewportKey;
    if (!mapReady || !layerVisible) {
      fetchedRef.current = false;
      setGeojson(EMPTY_GEOJSON);
      return;
    }
    fetchedRef.current = true;
    fetchShelters();
  }, [mapReady, layerVisible, fetchShelters, viewportKey]);

  if (!layerVisible) return null;

  return (
    <GeoJSONSource id={SOURCE_ID} data={geojson}>
      <Layer
        type="circle"
        id={CIRCLE_LAYER_ID}
        minzoom={MIN_ZOOM}
        paint={{
          "circle-color": [
            "match",
            ["get", "type"],
            "refuge",
            SHELTER_COLORS.refuge,
            "cabane",
            SHELTER_COLORS.cabane,
            "gite",
            SHELTER_COLORS.gite,
            "pt_eau",
            SHELTER_COLORS.pt_eau,
            "pt_passage",
            SHELTER_COLORS.pt_passage,
            "#795548",
          ],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], MIN_ZOOM, 4, 16, 8],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-opacity": 0.9,
        }}
      />
      <Layer
        type="symbol"
        id={LABEL_LAYER_ID}
        minzoom={12}
        layout={{
          "text-field": ["get", "name"],
          "text-size": 11,
          "text-offset": [0, 1.3],
          "text-anchor": "top",
          "text-optional": true,
          "text-max-width": 8,
        }}
        paint={{
          "text-color": "#333333",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        }}
      />
    </GeoJSONSource>
  );
}
