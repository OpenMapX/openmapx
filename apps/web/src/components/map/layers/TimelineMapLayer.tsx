"use client";

import {
  PANEL,
  type PersonalTimelineDayV1,
  usePersonalTimelineDay,
  usePersonalTimelineStore,
  useSession,
  useSidebarStore,
  useTimelineConnection,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { calendarDateInTimeZone } from "@/components/panels/timeline/TimelineDayHeader";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";
import type { MapLayerGroup, SlottedLayer } from "./mapLayerGroup";
import { useMapLayerGroup } from "./useMapLayerGroup";

export const PERSONAL_TIMELINE_TRACKS_SOURCE_ID = "personal-timeline-tracks-source";
export const PERSONAL_TIMELINE_VISITS_SOURCE_ID = "personal-timeline-visits-source";
export const PERSONAL_TIMELINE_TRACKS_LAYER_ID = "personal-timeline-tracks-layer";
export const PERSONAL_TIMELINE_VISITS_LAYER_ID = "personal-timeline-visits-layer";

function withSlot(
  layer: maplibregl.AddLayerObject,
  slot: SlottedLayer["slot"],
  order: number,
): SlottedLayer {
  return { ...layer, slot, order } as SlottedLayer;
}

/**
 * Produce one normalized descriptor for a timeline day. Selection stays a
 * paint expression over the shared sources, so a day never creates a layer per
 * entry and the highlight survives the normal style-rebuild lifecycle.
 */
export function buildTimelineLayerGroup(
  day: PersonalTimelineDayV1,
  selectedEntryId: string | null,
): MapLayerGroup {
  const selectedId = selectedEntryId ?? "";
  const isSelected: maplibregl.ExpressionSpecification = ["==", ["get", "id"], selectedId];

  return {
    sources: {
      [PERSONAL_TIMELINE_TRACKS_SOURCE_ID]: { type: "geojson", data: day.map.tracks },
      [PERSONAL_TIMELINE_VISITS_SOURCE_ID]: { type: "geojson", data: day.map.visits },
    },
    layers: [
      withSlot(
        {
          id: PERSONAL_TIMELINE_TRACKS_LAYER_ID,
          type: "line",
          source: PERSONAL_TIMELINE_TRACKS_SOURCE_ID,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["case", isSelected, "#0f172a", PRIMARY_BLUE_HEX],
            "line-opacity": ["case", isSelected, 1, 0.72],
            "line-width": ["case", isSelected, 6, 3],
          },
        },
        "overlay-lines",
        24,
      ),
      withSlot(
        {
          id: PERSONAL_TIMELINE_VISITS_LAYER_ID,
          type: "circle",
          source: PERSONAL_TIMELINE_VISITS_SOURCE_ID,
          paint: {
            "circle-radius": ["case", isSelected, 10, 6],
            "circle-color": ["case", isSelected, "#0f172a", PRIMARY_BLUE_HEX],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": ["case", isSelected, 4, 2],
          },
        },
        "overlay-points",
        23,
      ),
    ],
  };
}

function ActiveTimelineGeometry({ ownerId, date }: { ownerId: string; date: string }) {
  const { mapRef, fitBounds } = useMap();
  const dayQuery = usePersonalTimelineDay(ownerId, date, true);
  const selectedEntryId = usePersonalTimelineStore((state) => state.selectedEntryId);
  const selectEntry = usePersonalTimelineStore((state) => state.selectEntry);
  const day = dayQuery.data?.date === date ? dayQuery.data : null;
  const group = useMemo(
    () => (day ? buildTimelineLayerGroup(day, selectedEntryId) : null),
    [day, selectedEntryId],
  );
  const lastFittedKey = useRef<string | null>(null);

  useMapLayerGroup(group);

  useEffect(() => {
    if (!day?.bounds) return;
    const fitKey = `${ownerId}:${date}`;
    if (lastFittedKey.current === fitKey) return;
    lastFittedKey.current = fitKey;
    const [west, south, east, north] = day.bounds;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const bounds: [[number, number], [number, number]] = [
      [west, south],
      [east, north],
    ];
    if (reducedMotion) fitBounds(bounds, 80, { duration: 0 });
    else fitBounds(bounds, 80);
  }, [date, day, fitBounds, ownerId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !day) return;

    const onClick = (event: maplibregl.MapLayerMouseEvent) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === "string" && id.length > 0) selectEntry(id);
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    for (const layerId of [PERSONAL_TIMELINE_TRACKS_LAYER_ID, PERSONAL_TIMELINE_VISITS_LAYER_ID]) {
      map.on("click", layerId, onClick);
      map.on("mouseenter", layerId, onEnter);
      map.on("mouseleave", layerId, onLeave);
    }

    return () => {
      for (const layerId of [
        PERSONAL_TIMELINE_TRACKS_LAYER_ID,
        PERSONAL_TIMELINE_VISITS_LAYER_ID,
      ]) {
        map.off("click", layerId, onClick);
        map.off("mouseenter", layerId, onEnter);
        map.off("mouseleave", layerId, onLeave);
      }
      map.getCanvas().style.cursor = "";
    };
  }, [day, mapRef, selectEntry]);

  return null;
}

function ActiveTimelineConnection({ ownerId, date }: { ownerId: string; date: string }) {
  const connectionQuery = useTimelineConnection(ownerId);
  const connection = connectionQuery.data?.connection ?? null;
  const today = connection ? calendarDateInTimeZone(new Date(), connection.timeZone) : null;
  const canRead =
    connectionQuery.data?.connected === true &&
    connection?.status !== "invalid" &&
    today !== null &&
    date <= today;

  if (!canRead) return null;
  return <ActiveTimelineGeometry ownerId={ownerId} date={date} />;
}

/** Temporary, read-only geometry for the active personal-timeline day. */
export function TimelineMapLayer() {
  const active = useSidebarStore((state) => state.activeSidebarId === PANEL.TIMELINE);
  const selectedDate = usePersonalTimelineStore((state) => state.selectedDate);
  const { data: session, isPending } = useSession();
  const ownerId = session?.user?.id ?? null;

  if (!active || isPending || !ownerId || !selectedDate) return null;
  return <ActiveTimelineConnection ownerId={ownerId} date={selectedDate} />;
}
