"use client";

import { useTheme } from "@mui/material/styles";
import { categoryPlaceToPlace, PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";
import {
  AMBIENT_LIMITS,
  type AmbientPlace,
  ambientIdentityKeys,
  ambientPlaceContributors,
  ambientPlaceFromTile,
  ambientPlaceToCategoryPlace,
  matchAmbientBasemap,
} from "@openmapx/core/ambient-places";
import { contributorsForRecordFields } from "@openmapx/mobility-core/contributors";
import type {
  ExpressionSpecification,
  FilterSpecification,
  MapGeoJSONFeature,
  MapMouseEvent,
} from "maplibre-gl";
import { useLocale } from "next-intl";
import { useEffect, useMemo, useRef } from "react";
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
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useAmbientPublication } from "./useAmbientPublication";

export const AMBIENT_SOURCE = "ambient-places-source";
export const AMBIENT_LANDMARK_LAYER = "ambient-places-landmarks";
export const AMBIENT_LABEL_LAYER = "ambient-places-labels";
const LAYERS = [AMBIENT_LABEL_LAYER, AMBIENT_LANDMARK_LAYER];
const LANDMARK: ExpressionSpecification = [
  "all",
  [">=", ["get", "rank"], 2500],
  ["<", ["get", "rank"], 2600],
];
function fromFeature(
  feature: Pick<MapGeoJSONFeature, "geometry" | "properties">,
): AmbientPlace | null {
  return feature.geometry.type === "Point"
    ? ambientPlaceFromTile(feature.properties ?? {}, feature.geometry.coordinates)
    : null;
}
export function AmbientPlacesLayer() {
  const dark = useTheme().palette.mode === "dark";
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const locale = useLocale();
  const matchedBasemap = useRef(new Map<string, AmbientPlace>());
  const manifest = useAmbientPublication(env.apiUrl);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: mutable style is invalidated by styleVersion.
  const attributionLayers = useMemo(
    () => [...LAYERS, ...(mapRef.current ? getStylePoiLayerIds(mapRef.current) : [])],
    [mapRef, mapReady, styleVersion],
  );
  useRenderedMapAttributions("overlay-ambient-places", attributionLayers, manifest !== null, {
    resolveFeatureContributors: (feature) => {
      const own = LAYERS.includes(feature.layer.id);
      const place = own
        ? fromFeature(feature)
        : matchedBasemap.current.get(ambientBasemapKey(feature));
      if (
        !place ||
        place.minZoom > Math.floor(mapRef.current?.getZoom() ?? 0) ||
        ambientIdentityKeys(place).some((id) => occupied.has(id))
      )
        return [];
      if (own) return ambientPlaceContributors(place, locale);
      // The actual basemap supplies geometry. The associated ambient identity
      // supplies its clickable name/alias metadata, even when the duplicate is suppressed.
      return place.fieldContributors === undefined
        ? ambientPlaceContributors(place, locale)
        : contributorsForRecordFields(place, [
            place.names[locale.split("-")[0]] ? `names.${locale.split("-")[0]}` : "name",
            "gersId",
          ]);
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: mapReady and styleVersion invalidate cartography read from the mutable mapRef.current style.
  const group = useMemo<MapLayerGroup | null>(() => {
    if (!manifest) return null;
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
  }, [manifest, env.apiUrl, locale, dark, mapRef, mapReady, styleVersion]);
  useMapLayerGroup(group);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dark and styleVersion recreate cartography through the group hook; reinstall suppression immediately after that lifecycle.
  useEffect(() => {
    const map = mapRef.current;
    if (!manifest || !map || !mapReady) return;
    const reconcile = () => {
      if (!map.getSource(AMBIENT_SOURCE) || map.getZoom() < AMBIENT_LIMITS.minZoom) {
        clearAmbientIdentities(map);
        matchedBasemap.current.clear();
        return;
      }
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
        let identity: string | undefined;
        if (osmType !== undefined || osmId !== undefined) {
          if (typeof osmType !== "string" || !/^(node|way|relation)$/.test(osmType)) return [];
          const id =
            typeof osmId === "number" && Number.isSafeInteger(osmId) && osmId > 0
              ? String(osmId)
              : typeof osmId === "string" && /^[1-9]\d*$/.test(osmId)
                ? osmId
                : null;
          // Invalid explicit identity must never become a proximity-based match.
          if (id === null) return [];
          identity = `osm:${osmType}/${id}`;
        }
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
            osmId: identity,
          },
        ];
      });
      const matched = matchAmbientBasemap(
        places.filter(
          (place) =>
            place.minZoom <= Math.floor(map.getZoom()) &&
            !ambientIdentityKeys(place).some((id) => occupied.has(id)),
        ),
        labels,
      );
      matchedBasemap.current = matched;
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
      matchedBasemap.current.clear();
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
      matchedBasemap.current.clear();
      for (const id of LAYERS) INTERACTIVE_LAYER_IDS.delete(id);
    };
  }, [mapRef, mapReady, manifest, locale, occupied, dark, styleVersion]);
  return null;
}
