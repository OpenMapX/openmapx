"use client";

import { useTheme } from "@mui/material/styles";
import { categoryPlaceToPlace, PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";
import {
  AMBIENT_LIMITS,
  AMBIENT_MAX_AGE_MS,
  type AmbientManifest,
  type AmbientPlace,
  ambientIdentityKeys,
  ambientPlaceFromTile,
  ambientPlaceToCategoryPlace,
  matchAmbientBasemap,
} from "@openmapx/core/ambient-places";
import type {
  ExpressionSpecification,
  FilterSpecification,
  MapGeoJSONFeature,
  MapMouseEvent,
} from "maplibre-gl";
import { useLocale } from "next-intl";
import { useEffect, useMemo } from "react";
import {
  ambientBasemapKey,
  ambientPlaceStyle,
  clearAmbientIdentities,
  getStylePoiLayerIds,
  setAmbientIdentities,
  useActivePlaceResults,
} from "@/integration-api/map/ambientPlaces";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import type { MapLayerGroup, SlottedLayer } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useSourceAttributions } from "@/integration-api/overlay/useIntegrationAttribution";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import integrationManifest from "./manifest.json";
import { useAmbientPlacesStore } from "./store";

export const AMBIENT_SOURCE = "ambient-places-source";
export const AMBIENT_LANDMARK_LAYER = "ambient-places-landmarks";
export const AMBIENT_LABEL_LAYER = "ambient-places-labels";
const LAYERS = [AMBIENT_LABEL_LAYER, AMBIENT_LANDMARK_LAYER];
const LANDMARK: ExpressionSpecification = [
  "all",
  [">=", ["get", "rank"], 2500],
  ["<", ["get", "rank"], 2600],
];
const OSM_SOURCES = ["osm-ambient-places"];
const COMBINED_SOURCES = integrationManifest.dataSources.map((source) => source.sourceId);
const NO_SOURCES: string[] = [];
function fromFeature(
  feature: Pick<MapGeoJSONFeature, "geometry" | "properties">,
): AmbientPlace | null {
  return feature.geometry.type === "Point"
    ? ambientPlaceFromTile(feature.properties ?? {}, feature.geometry.coordinates)
    : null;
}
function usable(manifest: AmbientManifest | null): boolean {
  return Boolean(
    manifest?.enabled &&
      [
        manifest.publishedAt,
        manifest.sources.osm.publishedAt,
        ...(manifest.sources.overture ? [manifest.sources.overture.publishedAt] : []),
      ].every(
        (date) =>
          Number.isFinite(Date.parse(date)) && Date.now() - Date.parse(date) <= AMBIENT_MAX_AGE_MS,
      ),
  );
}
export function AmbientPlacesLayer() {
  const dark = useTheme().palette.mode === "dark";
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const locale = useLocale();
  const shown = useAmbientPlacesStore((s) => s.panelOpen && s.layerVisible);
  const manifest = useAmbientPlacesStore((s) => s.manifest);
  const publication = useAmbientPlacesStore((s) => s.setPublication);
  const selected = usePlaceStore((s) => s.selectedPlace);
  const { filtered } = useActivePlaceResults(locale);
  const occupied = useMemo(
    () =>
      new Set([
        ...(filtered ?? []).flatMap(ambientIdentityKeys),
        ...(selected ? ambientIdentityKeys(selected) : []),
      ]),
    [filtered, selected],
  );

  useEffect(() => {
    if (!shown) return;
    let current = true;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const existing = useAmbientPlacesStore.getState().manifest;
      publication(existing, false, true);
      try {
        const response = await fetch(`${env.apiUrl}/api/ambient-places/manifest`, {
          signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Publication unavailable");
        const body = (await response.json()) as { manifest: AmbientManifest | null };
        if (
          body.manifest &&
          (body.manifest.version !== 1 ||
            !body.manifest.generation ||
            !body.manifest.region?.bounds ||
            !body.manifest.sources?.osm)
        )
          throw new Error("Unsupported publication");
        if (current && !signal.aborted) publication(body.manifest, false, false);
      } catch {
        if (current && !signal.aborted)
          publication(usable(existing) ? existing : null, true, false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      current = false;
      controller?.abort();
      clearInterval(timer);
    };
  }, [shown, env.apiUrl, publication]);

  const visible = shown && usable(manifest);
  useSourceAttributions(
    "overlay-ambient-places",
    visible ? (manifest?.sources.overture ? COMBINED_SOURCES : OSM_SOURCES) : NO_SOURCES,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: mapReady and styleVersion invalidate cartography read from the mutable mapRef.current style.
  const group = useMemo<MapLayerGroup | null>(() => {
    if (!visible || !manifest) return null;
    return {
      sources: {
        [AMBIENT_SOURCE]: {
          type: "vector",
          tiles: [`${env.apiUrl}/api/ambient-places/tiles/${manifest.generation}/{z}/{x}/{y}.mvt`],
          bounds: manifest.region.bounds,
          minzoom: AMBIENT_LIMITS.minZoom,
          maxzoom: AMBIENT_LIMITS.maxZoom,
        },
      },
      layers: LAYERS.map<SlottedLayer>((id) => {
        const landmark = id === AMBIENT_LANDMARK_LAYER;
        const style = ambientPlaceStyle(mapRef.current?.getStyle()?.layers ?? [], landmark, dark);
        return {
          id,
          type: "symbol" as const,
          source: AMBIENT_SOURCE,
          "source-layer": "ambient_places",
          minzoom: 13,
          slot: "overlay-markers" as const,
          order: landmark ? 36 : 35,
          filter: landmark ? LANDMARK : ["!", LANDMARK],
          layout: {
            ...style.layout,
            "text-field": ["coalesce", ["get", `name_${locale.split("-")[0]}`], ["get", "name"]],
            "symbol-sort-key": ["-", ["get", "rank"]],
          },
          paint: style.paint,
        };
      }),
    };
  }, [visible, manifest, env.apiUrl, locale, dark, mapRef, mapReady, styleVersion]);
  useMapLayerGroup(group);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dark and styleVersion recreate cartography through the group hook; reinstall suppression immediately after that lifecycle.
  useEffect(() => {
    const map = mapRef.current;
    if (!visible || !manifest || !map || !mapReady) return;
    const reconcile = () => {
      if (!map.getSource(AMBIENT_SOURCE)) return;
      const unique = new Map<string, AmbientPlace>();
      for (const feature of map.querySourceFeatures(AMBIENT_SOURCE, {
        sourceLayer: "ambient_places",
      })) {
        const p = fromFeature(feature);
        if (p) unique.set(p.id, p);
      }
      const places = [...unique.values()];
      const basemapLayers = getStylePoiLayerIds(map).filter((id) => map.getLayer(id));
      const features = basemapLayers.length
        ? map.queryRenderedFeatures(undefined, { layers: basemapLayers })
        : [];
      const labels = features.flatMap((feature) => {
        if (feature.geometry.type !== "Point") return [];
        const name =
          feature.properties?.[`name:${locale.split("-")[0]}`] ?? feature.properties?.name;
        if (typeof name !== "string") return [];
        const osmType = feature.properties?.osm_type;
        const osmId = feature.properties?.osm_id;
        return [
          {
            key: ambientBasemapKey(feature),
            name,
            coordinates: feature.geometry.coordinates as [number, number],
            // Worship subclasses describe religion, not the destination category.
            category: String(
              feature.properties?.class === "place_of_worship"
                ? feature.properties.class
                : (feature.properties?.subclass ?? feature.properties?.class ?? ""),
            ),
            osmId:
              typeof osmId === "string" && /^(node|way|relation)$/.test(osmType)
                ? `osm:${osmType}/${osmId}`
                : undefined,
          },
        ];
      });
      const matched = matchAmbientBasemap(places, labels);
      setAmbientIdentities(
        map,
        new Map([...matched].map(([key, p]) => [key, ambientPlaceToCategoryPlace(p, locale)])),
      );
      const hidden = new Set([...matched.values()].map((p) => p.id));
      for (const p of places)
        if (ambientIdentityKeys(p).some((id) => occupied.has(id))) hidden.add(p.id);
      const filter: ExpressionSpecification = [
        "all",
        ["<=", ["get", "min_zoom"], Math.floor(map.getZoom())],
        ["!", ["in", ["get", "id"], ["literal", [...hidden].sort()]]],
      ];
      // Descriptor/theme reconciliation can recreate one layer without a
      // style.load. Compare each live layer so its suppression is restored.
      for (const id of LAYERS) {
        const partition: FilterSpecification = [
          "all",
          filter,
          id === AMBIENT_LANDMARK_LAYER ? LANDMARK : ["!", LANDMARK],
        ];
        if (map.getLayer(id) && JSON.stringify(map.getFilter(id)) !== JSON.stringify(partition))
          map.setFilter(id, partition);
      }
    };
    const click = (event: MapMouseEvent) => {
      if (getMapClickOwner(event)) return;
      const target = event.originalEvent?.target;
      if (target instanceof Element && target.closest("[data-openmapx-pin-marker]")) return;
      const live = LAYERS.filter((id) => map.getLayer(id));
      if (!live.length) return;
      // Basemap clicks already defer to ambient features. Keep that direction
      // while category/data-source markers and DOM pins retain higher priority.
      const basemapLayers = getStylePoiLayerIds(map);
      const priorityLayers = [...INTERACTIVE_LAYER_IDS].filter(
        (id) => !LAYERS.includes(id) && !basemapLayers.includes(id) && map.getLayer(id),
      );
      if (
        priorityLayers.length &&
        map.queryRenderedFeatures(event.point, { layers: priorityLayers }).length
      )
        return;
      const feature = map.queryRenderedFeatures(event.point, { layers: live })[0];
      const place = feature ? fromFeature(feature) : null;
      if (!place) return;
      usePlaceStore
        .getState()
        .setSelectedPlace(categoryPlaceToPlace(ambientPlaceToCategoryPlace(place, locale)));
      const sidebar = useSidebarStore.getState();
      if (!sidebar.activeSidebarId || sidebar.activeSidebarId === PANEL.PLACE) {
        sidebar.closeDetail();
        sidebar.openSidebar(PANEL.PLACE);
      } else sidebar.openDetail(PANEL.PLACE_CARD);
    };
    const style = () => {
      clearAmbientIdentities(map);
    };
    for (const id of LAYERS) INTERACTIVE_LAYER_IDS.add(id);
    map.on("idle", reconcile);
    map.on("zoomend", reconcile);
    map.on("style.load", style);
    map.on("click", click);
    reconcile();
    return () => {
      map.off("idle", reconcile);
      map.off("zoomend", reconcile);
      map.off("style.load", style);
      map.off("click", click);
      clearAmbientIdentities(map);
      for (const id of LAYERS) INTERACTIVE_LAYER_IDS.delete(id);
    };
  }, [mapRef, mapReady, visible, manifest, locale, occupied, dark, styleVersion]);
  return null;
}
