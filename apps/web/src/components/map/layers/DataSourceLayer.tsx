"use client";

import type { DataSourceMeta, DataSourceResult, LngLat } from "@openmapx/core";
import {
  applyClientSideFilters,
  buildSourceAttribution,
  PANEL,
  splitFilters,
  useDataSourceSearch,
  useDataSourceStore,
  useDataSources,
  useIntegrationRegistry,
  useOpeningHoursStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePinMarker } from "@/hooks/usePinMarker";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { createMarkerSvg } from "@/lib/markerSvg";
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

function buildGeoJson(results: DataSourceResult[], attributionHtml: string, imageId?: string) {
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
        summary: r.summary ?? "",
        operator: r.operator ?? "",
        ...(imageId ? { imageId } : {}),
      },
    })),
    attribution: attributionHtml,
  };
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
  try {
    if (map.getLayer(labels)) map.removeLayer(labels);
    if (map.getLayer(markers)) map.removeLayer(markers);
    if (map.getSource(sid)) map.removeSource(sid);
  } catch {
    // Source may already be torn down
  }
}

export function DataSourceLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const filters = useDataSourceStore((s) => s.filters);
  const selectItem = useDataSourceStore((s) => s.selectItem);
  const searchBbox = useDataSourceStore((s) => s.searchBbox);
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
  const prevAttrRef = useRef<string>("");

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

  // Build map attribution from only the sources present in visible results
  const mapAttribution = useMemo(() => {
    if (!activeSource || filteredResults.length === 0) return "";
    const meta = registry.get(activeSource);
    if (!meta?.dataSources) return "";
    const visibleSources = [...new Set(filteredResults.map((r) => r.source))];
    return buildSourceAttribution(meta.dataSources, visibleSources);
  }, [activeSource, registry, filteredResults]);

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
      if (!map.isStyleLoaded()) return;

      if (!activeSource || !activeMeta) {
        if (activeSource) removeLayers(map, activeSource);
        return;
      }

      const sid = sourceId(activeSource);
      const markersLid = markersLayerId(activeSource);

      if (viewportZoom < activeMeta.minZoom) {
        removeLayers(map, activeSource);
        return;
      }

      const useIconMarkers = activeMeta.markerStyle.type === "icon";
      const imageId = useIconMarkers ? `ds-marker-${activeSource}` : undefined;
      const geojson = buildGeoJson(filteredResults, mapAttribution, imageId);

      // MapLibre doesn't support updating source attribution after creation,
      // so recreate the source when attribution changes.
      if (map.getSource(sid) && prevAttrRef.current !== geojson.attribution) {
        removeLayers(map, activeSource);
      }
      prevAttrRef.current = geojson.attribution;

      if (map.getSource(sid)) {
        (map.getSource(sid) as GeoJSONSource).setData(geojson);
      } else {
        map.addSource(sid, {
          type: "geojson",
          data: geojson,
          attribution: geojson.attribution,
        });
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
          const beforeLayer = getFirstSymbolLayerId(map);

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
    mapAttribution,
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
      setSelectedPlace({
        id: props.id,
        name: props.name,
        address: props.name,
        coordinates: coords,
        category: activeMeta?.placeCategory,
        rawCategory: activeMeta?.placeCategoryRaw,
      });
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    };

    const onMouseMove = (e: MapMouseEvent) => {
      const layers = [markersLid, labelsLid].filter((id) => !!map.getLayer(id));
      if (layers.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
        const markerFeatures = features.filter(
          (f) => f.layer.id === markersLid && f.properties?.id,
        );
        if (markerFeatures.length) {
          setHoveredItemId((markerFeatures[0].properties as { id: string }).id);
        }
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
