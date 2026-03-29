import { Layer, VectorSource } from "@maplibre/maplibre-react-native";
import { useTransitStore } from "@openmapx/core";

const TRANSIT_SOURCE_ID = "openmapx-transit-source";
const TRANSIT_LAYER_ID = "openmapx-transit-layer";
const PRIMARY_BLUE_HEX = "#4285F4";

/**
 * Transit lines overlay using OpenMapTiles vector tile source.
 * On mobile, rather than modifying existing style layers, we add a
 * new VectorSource layer specifically for transit line classes.
 * This approach is more reliable on RN MapLibre than style mutation.
 */
export function TransitLayer() {
  const showTransit = useTransitStore((s) => s.layerVisible);

  if (!showTransit) return null;

  const maptilerKey = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";
  const tileUrl = `https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key=${maptilerKey}`;

  return (
    <VectorSource id={TRANSIT_SOURCE_ID} tiles={[tileUrl]} maxzoom={14}>
      <Layer
        type="line"
        id={TRANSIT_LAYER_ID}
        source-layer="transportation"
        filter={["in", "class", "transit", "rail", "subway", "tram", "bus", "ferry", "train"]}
        paint={{
          "line-color": [
            "match",
            ["get", "class"],
            "subway",
            PRIMARY_BLUE_HEX,
            "tram",
            "#0F9D58",
            "rail",
            "#5F6368",
            "bus",
            "#F29900",
            "ferry",
            "#00ACC1",
            "#34A853",
          ],
          "line-opacity": 0.95,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.9, 10, 1.8, 14, 3],
        }}
        layout={{
          "line-cap": "round",
          "line-join": "round",
        }}
      />
    </VectorSource>
  );
}
