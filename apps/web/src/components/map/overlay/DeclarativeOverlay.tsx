"use client";

import {
  integrationIdToOverlayId,
  useDebouncedCallback,
  useOverlayExclusion,
} from "@openmapx/core";
import type { IntegrationOverlay, LoadedIntegrationMeta } from "@openmapx/integration-framework";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useCallback, useEffect, useMemo } from "react";
import {
  getFirstSymbolLayerId,
  removeLayerAndSource,
} from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import {
  buildOverlaySourceUrl,
  buildPopupHtml,
  namespacedLayerId,
  namespacedSourceId,
} from "./overlaySpec";
import { useOverlayLayerVisible } from "./useOverlayStoreState";

type AddLayerObject = Parameters<maplibregl.Map["addLayer"]>[0];
type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

/**
 * Renders a community/declarative map overlay entirely from its manifest
 * `frontend.overlay` spec — no integration-shipped frontend code. The host owns
 * the lifecycle: add/remove source + layers, reanchor below labels on style
 * swap, bbox-driven refetch, click popups, interactive registration,
 * attribution, and cleanup. Built-in overlays that need imperative logic still
 * ship their own `map-layer.tsx`; this is the zero-code path.
 */
export function DeclarativeOverlay({ integration }: { integration: LoadedIntegrationMeta }) {
  const overlay = integration.frontend?.overlay;
  if (!overlay?.source) return null;
  return <DeclarativeOverlayInner integration={integration} overlay={overlay} />;
}

function DeclarativeOverlayInner({
  integration,
  overlay,
}: {
  integration: LoadedIntegrationMeta;
  overlay: IntegrationOverlay;
}) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { apiUrl } = useEnv();
  const overlayId = integrationIdToOverlayId(integration.id);
  const layerVisible = useOverlayLayerVisible(overlayId);

  // `source` is guaranteed by the parent guard; the manifest is stable per mount.
  const source = overlay.source as NonNullable<IntegrationOverlay["source"]>;
  const layers = useMemo(() => overlay.layers ?? [], [overlay]);
  const popup = overlay.popup;
  const sourceId = useMemo(() => namespacedSourceId(integration.id), [integration.id]);
  const layerIds = useMemo(
    () => layers.map((l) => namespacedLayerId(integration.id, l.id)),
    [layers, integration.id],
  );

  useIntegrationAttribution(integration.id, layerVisible);
  useOverlayExclusion(overlayId, layerVisible);
  useLayerReanchor(layerIds, layerVisible);

  const fetchData = useCallback(async () => {
    const map = mapRef.current;
    if (!map || source.kind === "vector") return;
    const b = map.getBounds();
    const url = buildOverlaySourceUrl(apiUrl, integration.id, source, {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    });
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as GeoJsonData;
      const src = map.getSource(sourceId) as GeoJSONSource | undefined;
      if (src) src.setData(data);
    } catch {
      // Silent fetch failure — overlay stays empty.
    }
  }, [apiUrl, integration.id, source, sourceId, mapRef]);

  // Add/remove the source + layers, re-attaching after a style swap.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const sync = () => {
      if (!layerVisible) {
        removeLayerAndSource(map, [...layerIds].reverse(), sourceId);
        return;
      }
      if (!map.isStyleLoaded()) {
        map.once("idle", sync);
        return;
      }

      if (!map.getSource(sourceId)) {
        if (source.kind === "vector") {
          map.addSource(sourceId, { type: "vector", tiles: source.tiles ?? [] });
        } else {
          map.addSource(sourceId, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
      }

      const before = getFirstSymbolLayerId(map);
      for (const layer of layers) {
        const id = namespacedLayerId(integration.id, layer.id);
        if (map.getLayer(id)) continue;
        const def = {
          id,
          type: layer.type,
          source: sourceId,
          ...(source.kind === "vector"
            ? { "source-layer": layer.sourceLayer ?? source.sourceLayer }
            : {}),
          ...(layer.paint ? { paint: layer.paint } : {}),
          ...(layer.layout ? { layout: layer.layout } : {}),
          ...(layer.filter ? { filter: layer.filter } : {}),
          ...(layer.minzoom != null ? { minzoom: layer.minzoom } : {}),
          ...(layer.maxzoom != null ? { maxzoom: layer.maxzoom } : {}),
        } as unknown as AddLayerObject;
        map.addLayer(def, before);
        if (layer.interactive) INTERACTIVE_LAYER_IDS.add(id);
      }

      if (source.kind !== "vector") void fetchData();
    };

    sync();
    map.on("styledata", sync);
    return () => {
      map.off("styledata", sync);
    };
  }, [
    mapReady,
    styleVersion,
    mapRef,
    layerVisible,
    layers,
    source,
    sourceId,
    layerIds,
    fetchData,
    integration.id,
  ]);

  // bbox-driven refetch on pan/zoom.
  const debouncedFetch = useDebouncedCallback(() => fetchData(), 800);
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible || source.kind !== "geojson-bbox") return;
    map.on("moveend", debouncedFetch);
    return () => {
      map.off("moveend", debouncedFetch);
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, source, debouncedFetch]);

  // Declarative click popup on interactive layers.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible || !popup) return;
    const interactiveIds = layers
      .filter((l) => l.interactive)
      .map((l) => namespacedLayerId(integration.id, l.id));
    if (interactiveIds.length === 0) return;

    let activePopup: maplibregl.Popup | null = null;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const geom = f.geometry;
      const coords: [number, number] =
        geom?.type === "Point"
          ? (geom.coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat];
      activePopup?.remove();
      activePopup = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "280px",
        className: "omx-popup",
      })
        .setLngLat(coords)
        .setHTML(buildPopupHtml(popup, props))
        .addTo(map);
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      const hit = map.queryRenderedFeatures(e.point, { layers: interactiveIds });
      map.getCanvasContainer().style.cursor = hit.length > 0 ? "pointer" : "";
    };

    for (const id of interactiveIds) map.on("click", id, onClick);
    map.on("mousemove", onMouseMove);

    return () => {
      for (const id of interactiveIds) map.off("click", id, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      activePopup?.remove();
    };
  }, [mapReady, styleVersion, mapRef, layerVisible, popup, layers, integration.id]);

  // Teardown on unmount: drop layers/source and deregister interactive ids.
  useEffect(() => {
    return () => {
      const map = mapRef.current;
      if (map) removeLayerAndSource(map, [...layerIds].reverse(), sourceId);
      for (const id of layerIds) INTERACTIVE_LAYER_IDS.delete(id);
    };
  }, [mapRef, layerIds, sourceId]);

  return null;
}
