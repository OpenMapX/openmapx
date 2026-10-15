"use client";

import type { BoundingBox, LngLat } from "@openmapx/core";
import { readCapturedContributors } from "@openmapx/mobility-core/contributors";
import type * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DATA_SOURCE_TRACK_LAYOUT,
  dataSourceCirclePaint,
  dataSourceGlyphOverlay,
  dataSourceTrackPaint,
  prepareDataSourceGlyph,
} from "@/integration-api/map/dataSourceFeatures";
import {
  openDataSourceItem,
  useDataSourceOverlayRecords,
} from "@/integration-api/map/dataSourceOverlay";
import { useMap } from "@/integration-api/map/MapContext";
import { registerMapOverlayInteraction } from "@/integration-api/map/mapInteractionArbiter";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useOverlayMinZoom } from "@/integration-api/overlay/overlayZoomGate";
import { useOverlayLayerVisible } from "@/integration-api/overlay/useOverlayStoreState";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { ROAD_SOURCE_IDS } from "./road-sources";
import { useRoadConditionsStore } from "./store";
import {
  createViewportFetchScheduler,
  type ViewportBox,
  type ViewportFetchScheduler,
} from "./viewport-scheduler";

const OVERLAY_ID = "road-conditions";

/**
 * How long a road source's markers may stand without a refresh while the map
 * is parked. The sources' own search caches hold 30 s to 2 min, so a minute
 * catches a moving plough or a changed sign without replaying cached answers.
 */
const FRESHNESS_DEADLINE_MS = 60_000;

/**
 * Slack on every side of the fetched area, as a fraction of the view. The
 * request asks for the padded area, so a pan within it needs no new request
 * and a following navigation camera coasts inside it.
 */
const PADDING_FACTOR = 0.5;

/** Discs large enough to hold the source's glyph. */
const MARKER_RADIUS: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 8, 7, 14, 10];

/** Marker clicks win over the incident lines they sit on, as a point is the more precise hit. */
const INTERACTION_PRIORITY = 110;

function layerIds(sourceId: string) {
  return {
    source: `omx-road-src-${sourceId}`,
    tracksSource: `omx-road-src-${sourceId}-tracks`,
    markers: `omx-road-src-${sourceId}-markers`,
    glyphs: `omx-road-src-${sourceId}-glyphs`,
    tracks: `omx-road-src-${sourceId}-tracks`,
  };
}

/** Round outward to ~100 m so near-identical views share a request and its cache entry. */
function paddedArea(view: ViewportBox): BoundingBox {
  const padX = (view.east - view.west) * PADDING_FACTOR;
  const padY = (view.north - view.south) * PADDING_FACTOR;
  const down = (value: number) => Math.floor(value * 1000) / 1000;
  const up = (value: number) => Math.ceil(value * 1000) / 1000;
  return {
    west: down(Math.max(-180, view.west - padX)),
    south: down(Math.max(-90, view.south - padY)),
    east: up(Math.min(180, view.east + padX)),
    north: up(Math.min(90, view.north + padY)),
  };
}

function viewOf(map: maplibregl.Map | null): ViewportBox {
  const bounds = map?.getBounds();
  if (!bounds) return { west: 0, south: 0, east: 0, north: 0 };
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

function sameArea(a: BoundingBox | null, b: BoundingBox | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.west === b.west &&
    a.south === b.south &&
    a.east === b.east &&
    a.north === b.north
  );
}

/**
 * One road data source drawn inside the overlay: its markers (and a moving
 * vehicle's trail) for the area in view, refreshed as the map moves and every
 * minute while parked. A marker opens the item in the place card.
 */
function RoadSourceLayer({ sourceId }: { sourceId: string }) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const overlayVisible = useOverlayLayerVisible(OVERLAY_ID);
  const overlayMinZoom = useOverlayMinZoom(OVERLAY_ID);
  const setSourceStatus = useRoadConditionsStore((s) => s.setSourceStatus);
  const [area, setArea] = useState<BoundingBox | null>(null);
  const records = useDataSourceOverlayRecords(sourceId, overlayVisible ? area : null);
  const { listing, geojson, trackGeojson, state, count, refetch } = records;
  const minZoom = Math.max(overlayMinZoom, listing?.minZoom ?? 0);
  const ids = layerIds(sourceId);

  const areaRef = useRef(area);
  areaRef.current = area;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const minZoomRef = useRef(minZoom);
  minZoomRef.current = minZoom;
  const schedulerRef = useRef<ViewportFetchScheduler | null>(null);

  if (!schedulerRef.current) {
    schedulerRef.current = createViewportFetchScheduler({
      freshnessDeadlineMs: FRESHNESS_DEADLINE_MS,
      paddingFactor: PADDING_FACTOR,
      getViewport: () => viewOf(mapRef.current),
      onDue: () => {
        const map = mapRef.current;
        if (!map) return;
        if (map.getZoom() < minZoomRef.current) {
          setArea(null);
          return;
        }
        const view = viewOf(map);
        schedulerRef.current?.recordFetch(view);
        const next = paddedArea(view);
        // A parked map's freshness deadline asks for the same area again.
        if (sameArea(areaRef.current, next)) void refetchRef.current();
        else setArea(next);
      },
    });
  }

  // Fetch on showing; afterwards camera moves (pans and zooms alike) and the
  // freshness timer decide, through the scheduler.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    const scheduler = schedulerRef.current;
    if (!map || !mapReady || !overlayVisible || !scheduler) {
      setArea(null);
      return;
    }
    const onMoveEnd = () => {
      // Crossing the zoom threshold acts at once: the scheduler only compares
      // areas, and would keep markers below it or leave them off back above.
      if (map.getZoom() < minZoomRef.current) {
        if (areaRef.current !== null) setArea(null);
        return;
      }
      if (areaRef.current === null) {
        const view = viewOf(map);
        scheduler.recordFetch(view);
        setArea(paddedArea(view));
        return;
      }
      scheduler.markDirty();
    };
    map.on("moveend", onMoveEnd);
    if (map.getZoom() >= minZoom) {
      const view = viewOf(map);
      scheduler.recordFetch(view);
      setArea(paddedArea(view));
    } else {
      setArea(null);
      scheduler.markDirty();
    }
    return () => {
      map.off("moveend", onMoveEnd);
      scheduler.dispose();
    };
  }, [mapRef, mapReady, styleVersion, overlayVisible, minZoom]);

  useEffect(() => {
    setSourceStatus(sourceId, { state, count });
  }, [setSourceStatus, sourceId, state, count]);
  useEffect(() => () => setSourceStatus(sourceId, null), [setSourceStatus, sourceId]);

  // The glyph layer waits for its image, so it is never laid out without it.
  const iconPath = listing?.markerStyle.iconPath;
  const [glyphReady, setGlyphReady] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!iconPath) return;
    let current = true;
    void prepareDataSourceGlyph(iconPath).then(() => {
      if (current) setGlyphReady(iconPath);
    });
    return () => {
      current = false;
    };
  }, [iconPath]);

  const drawn = overlayVisible && area !== null && listing !== null;
  const group = useMemo<MapLayerGroup | null>(() => {
    if (!drawn || !listing) return null;
    const glyph = dataSourceGlyphOverlay(ids.glyphs, listing.markerStyle);
    const withGlyph = glyphReady === listing.markerStyle.iconPath;
    return {
      sources: {
        [ids.source]: { type: "geojson", data: geojson },
        [ids.tracksSource]: { type: "geojson", data: trackGeojson },
      },
      images: withGlyph ? glyph.images : {},
      layers: [
        {
          id: ids.tracks,
          type: "line",
          source: ids.tracksSource,
          layout: DATA_SOURCE_TRACK_LAYOUT,
          paint: dataSourceTrackPaint(listing.markerStyle),
          slot: "overlay-lines",
          order: 17,
        },
        {
          id: ids.markers,
          type: "circle",
          source: ids.source,
          paint: dataSourceCirclePaint(listing.markerStyle, MARKER_RADIUS),
          slot: "overlay-points",
          order: 15,
        },
        ...(withGlyph
          ? [
              {
                id: ids.glyphs,
                type: "symbol" as const,
                source: ids.source,
                layout: glyph.layout,
                paint: glyph.paint,
                slot: "overlay-points" as const,
                order: 16,
              },
            ]
          : []),
      ],
    };
  }, [
    drawn,
    listing,
    glyphReady,
    geojson,
    trackGeojson,
    ids.source,
    ids.tracksSource,
    ids.tracks,
    ids.markers,
    ids.glyphs,
  ]);
  useMapLayerGroup(group);

  const listingRef = useRef(listing);
  listingRef.current = listing;
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !drawn) return;
    return registerMapOverlayInteraction(map, {
      id: `road-conditions-${sourceId}`,
      layerIds: [ids.markers],
      priority: INTERACTION_PRIORITY,
      onClick: ({ features }) => {
        const hit = features.find((feature) => feature.layer?.id === ids.markers);
        if (!hit) return;
        const props = hit.properties as { id: string; name: string; kind?: string };
        const coordinates = (hit.geometry as { coordinates: number[] }).coordinates as LngLat;
        openDataSourceItem(sourceId, props, coordinates, listingRef.current);
      },
    });
  }, [mapRef, mapReady, styleVersion, drawn, sourceId, ids.markers]);

  useRenderedMapAttributions(`road-conditions:${sourceId}`, [ids.markers, ids.tracks], drawn, {
    resolveFeatureContributors: (feature) => {
      const properties = feature.properties ?? {};
      if (feature.layer.id === ids.markers)
        return readCapturedContributors(properties._mapMarkerAttributions) ?? [];
      if (feature.layer.id === ids.tracks)
        return readCapturedContributors(properties._mapTrackAttributions) ?? [];
      return [];
    },
  });

  return null;
}

/** The road data sources the reader switched on in the overlay's legend. */
export function RoadSourceLayers() {
  const shownSources = useRoadConditionsStore((s) => s.shownSources);
  return (
    <>
      {ROAD_SOURCE_IDS.filter((id) => shownSources.includes(id)).map((id) => (
        <RoadSourceLayer key={id} sourceId={id} />
      ))}
    </>
  );
}
