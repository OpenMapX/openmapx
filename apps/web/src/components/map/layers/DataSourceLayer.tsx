"use client";

import type { DataSourceMeta, DataSourceResult } from "@openmapx/core";
import { useDataSourceSearch, useDataSourceStore, useDataSources } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMap } from "@/lib/MapContext";
import { getFirstSymbolLayerId } from "./layerStyleUtils";

/** Filter IDs that are applied client-side instead of being sent to the API. */
const CLIENT_SIDE_FILTER_IDS = new Set(["operator", "speed"]);

function sourceId(dsId: string) {
  return `ds-${dsId}`;
}

function layerId(dsId: string) {
  return `ds-${dsId}-markers`;
}

function buildGeoJson(results: DataSourceResult[], attribution: { text: string; url: string }) {
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
      },
    })),
    attribution: `EV data: <a href="${attribution.url}">${attribution.text}</a>`,
  };
}

/**
 * Build a MapLibre `match` expression for circle-color using variantColors.
 * Falls back to defaultColor for unknown variants.
 */
function buildVariantColorExpression(
  markerStyle: DataSourceMeta["markerStyle"],
): maplibregl.ExpressionSpecification {
  const entries = Object.entries(markerStyle.variantColors);
  if (entries.length === 0) return ["literal", markerStyle.defaultColor];

  // Build ["match", ["get","variant"], v1, c1, v2, c2, ..., fallback]
  // We construct a typed tuple to satisfy MapLibre's strict expression types.
  const expr: unknown[] = ["match", ["get", "variant"]];
  for (const [variant, color] of entries) {
    expr.push(variant, color);
  }
  expr.push(markerStyle.defaultColor);
  return expr as maplibregl.ExpressionSpecification;
}

function removeLayers(map: maplibregl.Map, dsId: string) {
  const lid = layerId(dsId);
  const sid = sourceId(dsId);
  try {
    if (map.getLayer(lid)) map.removeLayer(lid);
    if (map.getSource(sid)) map.removeSource(sid);
  } catch {
    // Source may already be torn down
  }
}

export function DataSourceLayer() {
  const { mapRef, mapReady } = useMap();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const filters = useDataSourceStore((s) => s.filters);
  const selectItem = useDataSourceStore((s) => s.selectItem);
  const searchBbox = useDataSourceStore((s) => s.searchBbox);
  const viewportZoom = useDataSourceStore((s) => s.viewportZoom);
  const setViewport = useDataSourceStore((s) => s.setViewport);
  const setSearchBbox = useDataSourceStore((s) => s.setSearchBbox);
  const setMapMoved = useDataSourceStore((s) => s.setMapMoved);

  const { data: sourcesData } = useDataSources();
  const prevSourceRef = useRef<string | null>(null);

  // Find meta for the active source
  const activeMeta = useMemo(() => {
    if (!activeSource || !sourcesData?.sources) return null;
    return sourcesData.sources.find((s) => s.id === activeSource) ?? null;
  }, [activeSource, sourcesData]);

  // Separate client-side vs server-side filters
  const serverFilters = useMemo(() => {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filters)) {
      if (!CLIENT_SIDE_FILTER_IDS.has(key)) {
        result[key] = value;
      }
    }
    return result;
  }, [filters]);

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

  // Accumulate results across searches — MapLibre handles visibility.
  // Reset when the active source changes, filters change, or a new "Search in this area" is triggered.
  const accumulatedRef = useRef(new Map<string, DataSourceResult>());
  const prevActiveRef = useRef(activeSource);
  const prevFiltersRef = useRef(serverFilters);
  const prevSearchBboxRef = useRef(searchBbox);

  if (
    prevActiveRef.current !== activeSource ||
    prevFiltersRef.current !== serverFilters ||
    prevSearchBboxRef.current !== searchBbox
  ) {
    // When searchBbox changes (user clicked "Search in this area"), clear accumulated results
    if (prevSearchBboxRef.current !== searchBbox) {
      accumulatedRef.current = new Map();
    }
    // When source or filters change, also clear
    if (prevActiveRef.current !== activeSource || prevFiltersRef.current !== serverFilters) {
      accumulatedRef.current = new Map();
    }
    prevActiveRef.current = activeSource;
    prevFiltersRef.current = serverFilters;
    prevSearchBboxRef.current = searchBbox;
  }

  if (searchResults) {
    for (const r of searchResults) {
      accumulatedRef.current.set(r.id, r);
    }
  }

  const allResults = Array.from(accumulatedRef.current.values());

  // Apply client-side operator/speed filters
  const filteredResults = useMemo(() => {
    if (allResults.length === 0) return [];

    let results = allResults;

    // Speed filter (match on variant)
    const speedFilter = filters.speed;
    if (speedFilter) {
      const speedValues = Array.isArray(speedFilter)
        ? (speedFilter as string[])
        : [String(speedFilter)];
      if (speedValues.length > 0) {
        const speedSet = new Set(speedValues);
        results = results.filter((r) => speedSet.has(r.variant));
      }
    }

    // Operator filter
    const operatorFilter = filters.operator;
    if (operatorFilter) {
      const operatorValues = Array.isArray(operatorFilter)
        ? (operatorFilter as string[])
        : [String(operatorFilter)];
      if (operatorValues.length > 0) {
        const operatorSet = new Set(operatorValues);
        results = results.filter((r) => r.operator && operatorSet.has(r.operator));
      }
    }

    return results;
  }, [allResults, filters.speed, filters.operator]);

  // Track whether we've set the initial searchBbox
  const initialBboxSetRef = useRef(false);

  // Reset the flag when active source changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSource is an intentional trigger
  useEffect(() => {
    initialBboxSetRef.current = false;
  }, [activeSource]);

  // Viewport tracking: update viewportBbox/viewportZoom on moveend, set mapMoved
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

    // On first moveend after source activation, set the initial searchBbox
    if (!initialBboxSetRef.current) {
      initialBboxSetRef.current = true;
      setSearchBbox(bbox);
    } else {
      // Subsequent moves just set mapMoved flag
      setMapMoved(true);
    }
  }, [mapRef, setViewport, setSearchBbox, setMapMoved]);

  // Attach moveend listener when a source is active
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !activeSource) return;

    // Fire immediately to populate the viewport and set initial searchBbox
    handleMoveEnd();

    map.on("moveend", handleMoveEnd);
    return () => {
      map.off("moveend", handleMoveEnd);
    };
  }, [mapReady, mapRef, activeSource, handleMoveEnd]);

  // Clean up layers when activeSource changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const prevSource = prevSourceRef.current;
    if (prevSource && prevSource !== activeSource) {
      removeLayers(map, prevSource);
    }
    prevSourceRef.current = activeSource;
  }, [activeSource, mapReady, mapRef]);

  // Sync GeoJSON source + circle layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) return;

      // No active source → clean up
      if (!activeSource || !activeMeta) {
        if (activeSource) removeLayers(map, activeSource);
        return;
      }

      const sid = sourceId(activeSource);
      const lid = layerId(activeSource);

      // Below minZoom → remove layers
      if (viewportZoom < activeMeta.minZoom) {
        removeLayers(map, activeSource);
        return;
      }

      const geojson = buildGeoJson(filteredResults, activeMeta.attribution);

      // Update or create GeoJSON source
      if (map.getSource(sid)) {
        (map.getSource(sid) as GeoJSONSource).setData(geojson);
      } else {
        map.addSource(sid, {
          type: "geojson",
          data: geojson,
          attribution: geojson.attribution,
        });
      }

      // Create circle layer if not present
      if (!map.getLayer(lid)) {
        const colorExpr = buildVariantColorExpression(activeMeta.markerStyle);
        const beforeLayer = getFirstSymbolLayerId(map);

        map.addLayer(
          {
            id: lid,
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
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [activeSource, activeMeta, filteredResults, viewportZoom, mapReady, mapRef]);

  // Click + cursor handlers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !activeSource) return;

    const lid = layerId(activeSource);
    const currentSource = activeSource;

    const onClick = (e: MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: [lid] });
      if (!features.length) return;
      const featureId = (features[0].properties as { id: string }).id;
      selectItem(currentSource, featureId);
    };

    const onMouseEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };

    const onMouseLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", lid, onClick);
    map.on("mouseenter", lid, onMouseEnter);
    map.on("mouseleave", lid, onMouseLeave);

    return () => {
      map.off("click", lid, onClick);
      map.off("mouseenter", lid, onMouseEnter);
      map.off("mouseleave", lid, onMouseLeave);
    };
  }, [activeSource, mapReady, mapRef, selectItem]);

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
