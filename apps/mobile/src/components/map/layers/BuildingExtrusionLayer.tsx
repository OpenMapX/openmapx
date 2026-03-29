import { Layer } from "@maplibre/maplibre-react-native";
import { useBuildingsStore } from "@openmapx/core";

const LAYER_ID = "openmapx-3d-buildings";
const MIN_ZOOM = 14;

export function BuildingExtrusionLayer() {
  const layerVisible = useBuildingsStore((s) => s.layerVisible);

  if (!layerVisible) return null;

  return (
    <Layer
      type="fill-extrusion"
      id={LAYER_ID}
      source="openmaptiles"
      source-layer="building"
      minzoom={MIN_ZOOM}
      filter={["!=", ["get", "hide_3d"], true]}
      paint={{
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          ["get", "render_height"],
          0,
          "#d4d0cc",
          20,
          "#c8c4c0",
          60,
          "#b8b4b2",
          150,
          "#a8a6a8",
          300,
          "#9898a0",
        ],
        "fill-extrusion-height": ["get", "render_height"],
        "fill-extrusion-base": ["get", "render_min_height"],
        "fill-extrusion-opacity": 1,
      }}
    />
  );
}
