import type { PressEventWithFeatures } from "@maplibre/maplibre-react-native";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { DataSourceResult } from "@openmapx/core";
import {
  useDataSourceSearch,
  useDataSourceStore,
  useDataSources,
  useMapStore,
  useOpeningHoursStore,
  usePlaceStore,
} from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NativeSyntheticEvent } from "react-native";
import { useMap } from "@/lib/MapContext";

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** Filter IDs that are applied client-side instead of being sent to the API. */
const CLIENT_SIDE_FILTER_IDS = new Set(["operator", "speed"]);

function sourceId(dsId: string) {
  return `ds-${dsId}-source`;
}

function markersLayerId(dsId: string) {
  return `ds-${dsId}-markers`;
}

function labelsLayerId(dsId: string) {
  return `ds-${dsId}-labels`;
}

function buildGeoJson(results: DataSourceResult[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
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
  };
}

export function DataSourceLayer() {
  const { flyTo } = useMap();
  const router = useRouter();
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const selectItem = useDataSourceStore((s) => s.selectItem);
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const filters = useDataSourceStore((s) => s.filters);
  const searchBbox = useDataSourceStore((s) => s.searchBbox);
  const viewportZoom = useDataSourceStore((s) => s.viewportZoom);
  const setViewport = useDataSourceStore((s) => s.setViewport);
  const setSearchBbox = useDataSourceStore((s) => s.setSearchBbox);
  const setMapMoved = useDataSourceStore((s) => s.setMapMoved);
  const openingHoursFilter = useOpeningHoursStore((s) => s.openingHoursFilter);
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);

  const { data: sourcesData } = useDataSources();

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

  const shouldFetch =
    activeSource !== null &&
    searchBbox !== null &&
    (activeMeta ? viewportZoom >= activeMeta.minZoom : true);

  const { data: searchResults } = useDataSourceSearch(
    shouldFetch ? activeSource : null,
    shouldFetch ? searchBbox : null,
    serverFilters,
  );

  // Set initial search bbox from viewport when source activates
  const initialBboxSetRef = useRef(false);
  useEffect(() => {
    initialBboxSetRef.current = false;
  }, []);

  useEffect(() => {
    if (!activeSource) return;
    const latDelta = 360 / 2 ** (zoom + 1);
    const lngDelta = 360 / 2 ** zoom;
    const bbox = {
      west: center[0] - lngDelta / 2,
      south: center[1] - latDelta / 2,
      east: center[0] + lngDelta / 2,
      north: center[1] + latDelta / 2,
    };
    setViewport(bbox, zoom);
    if (!initialBboxSetRef.current) {
      initialBboxSetRef.current = true;
      setSearchBbox(bbox);
    } else {
      setMapMoved(true);
    }
  }, [activeSource, center, zoom, setViewport, setSearchBbox, setMapMoved]);

  // Accumulate results across searches
  const [accumulatedMap, setAccumulatedMap] = useState(() => new Map<string, DataSourceResult>());
  const prevActiveRef = useRef(activeSource);
  const prevFiltersRef = useRef(serverFilters);
  const prevSearchBboxRef = useRef(searchBbox);

  useEffect(() => {
    if (
      prevActiveRef.current !== activeSource ||
      prevFiltersRef.current !== serverFilters ||
      prevSearchBboxRef.current !== searchBbox
    ) {
      setAccumulatedMap(new Map());
      prevActiveRef.current = activeSource;
      prevFiltersRef.current = serverFilters;
      prevSearchBboxRef.current = searchBbox;
      return;
    }

    if (searchResults) {
      setAccumulatedMap((prev) => {
        const next = new Map(prev);
        for (const r of searchResults) next.set(r.id, r);
        return next;
      });
    }
  }, [activeSource, serverFilters, searchBbox, searchResults]);

  const allResults = useMemo(() => Array.from(accumulatedMap.values()), [accumulatedMap]);

  // Apply client-side filters
  const filteredResults = useMemo(() => {
    if (allResults.length === 0) return [];
    let results = allResults;

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

    if (openingHoursFilter === "open_now") {
      results = results.filter((r) => r.variant === "open");
    }

    return results;
  }, [allResults, filters.speed, filters.operator, openingHoursFilter]);

  const geojson = useMemo(() => {
    if (!activeSource || !activeMeta || filteredResults.length === 0) return EMPTY_GEOJSON;
    if (viewportZoom < activeMeta.minZoom) return EMPTY_GEOJSON;
    return buildGeoJson(filteredResults);
  }, [activeSource, activeMeta, filteredResults, viewportZoom]);

  const handlePress = useCallback(
    (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
      event.stopPropagation();
      const feature = event.nativeEvent.features?.[0];
      if (!feature?.properties) return;
      const props = feature.properties as {
        id: string;
        name: string;
        source: string;
        summary: string;
      };
      const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
      flyTo(coords, 17);
      const source = useDataSourceStore.getState().activeSource;
      if (source) selectItem(source, props.id);
      setSelectedPlace({
        id: `ds:${props.id}`,
        name: props.name,
        address: props.summary || props.name,
        coordinates: coords,
      });
      router.push(`/place/${encodeURIComponent(`ds:${props.id}`)}`);
    },
    [flyTo, selectItem, setSelectedPlace, router],
  );

  if (!activeSource || !activeMeta || geojson.features.length === 0) return null;

  const sid = sourceId(activeSource);
  const markersLid = markersLayerId(activeSource);
  const labelsLid = labelsLayerId(activeSource);

  // Build variant color expression
  const variantEntries = Object.entries(activeMeta.markerStyle.variantColors);
  const hasVariants = variantEntries.length > 0;

  const circleColor = hasVariants
    ? ([
        "match",
        ["get", "variant"],
        ...variantEntries.flat(),
        activeMeta.markerStyle.defaultColor,
      ] as unknown as string)
    : activeMeta.markerStyle.defaultColor;

  const useIconMarkers = activeMeta.markerStyle.type === "icon";

  return (
    <GeoJSONSource
      id={sid}
      data={geojson}
      onPress={handlePress}
      hitbox={{ top: 22, right: 22, bottom: 22, left: 22 }}
    >
      {useIconMarkers ? (
        <>
          {/* Icon-style markers rendered as circles (no custom SVG on RN) */}
          <Layer
            type="circle"
            id={markersLid}
            paint={{
              "circle-radius": 7,
              "circle-color": activeMeta.markerStyle.defaultColor,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2,
            }}
          />
          <Layer
            type="symbol"
            id={labelsLid}
            minzoom={Math.max(11, activeMeta.minZoom + 2)}
            layout={{
              "text-field": ["get", "name"],
              "text-size": 11,
              "text-offset": [0, 1.8],
              "text-anchor": "top",
              "text-max-width": 8,
              "text-optional": true,
            }}
            paint={{
              "text-color": "#333333",
              "text-halo-color": "#ffffff",
              "text-halo-width": 1.5,
            }}
          />
        </>
      ) : (
        /* Circle markers (default, e.g. EV charging) */
        <Layer
          type="circle"
          id={markersLid}
          paint={{
            "circle-radius": 6,
            "circle-color": circleColor,
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
          }}
        />
      )}
    </GeoJSONSource>
  );
}
