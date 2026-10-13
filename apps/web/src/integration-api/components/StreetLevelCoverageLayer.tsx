"use client";

import type { StreetLevelCapabilities } from "@openmapx/core";
import { useOverlayExclusion, useStreetLevelStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { parseContributors, snapshotContributors } from "@openmapx/mobility-core/contributors";
import type {
  FilterSpecification,
  MapLayerMouseEvent,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import { useEffect, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useStreetLevelProviders } from "./useStreetLevelProviders";

type MvtCoverage = Extract<StreetLevelCapabilities["coverage"], { kind: "mvt" }>;

export function coverageSourceId(providerId: string): string {
  return `sli-${providerId}`;
}

export function coverageLayerIds(providerId: string): {
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

export function StreetLevelCoverageLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const currentMap = mapRef.current;
  const { apiUrl } = useEnv();
  const { providers } = useStreetLevelProviders();
  const layerVisible = useStreetLevelStore((s) => s.layerVisible);
  const requestImageLoad = useStreetLevelStore((s) => s.requestImageLoad);

  useOverlayExclusion("street-level-imagery", layerVisible);

  // Each map/source generation owns its captured capabilities. Metadata refresh
  // cannot relabel tile bytes already retained by MapLibre.
  const snapshots = useRef(
    new WeakMap<
      MapLibreMap,
      Map<string, { tileUrl: string; layers: Record<string, readonly Attribution[]> }>
    >(),
  );
  const layerIds = providers.flatMap((provider) => Object.values(coverageLayerIds(provider.id)));
  useRenderedMapAttributions("street-level-coverage", layerIds, layerVisible, {
    resolveFeatureContributors: (feature) => {
      const map = currentMap;
      const native =
        parseContributors(feature.properties?._mapAttributions) ??
        parseContributors(feature.properties?.contributors);
      if (native !== undefined) return native;
      return map
        ? (snapshots.current.get(map)?.get(feature.source ?? feature.layer.source)?.layers[
            feature.layer.id
          ] ?? [])
        : [];
    },
  });

  useEffect(
    () => () => {
      if (!currentMap) return;
      const retained = snapshots.current.get(currentMap);
      for (const sourceId of retained?.keys() ?? []) {
        for (const suffix of ["grid", "sequences", "pictures", "pictures-pano"]) {
          const id = `${sourceId}-${suffix}`;
          if (currentMap.getLayer(id)) currentMap.removeLayer(id);
          unregisterLayerSlot(id);
        }
        if (currentMap.getSource(sourceId)) currentMap.removeSource(sourceId);
      }
      snapshots.current.delete(currentMap);
    },
    [currentMap],
  );

  useEffect(() => {
    void styleVersion;
    const map = currentMap;
    if (!map || !mapReady) return;

    let retained = snapshots.current.get(map);
    if (!retained) {
      retained = new Map();
      snapshots.current.set(map, retained);
    }
    const sourceSnapshots = retained;
    const removeProvider = (sourceId: string) => {
      for (const suffix of ["grid", "sequences", "pictures", "pictures-pano"]) {
        const id = `${sourceId}-${suffix}`;
        if (map.getLayer(id)) map.removeLayer(id);
        unregisterLayerSlot(id);
      }
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      sourceSnapshots.delete(sourceId);
    };
    const syncLayers = () => {
      const selected = new Set(providers.map((provider) => coverageSourceId(provider.id)));
      for (const id of sourceSnapshots.keys())
        if (!layerVisible || !selected.has(id)) removeProvider(id);
      if (!layerVisible) {
        for (const provider of providers) {
          try {
            for (const layerId of Object.values(coverageLayerIds(provider.id))) {
              if (map.getLayer(layerId)) map.removeLayer(layerId);
            }
            const sourceId = coverageSourceId(provider.id);
            if (map.getSource(sourceId)) map.removeSource(sourceId);
          } catch {
            // Tiles may still be in-flight when the source is torn down
          }
          for (const layerId of Object.values(coverageLayerIds(provider.id))) {
            unregisterLayerSlot(layerId);
          }
        }
        return;
      }

      for (const provider of providers) {
        const coverage = provider.coverage;
        if (coverage.kind !== "mvt") continue;

        const sourceId = coverageSourceId(provider.id);
        const ids = coverageLayerIds(provider.id);

        const tileUrl = `${apiUrl}${coverage.tileUrlTemplate}`;
        if (
          sourceSnapshots.get(sourceId)?.tileUrl !== undefined &&
          sourceSnapshots.get(sourceId)?.tileUrl !== tileUrl
        )
          removeProvider(sourceId);
        if (!sourceSnapshots.has(sourceId)) {
          sourceSnapshots.set(sourceId, {
            tileUrl,
            layers: {
              [ids.sequences]: snapshotContributors(
                coverage.layerContributors?.[coverage.layers.sequences] ?? [],
              ),
              [ids.pictures]: snapshotContributors(
                coverage.layerContributors?.[coverage.layers.pictures] ?? [],
              ),
              [ids.picturesPano]: snapshotContributors(
                coverage.layerContributors?.[coverage.layers.pictures] ?? [],
              ),
              [ids.grid]: snapshotContributors(
                coverage.layerContributors?.[coverage.layers.grid ?? ""] ?? [],
              ),
            },
          });
        }
        if (!map.getSource(sourceId)) {
          map.addSource(sourceId, {
            type: "vector",
            tiles: [tileUrl],
            minzoom: coverage.minzoom,
            maxzoom: coverage.maxzoom,
          });
        }

        if (coverage.layers.grid && !map.getLayer(ids.grid)) {
          addLayerInSlot(
            map,
            {
              id: ids.grid,
              type: "circle",
              source: sourceId,
              minzoom: coverage.minzoom,
              "source-layer": coverage.layers.grid,
              maxzoom: 7,
              paint: {
                "circle-radius": ["interpolate", ["linear"], ["get", "coef"], 0, 2, 1, 12],
                "circle-color": provider.color,
                "circle-opacity": 0.5,
              },
            },
            "overlay-points",
            11,
          );
        }

        if (!map.getLayer(ids.sequences)) {
          addLayerInSlot(
            map,
            {
              id: ids.sequences,
              type: "line",
              source: sourceId,
              minzoom: coverage.minzoom,
              "source-layer": coverage.layers.sequences,
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                "line-color": provider.color,
                "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 14, 4],
                "line-opacity": 0.85,
              },
            },
            "overlay-lines",
            11,
          );
        }

        if (!map.getLayer(ids.pictures)) {
          addLayerInSlot(
            map,
            {
              id: ids.pictures,
              type: "circle",
              source: sourceId,
              minzoom: coverage.minzoom,
              "source-layer": coverage.layers.pictures,
              filter: panoFilter(coverage, false),
              paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 6],
                "circle-color": provider.color,
                "circle-stroke-color": "#fff",
                "circle-stroke-width": 1,
              },
            },
            "overlay-points",
            12,
          );
        }

        if (!map.getLayer(ids.picturesPano)) {
          addLayerInSlot(
            map,
            {
              id: ids.picturesPano,
              type: "circle",
              source: sourceId,
              minzoom: coverage.minzoom,
              "source-layer": coverage.layers.pictures,
              filter: panoFilter(coverage, true),
              paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 14, 10],
                "circle-color": "rgba(0,0,0,0)",
                "circle-stroke-color": provider.color,
                "circle-stroke-width": 2,
              },
            },
            "overlay-points",
            13,
          );
        }
      }
    };

    if (!layerVisible) {
      syncLayers();
      return;
    }

    return subscribeStyleLoaded(map, syncLayers);
  }, [mapReady, styleVersion, currentMap, layerVisible, providers, apiUrl]);

  useEffect(() => {
    void styleVersion;
    const map = currentMap;
    if (!map || !mapReady || !layerVisible) return;

    // Bind unconditionally rather than filtering by `map.getLayer(id)` here:
    // layer creation is deferred until idle whenever the style is still
    // loading, so an existence check at effect time would attach nothing and
    // leave the dots permanently unclickable. MapLibre resolves the layer list
    // at event time and ignores ids that don't exist yet.
    const interactive = pictureLayerIds(providers);
    if (interactive.length === 0) return;

    const byLayer = providerIdByLayer(providers);

    // One delegated handler over all provider layers, so a click where two
    // providers' dots overlap resolves to the topmost feature instead of
    // firing once per layer and letting the last one win.
    const handleClick = (e: MapLayerMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const feature = e.features?.[0];
      const imageId = feature?.properties?.id;
      const providerId = byLayer.get(feature?.layer?.id ?? "");
      if (imageId != null && providerId) {
        requestImageLoad({ providerId, imageId: String(imageId) });
      }
    };

    const handleMouseMove = (e: MapMouseEvent) => {
      const present = interactive.filter((id) => !!map.getLayer(id));
      if (present.length === 0) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: present });
      map.getCanvasContainer().style.cursor = hits.length > 0 ? "pointer" : "";
    };

    map.on("click", interactive, handleClick);
    map.on("mousemove", handleMouseMove);

    return () => {
      map.off("click", interactive, handleClick);
      map.off("mousemove", handleMouseMove);
      map.getCanvasContainer().style.cursor = "";
    };
  }, [mapReady, styleVersion, currentMap, layerVisible, providers, requestImageLoad]);

  return null;
}
