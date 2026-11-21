import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { Pt } from "./geometry";

/** A decoded vector tile feature: geometry in tile units (y down), raw properties. */
export interface TileFeature {
  type: 1 | 2 | 3;
  geometry: Pt[][];
  props: Record<string, string | number | boolean>;
}

export interface DecodedTile {
  extent: number;
  layers: Record<string, TileFeature[]>;
}

/** Decode the named layers of a vector tile; missing layers decode as empty lists. */
export function decodeLayers(bytes: Uint8Array, names: readonly string[]): DecodedTile {
  const tile = new VectorTile(new PbfReader(bytes));
  let extent = 4096;
  const layers: Record<string, TileFeature[]> = {};
  for (const name of names) {
    const layer = tile.layers[name];
    const features: TileFeature[] = [];
    if (layer) {
      extent = layer.extent;
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        if (feature.type === 0) continue;
        features.push({
          type: feature.type,
          geometry: feature.loadGeometry().map((ring) => ring.map((p): Pt => [p.x, p.y])),
          props: feature.properties as Record<string, string | number | boolean>,
        });
      }
    }
    layers[name] = features;
  }
  return { extent, layers };
}
