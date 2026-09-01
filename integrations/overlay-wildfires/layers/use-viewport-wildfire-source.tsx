"use client";

import type { Map as MaplibreMap } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useWildfireStore } from "../store";
import type { WildfireFeatureCollection } from "../types";
import {
  isViewportWildfireFeatureCollection,
  type ViewportWildfireSourceId,
} from "./viewport-wildfire-validation";

const VIEWPORT_DEBOUNCE_MS = 200;

export interface ViewportWildfireSourceOptions {
  active: boolean;
  sourceId: ViewportWildfireSourceId;
  endpoint: string;
  minZoom: number;
  refreshMs: number;
  publish(data: WildfireFeatureCollection): void;
  clear(): void;
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function normalizeLongitudeInterval(west: number, east: number): { west: number; east: number } {
  const unwrappedWidth = east - west;
  if (Math.abs(unwrappedWidth) >= 360) return { west: -180, east: 180 };

  const width = unwrappedWidth < 0 ? unwrappedWidth + 360 : unwrappedWidth;
  const normalizedWest = normalizeLongitude(west);
  const unwrappedEast = normalizedWest + width;
  const normalizedEast = unwrappedEast > 180 ? unwrappedEast - 360 : unwrappedEast;
  return { west: normalizedWest, east: normalizedEast };
}

function viewportUrl(endpoint: string, map: MaplibreMap): string | null {
  const zoom = Math.floor(map.getZoom());
  const bounds = map.getBounds();
  const rawValues = {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
    zoom,
  };
  if (!Object.values(rawValues).every(Number.isFinite)) return null;

  const longitudeInterval = normalizeLongitudeInterval(rawValues.west, rawValues.east);
  const values = {
    west: longitudeInterval.west,
    south: rawValues.south,
    east: longitudeInterval.east,
    north: rawValues.north,
    zoom,
  };

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) query.set(key, String(value));
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${query.toString()}`;
}

/** Source-local viewport fetching with zoom gating, latest-wins requests, and status updates. */
export function useViewportWildfireSource({
  active,
  sourceId,
  endpoint,
  minZoom,
  refreshMs,
  publish,
  clear,
}: ViewportWildfireSourceOptions): boolean {
  const { mapRef, mapReady } = useMap();
  const setSourceStatus = useWildfireStore((state) => state.setSourceStatus);
  const resetSourceStatus = useWildfireStore((state) => state.resetSourceStatus);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const lastRequestedUrlRef = useRef<string | null>(null);
  const clearedRef = useRef(false);
  const [aboveMinZoom, setAboveMinZoom] = useState(
    () => active && (mapRef.current?.getZoom() ?? 0) >= minZoom,
  );

  const abortRequest = useCallback(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const clearRenderedData = useCallback(() => {
    if (clearedRef.current) return;
    clear();
    clearedRef.current = true;
  }, [clear]);

  const gateSource = useCallback(() => {
    abortRequest();
    lastRequestedUrlRef.current = null;
    clearRenderedData();
    resetSourceStatus(sourceId);
  }, [abortRequest, clearRenderedData, resetSourceStatus, sourceId]);

  const fetchViewport = useCallback(
    async (force = false) => {
      const map = mapRef.current;
      if (!active || !map || map.getZoom() < minZoom) {
        gateSource();
        return;
      }

      const url = viewportUrl(endpoint, map);
      if (!url) {
        abortRequest();
        lastRequestedUrlRef.current = null;
        setSourceStatus(sourceId, { loading: false, error: "unavailable" });
        return;
      }
      if (!force && lastRequestedUrlRef.current === url) return;
      lastRequestedUrlRef.current = url;

      abortRequest();
      const generation = generationRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      setSourceStatus(sourceId, { loading: true, error: null });

      try {
        const result = await fetch(url, { signal: controller.signal });
        if (controller.signal.aborted || generationRef.current !== generation) return;
        if (!result.ok) throw new Error(`Wildfire source returned ${result.status}`);
        const data: unknown = await result.json();
        if (controller.signal.aborted || generationRef.current !== generation) return;
        if (!isViewportWildfireFeatureCollection(data, sourceId)) {
          throw new Error("Invalid wildfire FeatureCollection");
        }

        publish(data);
        clearedRef.current = false;
        setSourceStatus(sourceId, {
          loading: false,
          fetchedAt: Date.parse(data.fetchedAt),
          stale: data.stale,
          truncated: data.truncated,
          error: null,
          featureCount: data.features.length,
        });
      } catch {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        setSourceStatus(sourceId, { loading: false, error: "unavailable" });
      } finally {
        if (generationRef.current === generation) controllerRef.current = null;
      }
    },
    [
      abortRequest,
      active,
      endpoint,
      gateSource,
      mapRef,
      minZoom,
      publish,
      setSourceStatus,
      sourceId,
    ],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !active) {
      setAboveMinZoom(false);
      gateSource();
      return;
    }

    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    const onMoveEnd = () => {
      if (moveTimer) clearTimeout(moveTimer);
      if (map.getZoom() < minZoom) {
        moveTimer = null;
        setAboveMinZoom(false);
        gateSource();
        return;
      }
      setAboveMinZoom(true);
      moveTimer = setTimeout(() => {
        moveTimer = null;
        void fetchViewport();
      }, VIEWPORT_DEBOUNCE_MS);
    };

    const canFetch = map.getZoom() >= minZoom;
    setAboveMinZoom(canFetch);
    if (canFetch) void fetchViewport();
    else gateSource();
    map.on("moveend", onMoveEnd);
    const refreshTimer = setInterval(() => void fetchViewport(true), refreshMs);

    return () => {
      if (moveTimer) clearTimeout(moveTimer);
      clearInterval(refreshTimer);
      map.off("moveend", onMoveEnd);
      abortRequest();
      clearRenderedData();
      resetSourceStatus(sourceId);
    };
  }, [
    abortRequest,
    active,
    clearRenderedData,
    fetchViewport,
    gateSource,
    mapReady,
    mapRef,
    minZoom,
    refreshMs,
    resetSourceStatus,
    sourceId,
  ]);

  return active && aboveMinZoom;
}
