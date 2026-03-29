import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { VehiclePosition } from "@openmapx/core";
import { useLiveTrains, useLiveTrainsStore } from "@openmapx/core";
import { useMemo } from "react";

const SOURCE_ID = "live-trains-source";
const CIRCLE_LAYER_ID = "live-trains-circle";
const LABEL_LAYER_ID = "live-trains-label";

const DB_CATEGORY_COLORS: Record<string, string> = {
  ICE: "#8B0000",
  IC: "#C41E3A",
  EC: "#C41E3A",
  RE: "#EF4444",
  RB: "#FB923C",
  S: "#22C55E",
};

function dbCategoryColor(category: string): string {
  return DB_CATEGORY_COLORS[category] ?? "#8B5CF6";
}

function buildGeoJson(positions: VehiclePosition[]) {
  return {
    type: "FeatureCollection" as const,
    features: positions.map((p) => {
      const [name = ""] = (p.label ?? "").split("\n");
      const category = name.split(" ")[0] ?? "";
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
        properties: {
          id: p.id,
          name,
          color: dbCategoryColor(category),
          bearing: p.bearing ?? 0,
        },
      };
    }),
  };
}

const EMPTY_GEOJSON = {
  type: "FeatureCollection" as const,
  features: [] as Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: { id: string; name: string; color: string; bearing: number };
  }>,
};

export function LiveTrainsLayer() {
  const layerVisible = useLiveTrainsStore((s) => s.layerVisible);
  const { data: positions } = useLiveTrains(layerVisible);

  const geojson = useMemo(() => {
    if (!positions?.length) return EMPTY_GEOJSON;
    return buildGeoJson(positions);
  }, [positions]);

  if (!layerVisible) return null;

  return (
    <GeoJSONSource id={SOURCE_ID} data={geojson}>
      <Layer
        type="circle"
        id={CIRCLE_LAYER_ID}
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3, 8, 5, 12, 8],
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        }}
      />
      <Layer
        type="symbol"
        id={LABEL_LAYER_ID}
        minzoom={8}
        layout={{
          "text-field": ["get", "name"],
          "text-size": 11,
          "text-offset": [0, 1.8],
          "text-anchor": "top",
          "text-optional": true,
          "text-allow-overlap": false,
        }}
        paint={{
          "text-color": "#333",
          "text-halo-color": "#fff",
          "text-halo-width": 1.5,
        }}
      />
    </GeoJSONSource>
  );
}
