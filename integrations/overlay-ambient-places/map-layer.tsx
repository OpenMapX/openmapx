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
import type { FilterSpecification, MapGeoJSONFeature, MapMouseEvent } from "maplibre-gl";
import { useLocale } from "next-intl";
import { useEffect, useMemo } from "react";
import {
  ambientBasemapKey,
  clearAmbientIdentities,
  getStylePoiLayerIds,
  setAmbientIdentities,
  useActivePlaceResults,
} from "@/integration-api/map/ambientPlaces";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useIntegrationAttribution } from "@/integration-api/overlay/useIntegrationAttribution";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useAmbientPlacesStore } from "./store";

export const AMBIENT_SOURCE = "ambient-places-source";
export const AMBIENT_POINT_LAYER = "ambient-places-points";
export const AMBIENT_LABEL_LAYER = "ambient-places-labels";
const LAYERS = [AMBIENT_POINT_LAYER, AMBIENT_LABEL_LAYER];
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
  const { mapRef, mapReady } = useMap();
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
  useIntegrationAttribution("overlay-ambient-places", visible);
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
      layers: [
        {
          id: AMBIENT_POINT_LAYER,
          type: "circle",
          source: AMBIENT_SOURCE,
          "source-layer": "ambient_places",
          minzoom: 13,
          slot: "overlay-markers",
          order: 35,
          paint: {
            "circle-radius": 3,
            "circle-color": "#287e79",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1,
          },
        },
        {
          id: AMBIENT_LABEL_LAYER,
          type: "symbol",
          source: AMBIENT_SOURCE,
          "source-layer": "ambient_places",
          minzoom: 13,
          slot: "overlay-markers",
          order: 36,
          layout: {
            "text-field": ["coalesce", ["get", `name_${locale.split("-")[0]}`], ["get", "name"]],
            "text-font": ["Noto Sans Regular"],
            "text-size": 11,
            "text-anchor": "left",
            "text-offset": [0.6, 0],
            "symbol-sort-key": ["-", ["get", "rank"]],
            "text-allow-overlap": false,
            "text-ignore-placement": false,
            "text-max-width": 12,
          },
          paint: {
            "text-color": dark ? "#a5dcd7" : "#17635e",
            "text-halo-color": dark ? "#1c222b" : "#ffffff",
            "text-halo-width": 1.5,
          },
        },
      ],
    };
  }, [visible, manifest, env.apiUrl, locale, dark]);
  useMapLayerGroup(group);

  useEffect(() => {
    const map = mapRef.current;
    if (!visible || !manifest || !map || !mapReady) return;
    let lastFilter = "";
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
            category: String(feature.properties?.subclass ?? feature.properties?.class ?? ""),
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
      const filter: FilterSpecification = [
        "all",
        ["<=", ["get", "min_zoom"], Math.floor(map.getZoom())],
        ["!", ["in", ["get", "id"], ["literal", [...hidden].sort()]]],
      ];
      const key = JSON.stringify(filter);
      if (key === lastFilter) return;
      lastFilter = key;
      for (const id of LAYERS) if (map.getLayer(id)) map.setFilter(id, filter);
    };
    const click = (event: MapMouseEvent) => {
      if (getMapClickOwner(event)) return;
      const live = LAYERS.filter((id) => map.getLayer(id));
      if (!live.length) return;
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
      lastFilter = "";
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
  }, [mapRef, mapReady, visible, manifest, locale, occupied]);
  return null;
}
