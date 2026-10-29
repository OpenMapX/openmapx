"use client";

import Box from "@mui/material/Box";
import { alpha } from "@mui/material/styles";
import type { DataSourceMapContextSelection, DataSourceResult, LngLat } from "@openmapx/core";
import {
  applyClientSideFilters,
  PANEL,
  splitFilters,
  useDataSourceMapContext,
  useDataSourceSearch,
  useDataSourceStore,
  useDataSources,
  useOpeningHoursStore,
  useSidebarStore,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { isI18nToken } from "@openmapx/integration-framework/strings";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForField,
  contributorsForRecordFields,
  readCapturedContributors,
  serializeContributors,
  snapshotContributors,
  withContributors,
  withFeatureContributors,
} from "@openmapx/mobility-core/contributors";
import type * as maplibregl from "maplibre-gl";
import type { Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataSourceI18nResolver } from "@/components/panels/place/useDataSourceI18nResolver";
import { usePinMarker } from "@/hooks/usePinMarker";
import {
  buildGeoJson,
  buildTrackGeoJson,
  buildVariantColorExpression,
  DATA_SOURCE_TRACK_LAYOUT,
  dataSourceCirclePaint,
  dataSourceTrackPaint,
} from "@/integration-api/map/dataSourceFeatures";
import { openDataSourceItem } from "@/integration-api/map/dataSourceOverlay";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { addLayerInSlot, removeSlottedLayers } from "@/integration-api/map/layerStack";
import { createGeoJsonSourcePublisher } from "@/integration-api/map/layerStyleUtils";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { dataSourceRecordContributors } from "@/lib/attributionForProviders";
import { dataSourceBrandImageId, loadDataSourceBrandMarker } from "@/lib/dataSourceBrandMarker";
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

function brandLogosLayerId(dsId: string) {
  return `ds-${dsId}-brand-logos`;
}

function brandHalosLayerId(dsId: string) {
  return `ds-${dsId}-brand-halos`;
}

function labelsLayerId(dsId: string) {
  return `ds-${dsId}-labels`;
}

function tracksSourceId(dsId: string) {
  return `ds-${dsId}-tracks`;
}

function tracksLayerId(dsId: string) {
  return `ds-${dsId}-tracks`;
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

const loadedBrandAssets = new WeakMap<MaplibreMap, Map<string, readonly Attribution[]>>();

const ZONE_LABEL_KEYS = {
  no_ride: "contextNoRide",
  no_parking: "contextNoParking",
  no_start: "contextNoStart",
  parking_hub: "contextStationParking",
  slow_zone: "contextSlowZone",
  station_area: "contextStationArea",
} as const satisfies Record<ContextZoneClass, string>;

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
  removeSlottedLayers(
    map,
    [
      tracksLayerId(dsId),
      mapContextOutlineLayerId(dsId),
      mapContextFillLayerId(dsId),
      brandLogosLayerId(dsId),
      brandHalosLayerId(dsId),
      labelsLayerId(dsId),
      markersLayerId(dsId),
    ],
    [tracksSourceId(dsId), mapContextSourceId(dsId), sourceId(dsId)],
  );
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
    INTERACTIVE_LAYER_IDS.add(brandLogosLayerId(activeSource));
    INTERACTIVE_LAYER_IDS.add(brandHalosLayerId(activeSource));
    INTERACTIVE_LAYER_IDS.add(markersLid);
    INTERACTIVE_LAYER_IDS.add(labelsLid);
    INTERACTIVE_LAYER_IDS.add(contextFillLid);
    INTERACTIVE_LAYER_IDS.add(contextOutlineLid);
    return () => {
      INTERACTIVE_LAYER_IDS.delete(brandLogosLayerId(activeSource));
      INTERACTIVE_LAYER_IDS.delete(brandHalosLayerId(activeSource));
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

  const { data: searchResults, attributions: searchAttributions } = useDataSourceSearch(
    shouldFetch ? activeSource : null,
    shouldFetch ? searchBbox : null,
    serverFilters,
  );

  // Keep a legacy record's receipt with its identity while the same cached
  // record remains visible, even if a refresh or registry generation changes.
  const capturedRecords = useRef(new WeakMap<DataSourceResult, DataSourceResult>());
  const previousCapturedResults = useRef<DataSourceResult[]>([]);
  const capturedResults = useMemo(() => {
    const next = (searchResults ?? []).map((record) => {
      const retained = capturedRecords.current.get(record);
      if (retained) return retained;
      const captured = withContributors(
        record,
        dataSourceRecordContributors(
          record,
          searchAttributions,
          registry.get(activeSource ?? "")?.dataSources ?? [],
        ),
      );
      capturedRecords.current.set(record, captured);
      return captured;
    });
    const previous = previousCapturedResults.current;
    if (
      next.length === previous.length &&
      next.every((record, index) => record === previous[index])
    )
      return previous;
    previousCapturedResults.current = next;
    return next;
  }, [searchResults, searchAttributions, registry, activeSource]);

  // Apply client-side filters (speed, operator, opening hours) to the search
  // results from React Query. No manual accumulation — React Query is the
  // single source of truth and handles caching/staleness.
  const filteredResults = useMemo(
    () => applyClientSideFilters(capturedResults, filters, openingHoursFilter),
    [capturedResults, filters, openingHoursFilter],
  );

  const mapContextSelection = useMemo(
    () => buildMapContextSelection(filteredResults),
    [filteredResults],
  );

  const shouldFetchMapContext = shouldFetch && viewportBbox !== null;

  const { data: fetchedMapContext } = useDataSourceMapContext(
    shouldFetchMapContext ? activeSource : null,
    shouldFetchMapContext ? viewportBbox : null,
    serverFilters,
    mapContextSelection,
  );

  const mapContext = useMemo(
    () =>
      fetchedMapContext
        ? {
            ...fetchedMapContext,
            geojson: {
              ...fetchedMapContext.geojson,
              features: fetchedMapContext.geojson.features.map((feature) =>
                withFeatureContributors(
                  feature,
                  feature.contributors ??
                    readCapturedContributors(feature.properties?._mapAttributions) ??
                    [],
                ),
              ),
            },
          }
        : fetchedMapContext,
    [fetchedMapContext],
  );
  const attributionLayerIds = useMemo(
    () =>
      activeSource
        ? [
            markersLayerId(activeSource),
            labelsLayerId(activeSource),
            brandLogosLayerId(activeSource),
            brandHalosLayerId(activeSource),
            mapContextFillLayerId(activeSource),
            mapContextOutlineLayerId(activeSource),
            tracksLayerId(activeSource),
          ]
        : [],
    [activeSource],
  );
  useRenderedMapAttributions(
    activeSource ? `data-source:${activeSource}` : "data-source",
    attributionLayerIds,
    activeSource !== null && !!activeMeta && viewportZoom >= activeMeta.minZoom,
    {
      resolveFeatureContributors: (feature) => {
        const properties = feature.properties ?? {};
        if (!activeSource) return [];
        if (feature.layer.id === labelsLayerId(activeSource)) {
          const summaryZoom = Math.max(11, (activeMeta?.minZoom ?? 0) + 2) + 2;
          return (
            readCapturedContributors(
              properties[
                (mapRef.current?.getZoom() ?? 0) >= summaryZoom
                  ? "_mapSummaryLabelAttributions"
                  : "_mapLabelAttributions"
              ],
            ) ?? []
          );
        }
        if (feature.layer.id === brandLogosLayerId(activeSource))
          return properties.brandImageId
            ? (readCapturedContributors(properties._mapBrandAttributions) ?? [])
            : [];
        if (feature.layer.id === brandHalosLayerId(activeSource))
          return properties.brandImageId
            ? (readCapturedContributors(properties._mapHaloAttributions) ?? [])
            : [];
        if (feature.layer.id === markersLayerId(activeSource))
          return readCapturedContributors(properties._mapMarkerAttributions) ?? [];
        if (feature.layer.id === tracksLayerId(activeSource))
          return readCapturedContributors(properties._mapTrackAttributions) ?? [];
        // Shared-mobility context geometry carries its own producer receipts.
        return undefined;
      },
    },
  );

  // Show pin marker for hovered item
  const hoveredResult = filteredResults.find((r) => r.id === hoveredItemId) ?? null;
  usePinMarker(
    hoveredResult?.coordinates ?? null,
    hoveredResult ? hoveredResult.name || resolveToken(hoveredResult.fallbackName) : "",
    true,
    undefined,
    undefined,
    hoveredResult ? contributorsForField(hoveredResult, "coordinates") : [],
    hoveredResult
      ? contributorsForRecordFields(hoveredResult, [
          "coordinates",
          hoveredResult.name ? "name" : "fallbackName",
        ])
      : [],
  );

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
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const prevSource = prevSourceRef.current;
    if (prevSource && prevSource !== activeSource) {
      removeLayers(map, prevSource);
    }
    prevSourceRef.current = activeSource;
  }, [activeSource, mapReady, mapRef]);

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
        activeMeta?.markerStyle,
      ),
    [filteredResults, activeMeta, activeSource, resolveToken, t],
  );
  const trackGeojson = useMemo(() => buildTrackGeoJson(filteredResults), [filteredResults]);

  // Sync GeoJSON source + layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let cancelled = false;
    const attempted = new WeakMap<object, Set<string>>();
    let brandedData = geojson;
    let brandedKey = "";
    const syncLayer = () => {
      if (cancelled) return;
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

      const urls = [...new Set(geojson.features.map((f) => f.properties.logoUrl).filter(Boolean))];
      const ready = urls.filter((url) => map.hasImage(dataSourceBrandImageId(url)));
      const key = JSON.stringify(ready.map((url) => [url, loadedBrandAssets.get(map)?.get(url)]));
      if (key !== brandedKey) {
        brandedKey = key;
        brandedData = ready.length
          ? {
              ...geojson,
              features: geojson.features.map((feature) => ({
                ...feature,
                properties: {
                  ...feature.properties,
                  ...(ready.includes(feature.properties.logoUrl)
                    ? {
                        brandImageId: dataSourceBrandImageId(feature.properties.logoUrl),
                        _mapBrandAttributions: serializeContributors(
                          snapshotContributors(
                            readCapturedContributors(
                              feature.properties._mapLogoSelectionAttributions,
                            ) ?? [],
                            loadedBrandAssets.get(map)?.get(feature.properties.logoUrl) ?? [],
                          ),
                        ),
                      }
                    : {}),
                },
              })),
            }
          : geojson;
      }
      const source = publish(map, sid, brandedData);
      const sourceAttempts = attempted.get(source) ?? new Set<string>();
      attempted.set(source, sourceAttempts);
      for (const url of urls) {
        if (map.hasImage(dataSourceBrandImageId(url)) || sourceAttempts.has(url)) continue;
        sourceAttempts.add(url);
        const isCurrent = () => !cancelled && map.getSource(sid) === source;
        // This URL's first retained owner initiated the acquisition. Other rows
        // keep their selector receipts; they do not retroactively supply its bytes.
        const acquisitionReceipts = snapshotContributors(
          readCapturedContributors(
            geojson.features.find((feature) => feature.properties.logoUrl === url)?.properties
              ._mapLogoFileAttributions,
          ) ?? [],
        );
        void loadDataSourceBrandMarker(map, url, isCurrent).then((loaded) => {
          if (loaded && isCurrent()) {
            let assets = loadedBrandAssets.get(map);
            if (!assets) {
              assets = new Map();
              loadedBrandAssets.set(map, assets);
            }
            assets.set(url, acquisitionReceipts);
            syncLayer();
          } else if (!isCurrent()) sourceAttempts.delete(url);
        });
      }
      if (urls.length) {
        const haloId = brandHalosLayerId(activeSource);
        const logoId = brandLogosLayerId(activeSource);
        const filter: maplibregl.FilterSpecification = ["has", "brandImageId"];
        const opacity: maplibregl.ExpressionSpecification = [
          "case",
          ["==", ["get", "status"], "non-operational"],
          activeMeta.markerStyle.inactiveOpacity,
          1,
        ];
        if (!map.getLayer(haloId))
          addLayerInSlot(
            map,
            {
              id: haloId,
              type: "circle",
              source: sid,
              filter,
              paint: {
                "circle-radius": 18,
                "circle-color": [
                  "match",
                  ["get", "availState"],
                  "available",
                  "#2E7D32",
                  "busy",
                  "#F9A825",
                  buildVariantColorExpression(activeMeta.markerStyle),
                ],
                "circle-opacity": opacity,
                "circle-stroke-color": "white",
                "circle-stroke-width": 1.5,
                "circle-stroke-opacity": opacity,
              },
            },
            "overlay-markers",
            17,
          );
        if (!map.getLayer(logoId))
          addLayerInSlot(
            map,
            {
              id: logoId,
              type: "symbol",
              source: sid,
              filter,
              layout: {
                "icon-image": ["get", "brandImageId"],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
              paint: { "icon-opacity": opacity },
            },
            "overlay-markers",
            18,
          );
      }

      const tracksSid = tracksSourceId(activeSource);
      const tracksLid = tracksLayerId(activeSource);
      if (trackGeojson.features.length > 0) {
        publish(map, tracksSid, trackGeojson);
        if (!map.getLayer(tracksLid)) {
          addLayerInSlot(
            map,
            {
              id: tracksLid,
              type: "line",
              source: tracksSid,
              layout: DATA_SOURCE_TRACK_LAYOUT,
              paint: dataSourceTrackPaint(activeMeta.markerStyle),
            },
            "overlay-lines",
            17,
          );
        }
      } else {
        removeSlottedLayers(map, [tracksLid], [tracksSid]);
      }

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
        removeSlottedLayers(map, [mapContextOutlineLid, mapContextFillLid], [mapContextSid]);
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
          addLayerInSlot(
            map,
            {
              id: markersLid,
              type: "circle",
              source: sid,
              paint: dataSourceCirclePaint(activeMeta.markerStyle),
            },
            "overlay-points",
            15,
          );
        }
      }
    };

    const unsubscribe = subscribeStyleLoaded(map, syncLayer);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    activeSource,
    activeMeta,
    geojson,
    trackGeojson,
    publish,
    viewportZoom,
    mapReady,
    styleVersion,
    mapRef,
    mapContext,
  ]);

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

    const handledClicks = new WeakSet<object>();
    const onClick = (e: MapMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const event = e.originalEvent ?? e;
      if (handledClicks.has(event)) return;
      // Query both markers and labels layers
      const layers = [
        brandLogosLayerId(activeSource),
        brandHalosLayerId(activeSource),
        markersLid,
        labelsLid,
      ].filter((l) => map.getLayer(l));
      const features = map.queryRenderedFeatures(e.point, { layers });
      if (!features.length) return;
      handledClicks.add(event);
      const props = features[0].properties as {
        id: string;
        name: string;
        summary?: string;
        kind?: string;
      };
      const coords = (features[0].geometry as { coordinates: number[] }).coordinates as LngLat;
      openDataSourceItem(currentSource, props, coords, activeMeta);
    };

    const onMouseMove = (e: MapMouseEvent) => {
      const layers = [
        brandLogosLayerId(activeSource),
        brandHalosLayerId(activeSource),
        markersLid,
        labelsLid,
      ].filter((id) => !!map.getLayer(id));
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
      if (getMapClickOwner(e)) return;
      const markerLayers = [
        brandLogosLayerId(activeSource),
        brandHalosLayerId(activeSource),
        markersLid,
        labelsLid,
      ].filter((id) => !!map.getLayer(id));
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
    map.on("click", brandLogosLayerId(activeSource), onClick);
    map.on("click", brandHalosLayerId(activeSource), onClick);
    map.on("click", markersLid, onClick);

    // Also bind to labels layer (for icon mode) — MapLibre no-ops on nonexistent layers
    map.on("click", labelsLid, onClick);
    map.on("click", contextFillLid, onContextClick);

    map.on("mousemove", onMouseMove);

    return () => {
      map.off("click", brandLogosLayerId(activeSource), onClick);
      map.off("click", brandHalosLayerId(activeSource), onClick);
      map.off("click", markersLid, onClick);
      map.off("click", labelsLid, onClick);
      map.off("click", contextFillLid, onContextClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      setHoveredItemId(null);
    };
  }, [activeSource, activeMeta, mapReady, styleVersion, mapRef, selectItem, setHoveredItemId]);

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
