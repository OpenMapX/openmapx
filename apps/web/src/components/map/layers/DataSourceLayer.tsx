"use client";

import type {
  BoundingBox,
  DataSourceMapContextSelection,
  DataSourceMeta,
  DataSourceResult,
  LngLat,
} from "@openmapx/core";
import {
  applyClientSideFilters,
  createPlace,
  extractSourcePrefix,
  isPointInBBox,
  PANEL,
  splitFilters,
  useDataSourceMapContext,
  useDataSourceSearch,
  useDataSourceStore,
  useDataSources,
  useOpeningHoursStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import type { DataSourceAttribution, IntegrationDataSource } from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePinMarker } from "@/hooks/usePinMarker";
import { translateDataSourceSummary } from "@/lib/dataSourceSummaryI18n";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useRegisterMapAttribution } from "@/lib/mapAttributionStore";
import { createMarkerSvg } from "@/lib/markerSvg";
import { pickHoveredDataSourceItemId } from "./dataSourceHover";
import { getFirstSymbolLayerId } from "./layerStyleUtils";
import { useLayerReanchor } from "./useLayerReanchor";

function sourceId(dsId: string) {
  return `ds-${dsId}`;
}

function markersLayerId(dsId: string) {
  return `ds-${dsId}-markers`;
}

function labelsLayerId(dsId: string) {
  return `ds-${dsId}-labels`;
}

function mapContextSourceId(dsId: string) {
  return `ds-${dsId}-map-context`;
}

function mapContextFillLayerId(dsId: string) {
  return `ds-${dsId}-map-context-fill`;
}

function mapContextOutlineLayerId(dsId: string) {
  return `ds-${dsId}-map-context-outline`;
}

function buildGeoJson(
  results: DataSourceResult[],
  translateSummary: (summary: string | undefined) => string | undefined,
  imageId?: string,
) {
  return {
    type: "FeatureCollection" as const,
    features: results.map((r) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: r.coordinates,
      },
      properties: {
        id: r.id,
        name: r.name,
        source: r.source,
        variant: r.variant,
        status: r.status ?? "",
        summary: translateSummary(r.summary) ?? "",
        operator: r.operator ?? "",
        ...(imageId ? { imageId } : {}),
      },
    })),
  };
}

function manifestSourceToAttribution(ds: IntegrationDataSource): Attribution {
  return {
    sourceId: ds.sourceId,
    name: ds.name,
    url: ds.url,
    spdxLicense: ds.license || undefined,
    licenseUrl: ds.licenseUrl,
    attributionText: ds.attribution,
  };
}

function runtimeAttributionToAttribution(attr: DataSourceAttribution): Attribution {
  return {
    sourceId: attr.text || attr.url,
    name: attr.text,
    url: attr.url,
    spdxLicense: attr.license,
    licenseUrl: attr.licenseUrl,
  };
}

function buildMapContextSelection(results: DataSourceResult[]): DataSourceMapContextSelection {
  const systemIds = new Set<string>();
  const vehicleTypeIds = new Set<string>();

  for (const result of results) {
    for (const systemId of result.mapContext?.systemIds ?? []) {
      systemIds.add(systemId);
    }
    for (const vehicleTypeId of result.mapContext?.vehicleTypeIds ?? []) {
      vehicleTypeIds.add(vehicleTypeId);
    }
  }

  return {
    systemIds: [...systemIds].sort(),
    vehicleTypeIds: [...vehicleTypeIds].sort(),
  };
}

function filterResultsToBbox(
  results: DataSourceResult[],
  bbox: BoundingBox | null,
): DataSourceResult[] {
  if (!bbox) return [];
  return results.filter((result) => isPointInBBox(result.coordinates, bbox));
}

/**
 * Build a MapLibre `match` expression for circle-color using variantColors.
 */
function buildVariantColorExpression(
  markerStyle: DataSourceMeta["markerStyle"],
): maplibregl.ExpressionSpecification {
  const entries = Object.entries(markerStyle.variantColors);
  if (entries.length === 0) return ["literal", markerStyle.defaultColor];

  const expr: unknown[] = ["match", ["get", "variant"]];
  for (const [variant, color] of entries) {
    expr.push(variant, color);
  }
  expr.push(markerStyle.defaultColor);
  return expr as maplibregl.ExpressionSpecification;
}

/**
 * Creates a 64x64 SVG (2x for retina): colored circle with white icon path.
 */

function loadMarkerImage(map: MaplibreMap, imageId: string, iconPath: string, fill: string) {
  if (map.hasImage(imageId)) return;
  const img = new Image(64, 64);
  img.onload = () => {
    if (!map.hasImage(imageId)) map.addImage(imageId, img, { pixelRatio: 2 });
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createMarkerSvg(iconPath, fill))}`;
}

function removeLayers(map: maplibregl.Map, dsId: string) {
  const sid = sourceId(dsId);
  const markers = markersLayerId(dsId);
  const labels = labelsLayerId(dsId);
  const mapContextSid = mapContextSourceId(dsId);
  const mapContextFill = mapContextFillLayerId(dsId);
  const mapContextOutline = mapContextOutlineLayerId(dsId);
  try {
    if (map.getLayer(mapContextOutline)) map.removeLayer(mapContextOutline);
    if (map.getLayer(mapContextFill)) map.removeLayer(mapContextFill);
    if (map.getLayer(labels)) map.removeLayer(labels);
    if (map.getLayer(markers)) map.removeLayer(markers);
    if (map.getSource(mapContextSid)) map.removeSource(mapContextSid);
    if (map.getSource(sid)) map.removeSource(sid);
  } catch {
    // Source may already be torn down
  }
}

export function DataSourceLayer() {
  const t = useTranslations("dataSources");
  const { mapRef, mapReady, styleVersion } = useMap();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const filters = useDataSourceStore((s) => s.filters);
  const selectItem = useDataSourceStore((s) => s.selectItem);
  const searchBbox = useDataSourceStore((s) => s.searchBbox);
  const viewportBbox = useDataSourceStore((s) => s.viewportBbox);
  const viewportZoom = useDataSourceStore((s) => s.viewportZoom);
  const setViewport = useDataSourceStore((s) => s.setViewport);
  const setSearchBbox = useDataSourceStore((s) => s.setSearchBbox);
  const setMapMoved = useDataSourceStore((s) => s.setMapMoved);
  const hoveredItemId = useDataSourceStore((s) => s.hoveredItemId);
  const setHoveredItemId = useDataSourceStore((s) => s.setHoveredItemId);
  const reanchorIds = useMemo(
    () => (activeSource ? [markersLayerId(activeSource)] : []),
    [activeSource],
  );
  useLayerReanchor(reanchorIds, activeSource !== null);

  // Register this source's layers in the shared interactive-layer registry so
  // MapStylePoiClickHandler (and MapClickHandler) know to defer to our own handlers.
  useEffect(() => {
    if (!activeSource) return;
    const markersLid = markersLayerId(activeSource);
    const labelsLid = labelsLayerId(activeSource);
    INTERACTIVE_LAYER_IDS.add(markersLid);
    INTERACTIVE_LAYER_IDS.add(labelsLid);
    return () => {
      INTERACTIVE_LAYER_IDS.delete(markersLid);
      INTERACTIVE_LAYER_IDS.delete(labelsLid);
    };
  }, [activeSource]);

  const openingHoursFilter = useOpeningHoursStore((s) => s.openingHoursFilter);

  const { data: sourcesData } = useDataSources();
  const prevSourceRef = useRef<string | null>(null);

  // Find meta for the active source
  const activeMeta = useMemo(() => {
    if (!activeSource || !sourcesData?.sources) return null;
    return sourcesData.sources.find((s) => s.id === activeSource) ?? null;
  }, [activeSource, sourcesData]);

  const registry = useIntegrationRegistry();

  // Separate server-side filters (sent to the API) from client-side filters
  // (applied locally on the result set). Uses the `clientSide` flag from
  // provider filter definitions instead of a hardcoded list.
  const serverFilters = useMemo(
    () => splitFilters(filters, activeMeta?.filters ?? []).serverFilters,
    [filters, activeMeta?.filters],
  );

  // Only fetch if zoom >= minZoom, using searchBbox (not viewportBbox)
  const shouldFetch =
    activeSource !== null &&
    searchBbox !== null &&
    (activeMeta ? viewportZoom >= activeMeta.minZoom : true);

  const { data: searchResults } = useDataSourceSearch(
    shouldFetch ? activeSource : null,
    shouldFetch ? searchBbox : null,
    serverFilters,
  );

  // Apply client-side filters (speed, operator, opening hours) to the search
  // results from React Query. No manual accumulation — React Query is the
  // single source of truth and handles caching/staleness.
  const filteredResults = useMemo(
    () => applyClientSideFilters(searchResults ?? [], filters, openingHoursFilter),
    [searchResults, filters, openingHoursFilter],
  );

  const visibleResults = useMemo(
    () => filterResultsToBbox(filteredResults, viewportBbox),
    [filteredResults, viewportBbox],
  );

  const mapContextSelection = useMemo(
    () => buildMapContextSelection(filteredResults),
    [filteredResults],
  );

  const shouldFetchMapContext = shouldFetch && viewportBbox !== null;

  const { data: mapContext } = useDataSourceMapContext(
    shouldFetchMapContext ? activeSource : null,
    shouldFetchMapContext ? viewportBbox : null,
    serverFilters,
    mapContextSelection,
  );

  // Build the Attribution[] contribution for the React-driven attribution
  // strip from the sources actually present in visible results. The strip
  // dedupes by `sourceId`, so order matters: manifest-curated entries first,
  // then runtime/per-result attributions.
  const layerAttributions = useMemo<Attribution[]>(() => {
    if (!activeSource || visibleResults.length === 0) return [];
    const meta = registry.get(activeSource);
    const dataSources = meta?.dataSources ?? [];
    const visiblePrefixes = new Set(
      visibleResults
        .flatMap((result) => result.sources ?? [result.source])
        .map((s) => extractSourcePrefix(s)),
    );
    const manifest = dataSources
      .filter((ds) => !ds.dynamic && visiblePrefixes.has(ds.sourceId))
      .map(manifestSourceToAttribution);
    const fallback =
      manifest.length === 0
        ? dataSources.filter((ds) => !ds.dynamic).map(manifestSourceToAttribution)
        : [];
    const runtime = visibleResults
      .flatMap((result) => result.attributions ?? [])
      .map(runtimeAttributionToAttribution);
    return [...manifest, ...fallback, ...runtime];
  }, [activeSource, registry, visibleResults]);

  useRegisterMapAttribution(activeSource ? `data-source:${activeSource}` : null, layerAttributions);

  // Show pin marker for hovered item
  const hoveredResult = filteredResults.find((r) => r.id === hoveredItemId) ?? null;
  usePinMarker(hoveredResult?.coordinates ?? null, hoveredResult?.name ?? "");

  // Track whether we've set the initial searchBbox
  const initialBboxSetRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSource is an intentional trigger
  useEffect(() => {
    initialBboxSetRef.current = false;
  }, [activeSource]);

  // Viewport tracking
  const handleMoveEnd = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const bounds = map.getBounds();
    const bbox = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    };
    const zoom = map.getZoom();

    setViewport(bbox, zoom);

    if (!initialBboxSetRef.current) {
      initialBboxSetRef.current = true;
      setSearchBbox(bbox);
    } else {
      setMapMoved(true);
    }
  }, [mapRef, setViewport, setSearchBbox, setMapMoved]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !activeSource) return;

    handleMoveEnd();

    map.on("moveend", handleMoveEnd);
    return () => {
      map.off("moveend", handleMoveEnd);
    };
  }, [mapReady, mapRef, styleVersion, activeSource, handleMoveEnd]);

  // Clean up layers when activeSource changes
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const prevSource = prevSourceRef.current;
    if (prevSource && prevSource !== activeSource) {
      removeLayers(map, prevSource);
    }
    prevSourceRef.current = activeSource;
  }, [activeSource, mapReady, styleVersion, mapRef]);

  // Sync GeoJSON source + layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      if (!activeSource || !activeMeta) {
        if (activeSource) removeLayers(map, activeSource);
        return;
      }

      const sid = sourceId(activeSource);
      const markersLid = markersLayerId(activeSource);
      const mapContextSid = mapContextSourceId(activeSource);
      const mapContextFillLid = mapContextFillLayerId(activeSource);
      const mapContextOutlineLid = mapContextOutlineLayerId(activeSource);

      if (viewportZoom < activeMeta.minZoom) {
        removeLayers(map, activeSource);
        return;
      }

      const useIconMarkers = activeMeta.markerStyle.type === "icon";
      const imageId = useIconMarkers ? `ds-marker-${activeSource}` : undefined;
      const geojson = buildGeoJson(
        filteredResults,
        (summary) => translateDataSourceSummary(summary, t),
        imageId,
      );

      if (map.getSource(sid)) {
        (map.getSource(sid) as GeoJSONSource).setData(geojson);
      } else {
        map.addSource(sid, {
          type: "geojson",
          data: geojson,
        });
      }

      const beforeLayer = getFirstSymbolLayerId(map);
      const mapContextData = mapContext?.geojson;
      if (mapContextData && mapContextData.features.length > 0) {
        if (map.getSource(mapContextSid)) {
          (map.getSource(mapContextSid) as GeoJSONSource).setData(mapContextData);
        } else {
          map.addSource(mapContextSid, {
            type: "geojson",
            data: mapContextData,
          });
        }

        if (!map.getLayer(mapContextFillLid)) {
          map.addLayer(
            {
              id: mapContextFillLid,
              type: "fill",
              source: mapContextSid,
              paint: {
                "fill-color": [
                  "match",
                  ["get", "zoneClass"],
                  "no_ride",
                  "#C62828",
                  "no_parking",
                  "#EF6C00",
                  "no_start",
                  "#8E24AA",
                  "slow_zone",
                  "#1565C0",
                  "parking_hub",
                  "#2E7D32",
                  "#546E7A",
                ] as unknown as maplibregl.ExpressionSpecification,
                "fill-opacity": [
                  "match",
                  ["get", "zoneClass"],
                  "no_ride",
                  0.16,
                  "no_parking",
                  0.12,
                  "no_start",
                  0.1,
                  "slow_zone",
                  0.08,
                  "parking_hub",
                  0.08,
                  0.08,
                ] as unknown as maplibregl.ExpressionSpecification,
              },
            },
            beforeLayer,
          );
        }

        if (!map.getLayer(mapContextOutlineLid)) {
          map.addLayer(
            {
              id: mapContextOutlineLid,
              type: "line",
              source: mapContextSid,
              paint: {
                "line-color": [
                  "match",
                  ["get", "zoneClass"],
                  "no_ride",
                  "#C62828",
                  "no_parking",
                  "#EF6C00",
                  "no_start",
                  "#8E24AA",
                  "slow_zone",
                  "#1565C0",
                  "parking_hub",
                  "#2E7D32",
                  "#546E7A",
                ] as unknown as maplibregl.ExpressionSpecification,
                "line-width": [
                  "match",
                  ["get", "zoneClass"],
                  "no_ride",
                  2.5,
                  "no_parking",
                  2.25,
                  "no_start",
                  2,
                  "slow_zone",
                  2,
                  "parking_hub",
                  2.25,
                  2,
                ] as unknown as maplibregl.ExpressionSpecification,
                "line-opacity": 0.85,
              },
            },
            beforeLayer,
          );
        }
      } else {
        if (map.getLayer(mapContextOutlineLid)) map.removeLayer(mapContextOutlineLid);
        if (map.getLayer(mapContextFillLid)) map.removeLayer(mapContextFillLid);
        if (map.getSource(mapContextSid)) map.removeSource(mapContextSid);
      }

      if (useIconMarkers && imageId) {
        // Icon marker mode: symbol layer with SVG icon + text label layer
        loadMarkerImage(
          map,
          imageId,
          activeMeta.markerStyle.iconPath,
          activeMeta.markerStyle.defaultColor,
        );

        if (!map.getLayer(markersLid)) {
          map.addLayer({
            id: markersLid,
            type: "symbol",
            source: sid,
            layout: {
              "icon-image": ["literal", imageId],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });
        }

        const labelsLid = labelsLayerId(activeSource);
        if (!map.getLayer(labelsLid)) {
          // Label zoom thresholds scale with minZoom to avoid clutter on dense layers
          const nameZoom = Math.max(11, activeMeta.minZoom + 2);
          const summaryZoom = nameZoom + 2;

          map.addLayer({
            id: labelsLid,
            type: "symbol",
            source: sid,
            minzoom: nameZoom,
            layout: {
              "text-field": [
                "step",
                ["zoom"],
                ["get", "name"],
                summaryZoom,
                [
                  "case",
                  ["!=", ["get", "summary"], ""],
                  ["concat", ["get", "name"], "\n", ["get", "summary"]],
                  ["get", "name"],
                ],
              ] as unknown as maplibregl.ExpressionSpecification,
              "text-size": 11,
              "text-offset": [0, 2.0] as [number, number],
              "text-anchor": "top",
              "text-max-width": 8,
              "text-optional": true,
            },
            paint: {
              "text-color": "#333333",
              "text-halo-color": "#FFFFFF",
              "text-halo-width": 1.5,
            },
          });
        }
      } else {
        // Circle marker mode (default, e.g. EV charging)
        if (!map.getLayer(markersLid)) {
          const colorExpr = buildVariantColorExpression(activeMeta.markerStyle);

          map.addLayer(
            {
              id: markersLid,
              type: "circle",
              source: sid,
              paint: {
                "circle-radius": 6,
                "circle-color": colorExpr,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 1.5,
                "circle-opacity": [
                  "case",
                  ["==", ["get", "status"], "non-operational"],
                  activeMeta.markerStyle.inactiveOpacity,
                  1,
                ],
                "circle-stroke-opacity": [
                  "case",
                  ["==", ["get", "status"], "non-operational"],
                  activeMeta.markerStyle.inactiveOpacity,
                  1,
                ],
              },
            },
            beforeLayer,
          );
        }
      }
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [
    activeSource,
    activeMeta,
    filteredResults,
    viewportZoom,
    mapReady,
    styleVersion,
    mapRef,
    mapContext,
    t,
  ]);

  const { setSelectedPlace } = usePlaceStore();

  // Click + cursor handlers — bind to both markers and labels layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !activeSource) return;

    const markersLid = markersLayerId(activeSource);
    const labelsLid = labelsLayerId(activeSource);
    const currentSource = activeSource;

    const onClick = (e: MapMouseEvent) => {
      // Query both markers and labels layers
      const layers = [markersLid, labelsLid].filter((l) => map.getLayer(l));
      const features = map.queryRenderedFeatures(e.point, { layers });
      if (!features.length) return;
      const props = features[0].properties as { id: string; name: string; summary?: string };
      const coords = (features[0].geometry as { coordinates: number[] }).coordinates as LngLat;
      selectItem(currentSource, props.id);
      // Set a preview place immediately so the floating card shows without waiting for detail API
      setSelectedPlace(
        createPlace({
          primaryScheme: currentSource,
          ids: { [currentSource]: props.id },
          name: props.name,
          address: props.name,
          coordinates: coords,
          category: activeMeta?.placeCategory,
          rawCategory: activeMeta?.placeCategoryRaw,
        }),
      );
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    };

    const onMouseMove = (e: MapMouseEvent) => {
      const layers = [markersLid, labelsLid].filter((id) => !!map.getLayer(id));
      if (layers.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
        setHoveredItemId(pickHoveredDataSourceItemId(features, markersLid));
      } else {
        map.getCanvasContainer().style.cursor = "";
        setHoveredItemId(null);
      }
    };

    // Bind to markers layer
    map.on("click", markersLid, onClick);

    // Also bind to labels layer (for icon mode) — MapLibre no-ops on nonexistent layers
    map.on("click", labelsLid, onClick);

    map.on("mousemove", onMouseMove);

    return () => {
      map.off("click", markersLid, onClick);
      map.off("click", labelsLid, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      setHoveredItemId(null);
    };
  }, [
    activeSource,
    activeMeta,
    mapReady,
    styleVersion,
    mapRef,
    selectItem,
    setSelectedPlace,
    setHoveredItemId,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const map = mapRef.current;
      if (!map) return;
      const src = prevSourceRef.current;
      if (src) removeLayers(map, src);
    };
  }, [mapRef]);

  return null;
}
