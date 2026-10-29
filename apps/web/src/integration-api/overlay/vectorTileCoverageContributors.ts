import type { Attribution } from "@openmapx/mobility-core/attribution";
import { parseContributors } from "@openmapx/mobility-core/contributors";
import type { Map as MapLibreMap } from "maplibre-gl";
import { isAttributionLayerVisible } from "./renderedFeatureVisibility";

interface TileCoverageOptions {
  sourceId: string;
  sourceLayer: string;
  layerIds: readonly string[];
  /** Equal keys MUST include every input used by every layer's projection. */
  featureContributorKey: (properties: Record<string, unknown>) => string;
  resolveFeatureContributors: (
    properties: Record<string, unknown>,
    layerId: string,
  ) => readonly Attribution[];
}

/** Copy/validate while retaining complete receipts, including retrieval time. */
function fullSnapshots(groups: Iterable<readonly Attribution[]>): Attribution[] {
  const receipts = new Map<string, Attribution>();
  for (const group of groups)
    for (const receipt of parseContributors(group) ?? [])
      receipts.set(JSON.stringify(receipt), receipt);
  return [...receipts.values()];
}

/**
 * Conservative vector-tile coverage, NOT exact viewport feature attribution.
 * Includes offscreen/filtered segments inside a renderable tile. Opt in only
 * when extra captured suppliers are acceptable; never replace incident tracking
 * implicitly. The host owns this MapLibre 6.13 retained-tile bridge, just like
 * rasterMapContribution. No geometry decoding, hit testing or GeoJSON allocation.
 *
 * Create once for immutable projection options. Raw payload WeakMaps survive
 * style reparsing/304 and retain the original receipt while reloads keep drawable data;
 * replacement buffers cannot inherit old notices. No coordinate/history cache.
 */
export function createVectorTileCoverageContributorResolver(
  options: TileCoverageOptions,
): (map: MapLibreMap) => Attribution[] {
  const payloads = new WeakMap<ArrayBuffer, Map<string, Map<string, Attribution[]>>>();
  return (map) => {
    const manager = map.style?.tileManagers?.[options.sourceId];
    if (!manager || manager.getSource() !== map.getSource(options.sourceId)) return [];
    const live = options.layerIds.filter((id) => {
      if (!isAttributionLayerVisible(map, id)) return false;
      const layer = map.getLayer(id);
      if (
        layer?.type !== "line" ||
        layer.source !== options.sourceId ||
        layer.sourceLayer !== options.sourceLayer
      )
        return false;
      // Read evaluated paint, not a zero transition target while old content
      // still fades. Data-dependent values remain conservative across the tile.
      const paint = map.style.getLayer(id)?.paint;
      if (
        !paint ||
        typeof paint !== "object" ||
        !("get" in paint) ||
        typeof paint.get !== "function"
      )
        return true;
      const getPaint = paint.get.bind(paint);
      return !["line-opacity", "line-layer-opacity", "line-width"].some((key) => {
        const evaluated: unknown = getPaint(key);
        return (
          evaluated === 0 ||
          (!!evaluated &&
            typeof evaluated === "object" &&
            "constantOr" in evaluated &&
            typeof evaluated.constantOr === "function" &&
            evaluated.constantOr(1) === 0)
        );
      });
    });
    if (!live.length) return [];
    const receipts = new Set<readonly Attribution[]>();
    for (const coordinate of manager.getVisibleCoordinates()) {
      const tile = manager.getTile(coordinate);
      if (!tile?.hasData()) continue;
      const index = tile.latestFeatureIndex;
      const raw = index?.rawTileData;
      if (!index || !raw) continue;
      const drawn = live.filter((id) => {
        const layer = map.style.getLayer(id);
        const bucket = layer && tile.getBucket(layer);
        return bucket && "uploaded" in bucket && bucket.uploaded === true && !bucket.isEmpty();
      });
      if (!drawn.length) continue;
      let encodings = payloads.get(raw);
      if (!encodings) {
        encodings = new Map();
        payloads.set(raw, encodings);
      }
      const key = `${index.encoding}:${options.sourceLayer}`;
      let projected = encodings.get(key);
      if (!projected) {
        const groups = new Map<string, Record<string, unknown>>();
        const layer = index.loadVTLayers()[options.sourceLayer];
        for (let i = 0; layer && i < layer.length; i++) {
          const properties = layer.feature(i).properties;
          const group = options.featureContributorKey(properties);
          if (!groups.has(group)) groups.set(group, properties);
        }
        projected = new Map();
        for (const id of options.layerIds) {
          projected.set(
            id,
            fullSnapshots(
              [...groups.values()].map((properties) =>
                options.resolveFeatureContributors(properties, id),
              ),
            ),
          );
        }
        encodings.set(key, projected);
      }
      for (const id of drawn) {
        const captured = projected.get(id);
        if (captured) receipts.add(captured);
      }
    }
    // Return owned immutable snapshots, preserving distinct same-source notices.
    return fullSnapshots(receipts);
  };
}
