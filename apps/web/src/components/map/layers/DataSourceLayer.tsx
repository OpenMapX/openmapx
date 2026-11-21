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
import type { Map as MaplibreMap } from "maplibre-gl";
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
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup, SlottedLayer } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useMapOverlayInteraction } from "@/integration-api/map/useMapOverlayInteraction";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { dataSourceRecordContributors } from "@/lib/attributionForProviders";
import { dataSourceBrandImageId, loadDataSourceBrandMarker } from "@/lib/dataSourceBrandMarker";
import { translateDataSourceSummary } from "@/lib/dataSourceSummaryI18n";
import { createMarkerSvg } from "@/lib/markerSvg";
import { positionBounds } from "@/lib/positionBounds";
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

/**
 * Results the user asked for win over ambient overlays drawn beneath them.
 * Data-source results draw below the other host results, so they rank lowest.
 */
const RESULT_INTERACTION_PRIORITY = 200;
/** Context zones are areas beneath the results; a result on top of one wins. */
const CONTEXT_INTERACTION_PRIORITY = 15;

export function DataSourceLayer() {
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

  const openingHoursFilter = useOpeningHoursStore((s) => s.openingHoursFilter);

  const { data: sourcesData } = useDataSources();

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

  // The source whose search area the first camera report set. Every later
  // move only marks the map as moved, so the search waits for the reader.
  const searchBboxSourceRef = useRef<string | null>(null);

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

    if (searchBboxSourceRef.current !== activeSource) {
      searchBboxSourceRef.current = activeSource;
      setSearchBbox(bbox);
    } else {
      setMapMoved(true);
    }
  }, [activeSource, mapRef, setViewport, setSearchBbox, setMapMoved]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !activeSource) return;

    handleMoveEnd();

    map.on("moveend", handleMoveEnd);
    return () => {
      map.off("moveend", handleMoveEnd);
      searchBboxSourceRef.current = null;
    };
  }, [mapReady, mapRef, activeSource, handleMoveEnd]);

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

  // Brand logos load asynchronously. Each finished load re-renders, so the
  // results that carry that logo switch to it with the receipts of its file.
  const [brandLoads, setBrandLoads] = useState(0);
  const logoUrls = useMemo(
    () => [...new Set(geojson.features.map((f) => f.properties.logoUrl).filter(Boolean))],
    [geojson],
  );
  const brandedData = useMemo(() => {
    void brandLoads;
    void styleVersion;
    const map = mapRef.current;
    const ready = map ? logoUrls.filter((url) => map.hasImage(dataSourceBrandImageId(url))) : [];
    if (!map || ready.length === 0) return geojson;
    return {
      ...geojson,
      features: geojson.features.map((feature) =>
        ready.includes(feature.properties.logoUrl)
          ? {
              ...feature,
              properties: {
                ...feature.properties,
                brandImageId: dataSourceBrandImageId(feature.properties.logoUrl),
                _mapBrandAttributions: serializeContributors(
                  snapshotContributors(
                    readCapturedContributors(feature.properties._mapLogoSelectionAttributions) ??
                      [],
                    loadedBrandAssets.get(map)?.get(feature.properties.logoUrl) ?? [],
                  ),
                ),
              },
            }
          : feature,
      ),
    };
  }, [geojson, logoUrls, brandLoads, styleVersion, mapRef]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** The images the current descriptor asks for; a load for any other is stale. */
  const wantedImages = useRef(new Set<string>());

  const group = useMemo<MapLayerGroup | null>(() => {
    if (!activeSource || !activeMeta || viewportZoom < activeMeta.minZoom) return null;
    void styleVersion;
    const style = activeMeta.markerStyle;
    const sid = sourceId(activeSource);
    const images: NonNullable<MapLayerGroup["images"]> = {};
    for (const url of logoUrls) {
      images[dataSourceBrandImageId(url)] = (map) => {
        // A logo the current results no longer ask for (another source, or
        // results without that brand) is dropped. One that outlives a style
        // switch still lands in the style now shown, which wants it too.
        const imageId = dataSourceBrandImageId(url);
        const isCurrent = () =>
          mounted.current && mapRef.current === map && wantedImages.current.has(imageId);
        // This URL's first retained owner initiated the acquisition. Other rows
        // keep their selector receipts; they do not retroactively supply its bytes.
        const acquisitionReceipts = snapshotContributors(
          readCapturedContributors(
            geojson.features.find((feature) => feature.properties.logoUrl === url)?.properties
              ._mapLogoFileAttributions,
          ) ?? [],
        );
        void loadDataSourceBrandMarker(map, url, isCurrent).then((loaded) => {
          if (!loaded || !isCurrent()) return;
          let assets = loadedBrandAssets.get(map);
          if (!assets) {
            assets = new Map();
            loadedBrandAssets.set(map, assets);
          }
          assets.set(url, acquisitionReceipts);
          setBrandLoads((count) => count + 1);
        });
      };
    }
    const layers: SlottedLayer[] = [];
    const sources: MapLayerGroup["sources"] = { [sid]: { type: "geojson", data: brandedData } };

    if (logoUrls.length) {
      const filter: maplibregl.FilterSpecification = ["has", "brandImageId"];
      const opacity: maplibregl.ExpressionSpecification = [
        "case",
        ["==", ["get", "status"], "non-operational"],
        style.inactiveOpacity,
        1,
      ];
      layers.push(
        {
          id: brandHalosLayerId(activeSource),
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
              buildVariantColorExpression(style),
            ],
            "circle-opacity": opacity,
            "circle-stroke-color": "white",
            "circle-stroke-width": 1.5,
            "circle-stroke-opacity": opacity,
          },
          slot: "overlay-markers",
          order: 17,
        },
        {
          id: brandLogosLayerId(activeSource),
          type: "symbol",
          source: sid,
          filter,
          layout: {
            "icon-image": ["get", "brandImageId"],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
          paint: { "icon-opacity": opacity },
          slot: "overlay-markers",
          order: 18,
        },
      );
    }

    if (trackGeojson.features.length > 0) {
      const tracksSid = tracksSourceId(activeSource);
      sources[tracksSid] = { type: "geojson", data: trackGeojson };
      layers.push({
        id: tracksLayerId(activeSource),
        type: "line",
        source: tracksSid,
        layout: DATA_SOURCE_TRACK_LAYOUT,
        paint: dataSourceTrackPaint(style),
        slot: "overlay-lines",
        order: 17,
      });
    }

    const mapContextData = mapContext?.geojson;
    if (mapContextData && mapContextData.features.length > 0) {
      const contextSid = mapContextSourceId(activeSource);
      const isDark = document.documentElement.classList.contains("dark");
      sources[contextSid] = { type: "geojson", data: mapContextData };
      layers.push(
        {
          id: mapContextFillLayerId(activeSource),
          type: "fill",
          source: contextSid,
          layout: { "fill-sort-key": contextSortKeyExpression },
          paint: {
            "fill-color": contextColorExpression(isDark),
            "fill-opacity": contextFillOpacityExpression,
          },
          slot: "area-overlays",
          order: 6,
        },
        {
          id: mapContextOutlineLayerId(activeSource),
          type: "line",
          source: contextSid,
          paint: {
            "line-color": contextColorExpression(isDark),
            "line-width": contextLineWidthExpression,
            "line-opacity": 0.85,
          },
          slot: "overlay-lines",
          order: 12,
        },
      );
    }

    if (style.type === "icon") {
      const imageId = `ds-marker-${activeSource}`;
      images[imageId] = (map) => loadMarkerImage(map, imageId, style.iconPath, style.defaultColor);
      // Label zoom thresholds scale with minZoom to avoid clutter on dense layers
      const nameZoom = Math.max(11, activeMeta.minZoom + 2);
      const summaryZoom = nameZoom + 2;
      layers.push(
        {
          id: markersLayerId(activeSource),
          type: "symbol",
          source: sid,
          layout: {
            "icon-image": ["literal", imageId],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
          slot: "overlay-markers",
          order: 11,
        },
        {
          id: labelsLayerId(activeSource),
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
          slot: "overlay-markers",
          order: 12,
        },
      );
    } else {
      // Circle marker mode (default, e.g. EV charging)
      layers.push({
        id: markersLayerId(activeSource),
        type: "circle",
        source: sid,
        paint: dataSourceCirclePaint(style),
        slot: "overlay-points",
        order: 15,
      });
    }
    return { sources, layers, images };
  }, [
    activeSource,
    activeMeta,
    viewportZoom,
    styleVersion,
    logoUrls,
    geojson,
    brandedData,
    trackGeojson,
    mapContext,
    mapRef,
  ]);
  useEffect(() => {
    wantedImages.current = new Set(Object.keys(group?.images ?? {}));
  }, [group]);
  useMapLayerGroup(group);

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
      const bounds = positionBounds(positions);
      if (!bounds) return;
      fitBounds(
        [
          [bounds.west, bounds.south],
          [bounds.east, bounds.north],
        ],
        48,
        { maxZoom: 17 },
      );
    };
    window.addEventListener("openmapx:focus-data-source-context", onFocusContext);
    return () => window.removeEventListener("openmapx:focus-data-source-context", onFocusContext);
  }, [mapContext, mapRef, fitBounds]);

  const markersLid = activeSource ? markersLayerId(activeSource) : "";
  useMapOverlayInteraction({
    id: "data-source-results",
    layerIds: activeSource
      ? [
          brandLogosLayerId(activeSource),
          brandHalosLayerId(activeSource),
          markersLid,
          labelsLayerId(activeSource),
        ]
      : [],
    priority: RESULT_INTERACTION_PRIORITY,
    enabled: activeSource !== null,
    onClick: ({ features: [feature] }) => {
      if (!activeSource || !feature) return;
      const props = feature.properties as {
        id: string;
        name: string;
        summary?: string;
        kind?: string;
      };
      const coords = (feature.geometry as { coordinates: number[] }).coordinates as LngLat;
      openDataSourceItem(activeSource, props, coords, activeMeta);
    },
    onHover: (features) =>
      setHoveredItemId(features ? pickHoveredDataSourceItemId(features, markersLid) : null),
  });
  // A result drawn over a zone takes the click, so a zone click never has a result under it.
  useMapOverlayInteraction({
    id: "data-source-context",
    layerIds: activeSource
      ? [mapContextFillLayerId(activeSource), mapContextOutlineLayerId(activeSource)]
      : [],
    priority: CONTEXT_INTERACTION_PRIORITY,
    enabled: activeSource !== null,
    onClick: ({ features }) => {
      if (!activeSource) return;
      const action = pickDataSourceContextAction(
        features[0]?.properties as Record<string, unknown> | undefined,
      );
      if (action.type === "select-station") {
        selectItem(activeSource, action.stationId);
        useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
        return;
      }
      if (action.type === "inspect") setInspectedContext(action.properties);
    },
  });
  // A hover that outlives its source would pin a marker for a result no longer drawn.
  useEffect(() => {
    if (!activeSource) setHoveredItemId(null);
    return () => setHoveredItemId(null);
  }, [activeSource, setHoveredItemId]);

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
