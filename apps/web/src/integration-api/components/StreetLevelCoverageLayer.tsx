"use client";

import type { StreetLevelCapabilities } from "@openmapx/core";
import { useOverlayExclusion, useStreetLevelStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  readCapturedContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { FilterSpecification, Map as MapLibreMap } from "maplibre-gl";
import { useMemo, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup, SlottedLayer } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useMapOverlayInteraction } from "@/integration-api/map/useMapOverlayInteraction";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useStreetLevelProviders } from "./useStreetLevelProviders";

type MvtCoverage = Extract<StreetLevelCapabilities["coverage"], { kind: "mvt" }>;

function coverageSourceId(providerId: string): string {
  return `sli-${providerId}`;
}

function coverageLayerIds(providerId: string): {
  sequences: string;
  pictures: string;
  picturesPano: string;
  grid: string;
} {
  const base = coverageSourceId(providerId);
  return {
    sequences: `${base}-sequences`,
    pictures: `${base}-pictures`,
    picturesPano: `${base}-pictures-pano`,
    grid: `${base}-grid`,
  };
}

/** Every provider's clickable picture layers, in priority order. */
export function pictureLayerIds(providers: StreetLevelCapabilities[]): string[] {
  return providers.flatMap((provider) => {
    const ids = coverageLayerIds(provider.id);
    return [ids.pictures, ids.picturesPano];
  });
}

/** Map each clickable layer id back to the provider that owns it. */
export function providerIdByLayer(providers: StreetLevelCapabilities[]): Map<string, string> {
  const byLayer = new Map<string, string>();
  for (const provider of providers) {
    const ids = coverageLayerIds(provider.id);
    byLayer.set(ids.pictures, provider.id);
    byLayer.set(ids.picturesPano, provider.id);
  }
  return byLayer;
}

function panoFilter(coverage: MvtCoverage, wantPano: boolean): FilterSpecification | undefined {
  const property = coverage.props.isPano;
  if (!property) return undefined;
  const value = coverage.props.panoValue ?? true;
  return (
    wantPano ? ["==", ["get", property], value] : ["!=", ["get", property], value]
  ) as FilterSpecification;
}

/** The contributors each layer of one tile source generation was captured with. */
interface CoverageSnapshot {
  tileUrl: string;
  layers: Record<string, readonly Attribution[]>;
}

function coverageSnapshot(
  provider: StreetLevelCapabilities,
  coverage: MvtCoverage,
  tileUrl: string,
) {
  const ids = coverageLayerIds(provider.id);
  const pictures = coverage.layerContributors?.[coverage.layers.pictures] ?? [];
  return {
    tileUrl,
    layers: {
      [ids.sequences]: snapshotContributors(
        coverage.layerContributors?.[coverage.layers.sequences] ?? [],
      ),
      [ids.pictures]: snapshotContributors(pictures),
      [ids.picturesPano]: snapshotContributors(pictures),
      [ids.grid]: snapshotContributors(
        coverage.layerContributors?.[coverage.layers.grid ?? ""] ?? [],
      ),
    },
  };
}

function coverageLayers(provider: StreetLevelCapabilities, coverage: MvtCoverage): SlottedLayer[] {
  const source = coverageSourceId(provider.id);
  const ids = coverageLayerIds(provider.id);
  const layers: SlottedLayer[] = [];
  if (coverage.layers.grid) {
    layers.push({
      id: ids.grid,
      type: "circle",
      source,
      minzoom: coverage.minzoom,
      "source-layer": coverage.layers.grid,
      maxzoom: 7,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "coef"], 0, 2, 1, 12],
        "circle-color": provider.color,
        "circle-opacity": 0.5,
      },
      slot: "overlay-points",
      order: 11,
    });
  }
  const pano = panoFilter(coverage, true);
  const flat = panoFilter(coverage, false);
  layers.push(
    {
      id: ids.sequences,
      type: "line",
      source,
      minzoom: coverage.minzoom,
      "source-layer": coverage.layers.sequences,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": provider.color,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 14, 4],
        "line-opacity": 0.85,
      },
      slot: "overlay-lines",
      order: 11,
    },
    {
      id: ids.pictures,
      type: "circle",
      source,
      minzoom: coverage.minzoom,
      "source-layer": coverage.layers.pictures,
      ...(flat ? { filter: flat } : {}),
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 6],
        "circle-color": provider.color,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1,
      },
      slot: "overlay-points",
      order: 12,
    },
    {
      id: ids.picturesPano,
      type: "circle",
      source,
      minzoom: coverage.minzoom,
      "source-layer": coverage.layers.pictures,
      ...(pano ? { filter: pano } : {}),
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 14, 10],
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": provider.color,
        "circle-stroke-width": 2,
      },
      slot: "overlay-points",
      order: 13,
    },
  );
  return layers;
}

/** Picture dots are points, so they win over line and area overlays beneath them. */
const PICTURE_INTERACTION_PRIORITY = 50;

export function StreetLevelCoverageLayer() {
  const { mapRef } = useMap();
  const currentMap = mapRef.current;
  const { apiUrl } = useEnv();
  const { providers } = useStreetLevelProviders();
  const layerVisible = useStreetLevelStore((s) => s.layerVisible);
  const requestImageLoad = useStreetLevelStore((s) => s.requestImageLoad);

  useOverlayExclusion("street-level-imagery", layerVisible);

  // Each map and tile source generation keeps the capabilities it was created
  // with: a metadata refresh cannot relabel tile bytes MapLibre already holds.
  const snapshots = useRef(new WeakMap<MapLibreMap, Map<string, CoverageSnapshot>>());

  const group = useMemo<MapLayerGroup | null>(() => {
    const retained = currentMap ? (snapshots.current.get(currentMap) ?? new Map()) : undefined;
    if (currentMap && retained) snapshots.current.set(currentMap, retained);
    if (!layerVisible) {
      retained?.clear();
      return null;
    }
    const sources: MapLayerGroup["sources"] = {};
    const layers: SlottedLayer[] = [];
    for (const provider of providers) {
      const coverage = provider.coverage;
      if (coverage.kind !== "mvt") continue;
      const sourceId = coverageSourceId(provider.id);
      const tileUrl = `${apiUrl}${coverage.tileUrlTemplate}`;
      if (retained && retained.get(sourceId)?.tileUrl !== tileUrl) {
        retained.set(sourceId, coverageSnapshot(provider, coverage, tileUrl));
      }
      sources[sourceId] = {
        type: "vector",
        tiles: [tileUrl],
        minzoom: coverage.minzoom,
        maxzoom: coverage.maxzoom,
      };
      layers.push(...coverageLayers(provider, coverage));
    }
    for (const sourceId of retained?.keys() ?? []) {
      if (!(sourceId in sources)) retained?.delete(sourceId);
    }
    return { sources, layers };
  }, [currentMap, layerVisible, providers, apiUrl]);
  useMapLayerGroup(group);

  const layerIds = providers.flatMap((provider) => Object.values(coverageLayerIds(provider.id)));
  useRenderedMapAttributions("street-level-coverage", layerIds, layerVisible, {
    resolveFeatureContributors: (feature) => {
      const native =
        readCapturedContributors(feature.properties?._mapAttributions) ??
        readCapturedContributors(feature.properties?.contributors);
      if (native !== undefined) return native;
      return currentMap
        ? (snapshots.current.get(currentMap)?.get(feature.source ?? feature.layer.source)?.layers[
            feature.layer.id
          ] ?? [])
        : [];
    },
  });

  // One registration over every provider's dots, so where two providers overlap
  // the topmost dot opens rather than one per layer.
  const byLayer = useMemo(() => providerIdByLayer(providers), [providers]);
  useMapOverlayInteraction({
    id: "street-level-coverage",
    layerIds: pictureLayerIds(providers),
    priority: PICTURE_INTERACTION_PRIORITY,
    enabled: layerVisible,
    onClick: ({ features }) => {
      const feature = features[0];
      const imageId = feature?.properties?.id;
      const providerId = byLayer.get(feature?.layer?.id ?? "");
      if (imageId != null && providerId) {
        requestImageLoad({ providerId, imageId: String(imageId) });
      }
    },
  });

  return null;
}
