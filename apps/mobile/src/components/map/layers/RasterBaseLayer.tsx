import { Layer, RasterSource } from "@maplibre/maplibre-react-native";
import type { MapLayer } from "@openmapx/core";
import { useLayerStore } from "@openmapx/core";

interface RasterBaseLayerProps {
  sourceId: string;
  layerId: string;
  tiles: string[];
  activeWhen: MapLayer;
  tileSize?: number;
  maxzoom?: number;
  attribution?: string;
  paint?: Record<string, unknown>;
}

export function RasterBaseLayer({
  sourceId,
  layerId,
  tiles,
  activeWhen,
  tileSize = 256,
  maxzoom = 20,
  attribution,
  paint,
}: RasterBaseLayerProps) {
  const activeLayer = useLayerStore((s) => s.activeLayer);

  if (activeLayer !== activeWhen || tiles.length === 0) return null;

  return (
    <RasterSource
      id={sourceId}
      tiles={tiles}
      tileSize={tileSize}
      maxzoom={maxzoom}
      attribution={attribution}
    >
      <Layer type="raster" id={layerId} paint={paint} />
    </RasterSource>
  );
}
