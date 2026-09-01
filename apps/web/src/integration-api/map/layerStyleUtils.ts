"use client";

import type * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, GeoJSONSourceDiff } from "maplibre-gl";

export type GeoJsonSourceData = Parameters<GeoJSONSource["setData"]>[0];

export interface GeoJsonSourceDataEntry {
  sourceId: string;
  data: GeoJsonSourceData;
  /** Optional incremental update; `data` remains the replayable full state. */
  update?: GeoJSONSourceDiff;
}

export type GeoJsonSourceDataApplyResult =
  | { status: "applied" }
  | { status: "waiting"; missingSourceIds: string[] }
  | {
      status: "incompatible";
      incompatibleSources: Array<{ sourceId: string; sourceType: string }>;
      missingSourceIds: string[];
    };

export interface GeoJsonSourceDataBridge {
  /** Retain the newest payload for each source and apply it when possible. */
  publish(entries: readonly GeoJsonSourceDataEntry[]): void;
  /** Apply retained payloads together once every retained source is present. */
  apply(map: maplibregl.Map): GeoJsonSourceDataApplyResult;
  /** Forget retained payloads, either for one source or for the whole bridge. */
  clear(sourceIds?: readonly string[]): void;
}

/**
 * Retain dynamic GeoJSON outside MapLibre's source objects.
 *
 * A style change removes application-owned sources while fetches and React
 * effects continue to run. Writing directly through `getSource()?.setData`
 * loses the payload in that window. This bridge keeps the latest payload and
 * reapplies it to the new source object. A single bridge may represent several
 * related sources; those are updated only when all currently retained sources
 * exist. This is coordinated readiness, not a MapLibre transaction: callers
 * requiring a truly atomic revision should use one mixed-geometry source.
 */
export function createGeoJsonSourceDataBridge(): GeoJsonSourceDataBridge {
  const pending = new Map<string, GeoJsonSourceDataEntry>();
  const applied = new Map<string, { source: GeoJSONSource; data: GeoJsonSourceData }>();

  return {
    publish(entries) {
      for (const entry of entries) {
        const previousPending = pending.get(entry.sourceId);
        const previousApplied = applied.get(entry.sourceId);
        const skippedPendingRevision =
          previousPending !== undefined && previousApplied?.data !== previousPending.data;
        pending.set(
          entry.sourceId,
          skippedPendingRevision && entry.update ? { ...entry, update: undefined } : entry,
        );
      }
    },

    apply(map) {
      if (pending.size === 0) return { status: "applied" };

      const sources = [...pending].map(([sourceId, entry]) => ({
        sourceId,
        entry,
        source: map.getSource(sourceId),
      }));
      const missingSourceIds = sources
        .filter(({ source }) => source === undefined)
        .map(({ sourceId }) => sourceId);
      const incompatibleSources = sources.flatMap(({ sourceId, source }) => {
        if (!source || source.type === "geojson") return [];
        return [
          {
            sourceId,
            sourceType: typeof source.type === "string" ? source.type : "unknown",
          },
        ];
      });

      if (incompatibleSources.length > 0) {
        return { status: "incompatible", incompatibleSources, missingSourceIds };
      }
      if (missingSourceIds.length > 0) return { status: "waiting", missingSourceIds };

      for (const { sourceId, entry, source } of sources) {
        // Missing and incompatible sources returned above, so this cast is now
        // guarded by the runtime source type rather than optional chaining.
        const geoJsonSource = source as GeoJSONSource;
        const previous = applied.get(sourceId);
        if (!previous || previous.source !== geoJsonSource || previous.data !== entry.data) {
          if (
            previous?.source === geoJsonSource &&
            entry.update &&
            typeof geoJsonSource.updateData === "function"
          ) {
            geoJsonSource.updateData(entry.update);
          } else {
            geoJsonSource.setData(entry.data);
          }
        }
        applied.set(sourceId, { source: geoJsonSource, data: entry.data });
      }
      return { status: "applied" };
    },

    clear(sourceIds) {
      if (!sourceIds) {
        pending.clear();
        applied.clear();
        return;
      }
      for (const sourceId of sourceIds) {
        pending.delete(sourceId);
        applied.delete(sourceId);
      }
    },
  };
}

/**
 * Guarded teardown of one or more layers followed by their source. Layers are
 * removed in the order given (callers must pass top-most/dependent layers
 * first), then the source. Wrapped in a try/catch that swallows errors because
 * the style may already have been torn down (e.g. during a style change), which
 * makes `getLayer`/`getSource` lie about presence.
 */
export function removeLayerAndSource(
  map: maplibregl.Map,
  layerIds: string | string[],
  sourceId: string,
): void {
  const ids = typeof layerIds === "string" ? [layerIds] : layerIds;
  try {
    for (const id of ids) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } catch {
    // Source/layer may already be torn down during a style change
  }
}

/**
 * Upsert a GeoJSON source: if it already exists, call `setData`; otherwise
 * `addSource` with `{ type: "geojson", data }`. Returns the resolved
 * `GeoJSONSource`. Does NOT add any layers — callers keep their own
 * `addLayer` calls (some gate them on the source not having existed).
 */
export function upsertGeoJsonSource(
  map: maplibregl.Map,
  sourceId: string,
  data: GeoJsonSourceData,
): GeoJSONSource {
  const existing = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
    return existing;
  }
  map.addSource(sourceId, { type: "geojson", data });
  return map.getSource(sourceId) as GeoJSONSource;
}

export interface VectorLineReference {
  source: string;
  sourceLayer: string;
}

export function getFirstSymbolLayerId(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle().layers;
  return layers?.find((layer) => layer.type === "symbol")?.id;
}

export function findVectorLineReference(
  map: maplibregl.Map,
  sourceHints: readonly RegExp[],
): VectorLineReference | null {
  const layers = map.getStyle().layers;
  if (!layers) return null;

  for (const layer of layers) {
    if (layer.type !== "line") continue;
    if (!("source" in layer) || !("source-layer" in layer)) continue;

    const source = layer.source;
    const sourceLayer = layer["source-layer"];
    if (typeof source !== "string" || typeof sourceLayer !== "string") continue;

    const matches = sourceHints.some((hint) => hint.test(layer.id) || hint.test(sourceLayer));
    if (!matches) continue;

    return { source, sourceLayer };
  }

  return null;
}

export function setLayerVisibility(map: maplibregl.Map, layerId: string, visible: boolean): void {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}
