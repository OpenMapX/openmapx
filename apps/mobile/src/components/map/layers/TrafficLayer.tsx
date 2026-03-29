import { Layer, RasterSource } from "@maplibre/maplibre-react-native";
import { useTrafficStore } from "@openmapx/core";

const TRAFFIC_SOURCE_ID = "openmapx-traffic-source";
const TRAFFIC_LAYER_ID = "openmapx-traffic-layer";
const TRAFFIC_MIN_ZOOM = 10;

function getTrafficTileTemplate(): string {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) {
    const normalized = apiUrl.endsWith("/") ? apiUrl.slice(0, -1) : apiUrl;
    return `${normalized}/api/traffic/flow/{z}/{x}/{y}.png`;
  }
  return "http://localhost:3001/api/traffic/flow/{z}/{x}/{y}.png";
}

export function TrafficLayer() {
  const showTraffic = useTrafficStore((s) => s.layerVisible);

  if (!showTraffic) return null;

  const tileUrl = getTrafficTileTemplate();

  return (
    <RasterSource
      id={TRAFFIC_SOURCE_ID}
      tiles={[tileUrl]}
      tileSize={256}
      maxzoom={20}
      attribution='Traffic data &copy; <a href="https://developer.tomtom.com/">TomTom</a>'
    >
      <Layer
        type="raster"
        id={TRAFFIC_LAYER_ID}
        minzoom={TRAFFIC_MIN_ZOOM}
        paint={{
          "raster-opacity": 0.9,
          "raster-fade-duration": 200,
        }}
      />
    </RasterSource>
  );
}
