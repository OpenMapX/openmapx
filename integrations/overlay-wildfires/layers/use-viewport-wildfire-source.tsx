"use client";

import type { Map as MaplibreMap } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useWildfireStore, type WildfireSourceId } from "../store";
import type { WildfireFeatureCollection } from "../types";
import { isViewportWildfireFeatureCollection } from "./viewport-wildfire-validation";

const VIEWPORT_DEBOUNCE_MS = 200;

/** A validated response and the status it reports. */
export interface ViewportReading<T> {
  data: T;
  fetchedAt: number;
  stale: boolean;
  truncated: boolean;
  featureCount: number;
  sources: readonly string[];
}

export interface ViewportResponse {
  body: unknown;
  headers: Pick<Headers, "get"> | undefined;
  /** The whole zoom level the request was made at. */
  zoom: number;
  receivedAt: number;
}

export interface ViewportWildfireSourceOptions<T = WildfireFeatureCollection> {
  active: boolean;
  sourceId: WildfireSourceId;
  /** The endpoint, or the endpoint for the whole zoom level of the view. */
  endpoint: string | ((zoom: number) => string);
  minZoom: number;
  refreshMs: number;
  /**
   * Validates a response; null when it is malformed. Defaults to the
   * perimeter envelope of `sourceId`.
   */
  read?(response: ViewportResponse): ViewportReading<T> | null;
  publish(data: T): void;
  clear(): void;
}

/** Reads the envelope the perimeter and burned-area routes answer with. */
function readEnvelope(
  sourceId: WildfireSourceId,
  { body }: ViewportResponse,
): ViewportReading<WildfireFeatureCollection> | null {
  if (sourceId !== "nifc" && sourceId !== "effis") return null;
  if (!isViewportWildfireFeatureCollection(body, sourceId)) return null;
  return {
    data: body,
    fetchedAt: Date.parse(body.fetchedAt),
    stale: body.stale,
    truncated: body.truncated,
    featureCount: body.features.length,
    sources: body.sources,
  };
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

function viewportUrl(
  endpointFor: string | ((zoom: number) => string),
  map: MaplibreMap,
): { url: string; zoom: number } | null {
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
  const endpoint = typeof endpointFor === "string" ? endpointFor : endpointFor(zoom);
  return { url: `${endpoint}${endpoint.includes("?") ? "&" : "?"}${query.toString()}`, zoom };
}

/**
 * Source-local viewport fetching with zoom gating, latest-wins requests, and
 * status updates. A changed endpoint refetches the view without clearing what
 * is drawn.
 */
export function useViewportWildfireSource<T = WildfireFeatureCollection>({
  active,
  sourceId,
  endpoint,
  minZoom,
  refreshMs,
  read,
  publish,
  clear,
}: ViewportWildfireSourceOptions<T>): boolean {
  const { mapRef, mapReady } = useMap();
  const setSourceStatus = useWildfireStore((state) => state.setSourceStatus);
  const resetSourceStatus = useWildfireStore((state) => state.resetSourceStatus);
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const readRef = useRef(read);
  readRef.current = read;
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

      const request = viewportUrl(endpointRef.current, map);
      if (!request) {
        abortRequest();
        lastRequestedUrlRef.current = null;
        setSourceStatus(sourceId, { loading: false, error: "unavailable" });
        return;
      }
      const { url, zoom } = request;
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
        const body: unknown = await result.json();
        if (controller.signal.aborted || generationRef.current !== generation) return;
        const response = { body, headers: result.headers, zoom, receivedAt: Date.now() };
        const reading = readRef.current
          ? readRef.current(response)
          : (readEnvelope(sourceId, response) as ViewportReading<T> | null);
        if (!reading) throw new Error("Invalid wildfire FeatureCollection");

        publish(reading.data);
        clearedRef.current = false;
        setSourceStatus(sourceId, {
          loading: false,
          fetchedAt: reading.fetchedAt,
          stale: reading.stale,
          truncated: reading.truncated,
          error: null,
          featureCount: reading.featureCount,
          sources: reading.sources,
        });
      } catch {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        setSourceStatus(sourceId, { loading: false, error: "unavailable" });
      } finally {
        if (generationRef.current === generation) controllerRef.current = null;
      }
    },
    [abortRequest, active, gateSource, mapRef, minZoom, publish, setSourceStatus, sourceId],
  );

  // A changed query is a new URL for the same view: the dedupe lets it through, and the newest
  // response replaces what is drawn.
  useEffect(() => {
    void endpoint;
    if (!active || !mapReady) return;
    const map = mapRef.current;
    if (!map || map.getZoom() < minZoom) return;
    void fetchViewport();
  }, [active, endpoint, fetchViewport, mapReady, mapRef, minZoom]);

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

    return () => {
      if (moveTimer) clearTimeout(moveTimer);
      map.off("moveend", onMoveEnd);
      abortRequest();
      // The aborted request was never answered: the next run must ask for the view again
      // instead of taking it for the one already in flight.
      lastRequestedUrlRef.current = null;
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
    resetSourceStatus,
    sourceId,
  ]);

  // Its own effect: a new refresh interval must not clear what is drawn.
  useEffect(() => {
    if (!active || !mapReady || !mapRef.current) return;
    const refreshTimer = setInterval(() => void fetchViewport(true), refreshMs);
    return () => clearInterval(refreshTimer);
  }, [active, fetchViewport, mapReady, mapRef, refreshMs]);

  return active && aboveMinZoom;
}
