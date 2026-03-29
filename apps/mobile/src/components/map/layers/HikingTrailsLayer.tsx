import { Layer, RasterSource } from "@maplibre/maplibre-react-native";
import { useHikingStore } from "@openmapx/core";

const RASTER_SOURCE_ID = "openmapx-hiking-trails-source";
const RASTER_LAYER_ID = "openmapx-hiking-trails-layer";

export function HikingTrailsLayer() {
  const layerVisible = useHikingStore((s) => s.layerVisible);

  if (!layerVisible) return null;

  return (
    <RasterSource
      id={RASTER_SOURCE_ID}
      tiles={["https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png"]}
      tileSize={256}
      maxzoom={18}
    >
      <Layer
        type="raster"
        id={RASTER_LAYER_ID}
        paint={{
          "raster-opacity": 0.85,
          "raster-fade-duration": 200,
        }}
      />
    </RasterSource>
  );
}
