"use client";

import type { StreetLevelCapabilities } from "@openmapx/core";
import { useOverlayExclusion, useStreetLevelStore } from "@openmapx/core";
import type { FilterSpecification, MapLayerMouseEvent, MapMouseEvent } from "maplibre-gl";
import { useEffect } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useIntegrationDomainAttribution } from "@/lib/useIntegrationAttribution";
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
  const { apiUrl } = useEnv();
  const { providers } = useStreetLevelProviders();
  const layerVisible = useStreetLevelStore((s) => s.layerVisible);
  const requestImageLoad = useStreetLevelStore((s) => s.requestImageLoad);

  useOverlayExclusion("street-level-imagery", layerVisible);

  // Credits every visible street-level-imagery integration at once. The per-integration
  // helper can't express this because one layer now serves several providers,
  // and CC-BY-SA / Licence Ouverte imagery must be credited when displayed.
  useIntegrationDomainAttribution("street-level-imagery", layerVisible);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let disposed = false;

    const syncLayers = () => {
      // A deferred `once("idle")` callback can outlive this effect (toggle on
      // while the style is busy, then toggle off). Without this guard it would
      // re-add every source and layer with no handlers attached.
      if (disposed) return;

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

      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayers);
        return;
      }

      for (const provider of providers) {
        const coverage = provider.coverage;
        if (coverage.kind !== "mvt") continue;

        const sourceId = coverageSourceId(provider.id);
        const ids = coverageLayerIds(provider.id);

        if (!map.getSource(sourceId)) {
          map.addSource(sourceId, {
            type: "vector",
            tiles: [`${apiUrl}${coverage.tileUrlTemplate}`],
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

    syncLayers();
    if (!layerVisible) {
      return () => {
        disposed = true;
      };
    }

    map.on("styledata", syncLayers);
    return () => {
      disposed = true;
      map.off("styledata", syncLayers);
      map.off("idle", syncLayers);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, providers, apiUrl]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    // Bind unconditionally rather than filtering by `map.getLayer(id)` here:
    // layer creation is deferred to `once("idle")` whenever the style is still
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
  }, [mapReady, styleVersion, mapRef, layerVisible, providers, requestImageLoad]);

  return null;
}
