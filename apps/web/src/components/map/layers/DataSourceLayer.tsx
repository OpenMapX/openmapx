"use client";

import Box from "@mui/material/Box";
import { alpha } from "@mui/material/styles";
import type {
  DataSourceMapContextSelection,
  DataSourceMeta,
  DataSourceResult,
  LngLat,
} from "@openmapx/core";
import {
  applyClientSideFilters,
  createPlace,
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
import { dataSourceToAttribution } from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { isI18nToken, type Translatable } from "@openmapx/integration-framework/strings";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type * as maplibregl from "maplibre-gl";
import type { Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataSourceI18nResolver } from "@/components/panels/place/useDataSourceI18nResolver";
import { usePinMarker } from "@/hooks/usePinMarker";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { createGeoJsonSourcePublisher } from "@/integration-api/map/layerStyleUtils";
import { useMap } from "@/integration-api/map/MapContext";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useMapAttributions } from "@/integration-api/overlay/useMapAttributions";
import { runtimeAttributionToAttribution } from "@/lib/attributionForProviders";
import { translateDataSourceSummary } from "@/lib/dataSourceSummaryI18n";
import { createMarkerSvg } from "@/lib/markerSvg";
import { pickDataSourceContextAction } from "./dataSourceContextInteraction";
import {
  CONTEXT_ZONE_STYLES,
  type ContextZoneClass,
  contextColorExpression,
  contextFillOpacityExpression,
  contextLineWidthExpression,
  contextSortKeyExpression,
  contextZoneClassesIn,
} from "./dataSourceContextStyle";
import { pickHoveredDataSourceItemId } from "./dataSourceHover";

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

const ZONE_LABEL_KEYS = {
  no_ride: "contextNoRide",
  no_parking: "contextNoParking",
  no_start: "contextNoStart",
  parking_hub: "contextStationParking",
  slow_zone: "contextSlowZone",
  station_area: "contextStationArea",
} as const satisfies Record<ContextZoneClass, string>;

/**
 * Buckets a data-source result's live availability into a marker color state.
 * `unknown` covers results with no live coverage (or a reported zero-capacity
 * station), so the marker falls back to its static variant color.
 */
export function availStateOf(result: {
  availability?: { available: number; total: number };
}): "available" | "busy" | "unknown" {
  const a = result.availability;
  if (!a || a.total === 0) return "unknown";
  return a.available > 0 ? "available" : "busy";
}

function buildGeoJson(
  results: DataSourceResult[],
  translateSummary: (summary: Translatable | undefined) => string | undefined,
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
        kind: r.kind ?? "",
        availState: availStateOf(r),
        ...(imageId ? { imageId } : {}),
      },
    })),
  };
}

function buildMapContextSelection(results: DataSourceResult[]): DataSourceMapContextSelection {
  const systemIds = new Set<string>();
  const vehicleTypeIds = new Set<string>();
  const providerIds = new Set<string>();
  const providerGroupIds = new Set<string>();
  const formFactors = new Set<string>();

  for (const result of results) {
    for (const systemId of result.mapContext?.systemIds ?? []) {
      systemIds.add(systemId);
    }
    for (const vehicleTypeId of result.mapContext?.vehicleTypeIds ?? []) {
      vehicleTypeIds.add(vehicleTypeId);
    }
    for (const providerId of result.mapContext?.providerIds ?? []) providerIds.add(providerId);
    for (const groupId of result.mapContext?.providerGroupIds ?? []) {
      providerGroupIds.add(groupId);
    }
    for (const formFactor of result.mapContext?.formFactors ?? []) formFactors.add(formFactor);
  }

  return {
    systemIds: [...systemIds].sort(),
    vehicleTypeIds: [...vehicleTypeIds].sort(),
    providerIds: [...providerIds].sort(),
    providerGroupIds: [...providerGroupIds].sort(),
    formFactors: [...formFactors].sort(),
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
  unregisterLayerSlot(mapContextOutline);
  unregisterLayerSlot(mapContextFill);
  unregisterLayerSlot(labels);
  unregisterLayerSlot(markers);
}

export function DataSourceLayer() {
  const publish = useRef(createGeoJsonSourcePublisher()).current;
  const t = useTranslations("dataSources");
  const { mapRef, mapReady, styleVersion, fitBounds } = useMap();
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
  const [inspectedContext, setInspectedContext] = useState<Record<string, unknown> | null>(null);

  // Register this source's layers in the shared interactive-layer registry so
  // MapStylePoiClickHandler (and MapClickHandler) know to defer to our own handlers.
  useEffect(() => {
    if (!activeSource) return;
    const markersLid = markersLayerId(activeSource);
    const labelsLid = labelsLayerId(activeSource);
    const contextFillLid = mapContextFillLayerId(activeSource);
    const contextOutlineLid = mapContextOutlineLayerId(activeSource);
    INTERACTIVE_LAYER_IDS.add(markersLid);
    INTERACTIVE_LAYER_IDS.add(labelsLid);
    INTERACTIVE_LAYER_IDS.add(contextFillLid);
    INTERACTIVE_LAYER_IDS.add(contextOutlineLid);
    return () => {
      INTERACTIVE_LAYER_IDS.delete(markersLid);
      INTERACTIVE_LAYER_IDS.delete(labelsLid);
      INTERACTIVE_LAYER_IDS.delete(contextFillLid);
      INTERACTIVE_LAYER_IDS.delete(contextOutlineLid);
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
  const resolveToken = useDataSourceI18nResolver(activeSource ?? undefined);

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

  const {
    data: searchResults,
    attributions: searchAttributions,
    isFetching: searchIsFetching,
  } = useDataSourceSearch(
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

  // Attribution for the active integration's data sources. Filtered to the
  // providers the envelope actually credited for this response — e.g.
  // browsing fuel in Aachen only emits Tankerkoenig credit, not the full EU
  // stack of country-specific fuel providers.
  //
  // While the search query is in flight we emit nothing; otherwise a freshly-
  // selected source would briefly show ALL manifest credits, then snap to
  // the actually-credited subset on first response. Once the response has
  // landed and `searchAttributions` is empty, we fall back to the full
  // manifest *only when there are visible results* — providers that don't
  // yet emit envelope attributions still need credits surfaced, but an
  // empty result set (zoomed out, no coverage area) shouldn't advertise
  // every declared publisher.
  const dataSourceAttributions = useMemo<Attribution[]>(() => {
    if (!activeSource) return [];
    if (searchIsFetching && searchAttributions.length === 0) return [];
    const meta = registry.get(activeSource);
    const dataSources = meta?.dataSources ?? [];
    const creditedIds = new Set(searchAttributions.map((a) => a.sourceId));
    const filtered = dataSources.filter((ds) => creditedIds.has(ds.sourceId));
    if (filtered.length === 0 && creditedIds.size > 0) {
      // Envelope credited sources the manifest doesn't declare — flag this in
      // dev so manifests/providers can be reconciled. In prod we still show
      // the full manifest to avoid an empty strip with rendered data.
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[DataSourceLayer] envelope.attributions for "${activeSource}" reference sourceIds ` +
            `not declared in the integration manifest: ${[...creditedIds].join(", ")}`,
        );
      }
    }
    // Pick the credited set:
    //  - envelope credited subset when present
    //  - otherwise fall back to the full manifest, BUT only when there are
    //    visible results (an empty viewport with no markers shouldn't
    //    advertise every publisher the integration declared)
    //  - otherwise nothing
    const creditedSources =
      filtered.length > 0 ? filtered : filteredResults.length > 0 ? dataSources : [];
    const manifestCredits = creditedSources.map(dataSourceToAttribution);
    // Surface per-record `result.attributions` (e.g. France IRVE municipal
    // publishers under Licence Ouverte) so license-required per-publisher
    // credit reaches the map strip alongside the manifest credits.
    const seen = new Set(manifestCredits.map((a) => a.sourceId));
    const runtimeCredits: Attribution[] = [];
    for (const result of filteredResults) {
      for (const attr of result.attributions ?? []) {
        const credit = runtimeAttributionToAttribution(attr);
        if (seen.has(credit.sourceId)) continue;
        seen.add(credit.sourceId);
        runtimeCredits.push(credit);
      }
    }
    return [...manifestCredits, ...runtimeCredits];
  }, [activeSource, registry, searchAttributions, searchIsFetching, filteredResults]);
  useMapAttributions(
    activeSource ? `data-source:${activeSource}` : "data-source",
    dataSourceAttributions,
  );

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

  const geojson = useMemo(
    () =>
      buildGeoJson(
        filteredResults,
        (summary) => {
          if (summary === undefined) return undefined;
          if (isI18nToken(summary)) return resolveToken(summary);
          if (typeof summary === "number") return String(summary);
          return translateDataSourceSummary(summary, t);
        },
        activeMeta?.markerStyle.type === "icon" ? `ds-marker-${activeSource}` : undefined,
      ),
    [filteredResults, activeMeta, activeSource, resolveToken, t],
  );

  // Sync GeoJSON source + layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
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

      publish(map, sid, geojson);

      const mapContextData = mapContext?.geojson;
      if (mapContextData && mapContextData.features.length > 0) {
        publish(map, mapContextSid, mapContextData);

        if (!map.getLayer(mapContextFillLid)) {
          const isDark = document.documentElement.classList.contains("dark");
          addLayerInSlot(
            map,
            {
              id: mapContextFillLid,
              type: "fill",
              source: mapContextSid,
              layout: {
                "fill-sort-key": contextSortKeyExpression,
              },
              paint: {
                "fill-color": contextColorExpression(isDark),
                "fill-opacity": contextFillOpacityExpression,
              },
            },
            "area-overlays",
            6,
          );
        }

        if (!map.getLayer(mapContextOutlineLid)) {
          const isDark = document.documentElement.classList.contains("dark");
          addLayerInSlot(
            map,
            {
              id: mapContextOutlineLid,
              type: "line",
              source: mapContextSid,
              paint: {
                "line-color": contextColorExpression(isDark),
                "line-width": contextLineWidthExpression,
                "line-opacity": 0.85,
              },
            },
            "overlay-lines",
            12,
          );
        }
      } else {
        if (map.getLayer(mapContextOutlineLid)) map.removeLayer(mapContextOutlineLid);
        if (map.getLayer(mapContextFillLid)) map.removeLayer(mapContextFillLid);
        if (map.getSource(mapContextSid)) map.removeSource(mapContextSid);
        unregisterLayerSlot(mapContextOutlineLid);
        unregisterLayerSlot(mapContextFillLid);
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
          addLayerInSlot(
            map,
            {
              id: markersLid,
              type: "symbol",
              source: sid,
              layout: {
                "icon-image": ["literal", imageId],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
            },
            "overlay-markers",
            11,
          );
        }

        const labelsLid = labelsLayerId(activeSource);
        if (!map.getLayer(labelsLid)) {
          // Label zoom thresholds scale with minZoom to avoid clutter on dense layers
          const nameZoom = Math.max(11, activeMeta.minZoom + 2);
          const summaryZoom = nameZoom + 2;

          addLayerInSlot(
            map,
            {
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
            },
            "overlay-markers",
            12,
          );
        }
      } else {
        // Circle marker mode (default, e.g. EV charging)
        if (!map.getLayer(markersLid)) {
          const variantColorExpr = buildVariantColorExpression(activeMeta.markerStyle);
          const colorExpr: maplibregl.ExpressionSpecification = [
            "match",
            ["get", "availState"],
            "available",
            "#2E7D32",
            "busy",
            "#F9A825",
            variantColorExpr,
          ];

          addLayerInSlot(
            map,
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
            "overlay-points",
            15,
          );
        }
      }
    };

    return subscribeStyleLoaded(map, syncLayer);
  }, [
    activeSource,
    activeMeta,
    geojson,
    publish,
    viewportZoom,
    mapReady,
    styleVersion,
    mapRef,
    mapContext,
  ]);

  const { setSelectedPlace } = usePlaceStore();

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapContext) return;
    const onFocusContext = (event: Event) => {
      const contextId = (event as CustomEvent<{ contextId?: string }>).detail?.contextId;
      if (!contextId) return;
      const feature = mapContext.geojson.features.find(
        (candidate) => candidate.properties?.contextId === contextId,
      );
      if (!feature) return;
      const positions: number[][] = [];
      const collect = (value: unknown): void => {
        if (
          Array.isArray(value) &&
          value.length >= 2 &&
          typeof value[0] === "number" &&
          typeof value[1] === "number"
        ) {
          positions.push(value as number[]);
          return;
        }
        if (Array.isArray(value)) for (const child of value) collect(child);
      };
      collect(feature.geometry.coordinates);
      if (positions.length === 0) return;
      const lngs = positions.map((position) => position[0]);
      const lats = positions.map((position) => position[1]);
      fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        48,
        { maxZoom: 17 },
      );
    };
    window.addEventListener("openmapx:focus-data-source-context", onFocusContext);
    return () => window.removeEventListener("openmapx:focus-data-source-context", onFocusContext);
  }, [mapContext, mapRef, fitBounds]);

  // Click + cursor handlers — bind to both markers and labels layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !activeSource) return;

    const markersLid = markersLayerId(activeSource);
    const labelsLid = labelsLayerId(activeSource);
    const contextFillLid = mapContextFillLayerId(activeSource);
    const currentSource = activeSource;

    const onClick = (e: MapMouseEvent) => {
      // Query both markers and labels layers
      const layers = [markersLid, labelsLid].filter((l) => map.getLayer(l));
      const features = map.queryRenderedFeatures(e.point, { layers });
      if (!features.length) return;
      const props = features[0].properties as {
        id: string;
        name: string;
        summary?: string;
        kind?: string;
      };
      const coords = (features[0].geometry as { coordinates: number[] }).coordinates as LngLat;
      selectItem(currentSource, props.id);
      // For free-floating vehicles, leave the preview address empty so
      // `usePlaceDetails` sends `hasAddress=0` and the API resolver runs a
      // reverse-geocode to fill in a real street address. The marker label
      // (e.g. "Dott E-Scooter") is not an address and would otherwise win
      // the merge in `useMergedPlace`.
      const isVehicle = props.kind === "vehicle";
      // Set a preview place immediately so the floating card shows without waiting for detail API
      setSelectedPlace(
        createPlace({
          primaryScheme: currentSource,
          ids: { [currentSource]: props.id },
          name: props.name,
          address: isVehicle ? "" : props.name,
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

    const onContextClick = (e: MapMouseEvent) => {
      const markerLayers = [markersLid, labelsLid].filter((id) => !!map.getLayer(id));
      const markerHitCount = map.queryRenderedFeatures(e.point, { layers: markerLayers }).length;
      if (!map.getLayer(contextFillLid)) return;
      const feature = map.queryRenderedFeatures(e.point, { layers: [contextFillLid] })[0];
      const action = pickDataSourceContextAction(
        markerHitCount,
        feature?.properties as Record<string, unknown> | undefined,
      );
      if (action.type === "select-station") {
        selectItem(currentSource, action.stationId);
        useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
        return;
      }
      if (action.type === "inspect") setInspectedContext(action.properties);
    };

    // Bind to markers layer
    map.on("click", markersLid, onClick);

    // Also bind to labels layer (for icon mode) — MapLibre no-ops on nonexistent layers
    map.on("click", labelsLid, onClick);
    map.on("click", contextFillLid, onContextClick);

    map.on("mousemove", onMouseMove);

    return () => {
      map.off("click", markersLid, onClick);
      map.off("click", labelsLid, onClick);
      map.off("click", contextFillLid, onContextClick);
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

  const contextFeatures = mapContext?.geojson.features ?? [];
  if (contextFeatures.length === 0) return null;
  const legendZoneClasses = contextZoneClassesIn(contextFeatures);
  const inspectContextFeature = (properties: Record<string, unknown>) => {
    if (
      activeSource &&
      properties.contextKind === "station_area" &&
      typeof properties.stationId === "string"
    ) {
      selectItem(activeSource, properties.stationId);
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
      return;
    }
    setInspectedContext(properties);
  };
  return (
    <Box
      component="aside"
      aria-label={t("contextLegend")}
      sx={(theme) => ({
        pointerEvents: "auto",
        position: "absolute",
        bottom: 96,
        left: 12,
        zIndex: 20,
        maxWidth: 320,
        p: 1.5,
        borderRadius: 1,
        bgcolor: theme.vars
          ? `rgba(${theme.vars.palette.background.paperChannel} / 0.95)`
          : alpha(theme.palette.background.paper, 0.95),
        fontSize: 12,
        lineHeight: "16px",
        boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
        backdropFilter: "blur(8px)",
      })}
    >
      <Box sx={{ fontWeight: 500 }}>{t("contextLegend")}</Box>
      {legendZoneClasses.length > 0 && (
        <Box
          component="ul"
          sx={{
            mt: 1,
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            columnGap: 1.5,
            rowGap: 0.5,
          }}
        >
          {legendZoneClasses.map((zoneClass) => {
            const style = CONTEXT_ZONE_STYLES[zoneClass];
            return (
              <Box
                component="li"
                key={zoneClass}
                sx={{ display: "flex", alignItems: "center", gap: 0.75 }}
              >
                <Box
                  component="span"
                  data-zone-class={zoneClass}
                  aria-hidden="true"
                  sx={(theme) => ({
                    flexShrink: 0,
                    width: 10,
                    height: 10,
                    borderRadius: 0.5,
                    border: "1.5px solid",
                    borderColor: style.light,
                    bgcolor: alpha(style.light, style.fillOpacity),
                    ...theme.applyStyles("dark", {
                      borderColor: style.dark,
                      bgcolor: alpha(style.dark, style.fillOpacity),
                    }),
                  })}
                />
                {t(ZONE_LABEL_KEYS[zoneClass])}
              </Box>
            );
          })}
        </Box>
      )}
      <Box component="details" sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}>
        <Box component="summary" sx={{ cursor: "pointer" }}>
          {t("contextInspectAreas")}
        </Box>
        <Box
          component="ul"
          sx={{
            mt: 0.5,
            maxHeight: 128,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 0.5,
          }}
        >
          {mapContext?.geojson.features.map((feature, index) => {
            const properties = (feature.properties ?? {}) as Record<string, unknown>;
            const label = String(
              properties.zoneName ??
                properties.stationName ??
                properties.providerName ??
                t("contextArea"),
            );
            return (
              <li key={String(properties.contextId ?? index)}>
                <Box
                  component="button"
                  type="button"
                  onClick={() => inspectContextFeature(properties)}
                  sx={{
                    width: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textAlign: "left",
                    textDecoration: "underline",
                  }}
                >
                  {label}
                </Box>
              </li>
            );
          })}
        </Box>
      </Box>
      {inspectedContext && (
        <Box role="status" sx={{ mt: 1.5, pt: 1, borderTop: 1, borderColor: "divider" }}>
          <Box sx={{ fontWeight: 500 }}>
            {String(
              inspectedContext.zoneName ??
                inspectedContext.stationName ??
                inspectedContext.providerName ??
                t("contextArea"),
            )}
          </Box>
          {inspectedContext.providerName != null && (
            <div>{String(inspectedContext.providerName)}</div>
          )}
          {Array.isArray(inspectedContext.formFactors) &&
            inspectedContext.formFactors.length > 0 && (
              <div>
                {t("contextVehicles", {
                  vehicles: inspectedContext.formFactors.join(", "),
                })}
              </div>
            )}
          <Box
            component="dl"
            sx={{
              mt: 0.5,
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              columnGap: 1,
            }}
          >
            <dt>{t("contextRideStart")}</dt>
            <dd>{inspectedContext.rideStartAllowed === false ? t("no") : t("yes")}</dd>
            <dt>{t("contextRideEnd")}</dt>
            <dd>{inspectedContext.rideEndAllowed === false ? t("no") : t("yes")}</dd>
            <dt>{t("contextRideThrough")}</dt>
            <dd>{inspectedContext.rideThroughAllowed === false ? t("no") : t("yes")}</dd>
          </Box>
          {typeof inspectedContext.maximumSpeedKph === "number" && (
            <div>{t("contextMaximumSpeed", { speed: inspectedContext.maximumSpeedKph })}</div>
          )}
          <Box
            component="button"
            type="button"
            onClick={() => setInspectedContext(null)}
            sx={{ mt: 1, textDecoration: "underline" }}
          >
            {t("close")}
          </Box>
        </Box>
      )}
    </Box>
  );
}
