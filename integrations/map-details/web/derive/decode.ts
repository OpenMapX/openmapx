import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { Pt } from "./geometry";

/** A decoded vector tile feature: geometry in tile units (y down), raw properties. */
export interface TileFeature {
  type: 1 | 2 | 3;
  geometry: Pt[][];
  props: Record<string, string | number | boolean>;
  /** The vector-tile feature id; Planetiler writes OSM elements as `osmId × 10 + kind`. */
  id?: number;
}

/** The OSM way id of a feature Planetiler built from a way (kind 2), else null. */
export function wayIdOf(feature: TileFeature): number | null {
  const id = feature.id;
  if (id === undefined || !Number.isSafeInteger(id) || id % 10 !== 2) return null;
  return (id - 2) / 10;
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
          ...(typeof feature.id === "number" ? { id: feature.id } : {}),
        });
      }
    }
    layers[name] = features;
  }
  return { extent, layers };
}
