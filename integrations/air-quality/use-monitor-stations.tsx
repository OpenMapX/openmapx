"use client";

import type {
  AirQualityStationFeature,
  AirQualityStationsResponse,
  AirQualityWarningCode,
  Pollutant,
} from "@openmapx/air-quality";
import { apiClient, isApiClientError, useDebouncedCallback } from "@openmapx/core";
import { useCallback, useEffect, useRef } from "react";
import { useGeoJsonSourceDataBridge } from "@/components/map/layers/useGeoJsonSourceDataBridge";
import { useMap } from "@/lib/MapContext";

import { useAirQualityStore } from "./store";

export const MONITOR_SOURCE_ID = "openmapx-air-quality-monitor-stations";
export const MONITOR_MIN_ZOOM = 5;
const PAGE_SIZE = 500;
const MAX_FEATURES = 2_000;
const MOVE_DEBOUNCE_MS = 800;
const STATIONS_ROUTE = "/api/integrations/air-quality/stations";

interface SnapshotResult {
  features: AirQualityStationFeature[];
  warnings: AirQualityWarningCode[];
  truncated: boolean;
}

function isCursorExpired(error: unknown): boolean {
  return isApiClientError(error) && error.status === 409;
}

function isQuotaError(error: unknown): boolean {
  return isApiClientError(error) && error.status === 429;
}

async function loadSnapshot(input: {
  baseQuery: Record<string, string>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  allowRestart: boolean;
}): Promise<SnapshotResult | null> {
  const features: AirQualityStationFeature[] = [];
  const warnings = new Set<AirQualityWarningCode>();
  let cursor: string | null = null;
  let truncated = false;

  for (;;) {
    let response: AirQualityStationsResponse;
    try {
      response = await apiClient.get<AirQualityStationsResponse>(
        STATIONS_ROUTE,
        cursor ? { ...input.baseQuery, cursor } : input.baseQuery,
        { signal: input.signal },
      );
    } catch (error) {
      if (cursor && input.allowRestart && isCursorExpired(error) && input.isCurrent()) {
        return loadSnapshot({ ...input, allowRestart: false });
      }
      throw error;
    }
    if (!input.isCurrent()) return null;

    const remaining = MAX_FEATURES - features.length;
    features.push(...response.features.slice(0, remaining));
    for (const warning of response.meta.warnings) warnings.add(warning);
    truncated ||= response.meta.truncated || response.features.length > remaining;
    cursor = response.nextCursor;

    if (!cursor) break;
    if (features.length >= MAX_FEATURES) {
      truncated = true;
      break;
    }
  }

  return { features, warnings: [...warnings], truncated };
}

export function useMonitorStations(): void {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useAirQualityStore((state) => state.layerVisible);
  const mode = useAirQualityStore((state) => state.mode);
  const setLoading = useAirQualityStore((state) => state.setLoading);
  const setSnapshotStatus = useAirQualityStore((state) => state.setSnapshotStatus);
  const setRequestError = useAirQualityStore((state) => state.setRequestError);
  const clearSnapshotStatus = useAirQualityStore((state) => state.clearSnapshotStatus);
  const active = layerVisible && mode.kind === "monitors";
  const pollutant: Pollutant = mode.kind === "monitors" ? mode.pollutant : "pm25";
  const { publish, reset, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: active,
  });
  const previousPollutantRef = useRef(pollutant);

  useEffect(() => {
    if (!active) {
      previousPollutantRef.current = pollutant;
      return;
    }
    if (previousPollutantRef.current === pollutant) return;
    previousPollutantRef.current = pollutant;
    reset([
      {
        sourceId: MONITOR_SOURCE_ID,
        data: { type: "FeatureCollection", features: [] },
      },
    ]);
  }, [active, pollutant, reset]);

  const requestViewport = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;

    const request = beginRequest();
    if (map.getZoom() < MONITOR_MIN_ZOOM) {
      request.cancel();
      setLoading(false);
      return;
    }

    const bounds = map.getBounds();
    const baseQuery = {
      south: String(bounds.getSouth()),
      west: String(bounds.getWest()),
      north: String(bounds.getNorth()),
      east: String(bounds.getEast()),
      zoom: String(Math.max(0, Math.min(22, Math.floor(map.getZoom())))),
      pollutant,
      limit: String(PAGE_SIZE),
    };

    setLoading(true);
    try {
      const snapshot = await loadSnapshot({
        baseQuery,
        signal: request.signal,
        isCurrent: request.isCurrent,
        allowRestart: true,
      });
      if (!snapshot || !request.isCurrent()) return;
      publish([
        {
          sourceId: MONITOR_SOURCE_ID,
          data: { type: "FeatureCollection", features: snapshot.features },
        },
      ]);
      if (!request.isCurrent()) return;
      setSnapshotStatus({
        warnings: snapshot.warnings,
        truncated: snapshot.truncated,
        activeSourceIds: snapshot.features.flatMap(({ properties }) => properties.sourceIds),
        stationCount: snapshot.features.length,
      });
    } catch (error) {
      if (!request.isCurrent() || request.signal.aborted) return;
      setRequestError(isQuotaError(error) ? "quota" : "unavailable");
    } finally {
      if (request.isLatest() && request.isCurrent()) setLoading(false);
    }
  }, [
    active,
    beginRequest,
    mapReady,
    mapRef,
    pollutant,
    publish,
    setLoading,
    setRequestError,
    setSnapshotStatus,
  ]);

  useEffect(() => {
    if (!active) {
      clearSnapshotStatus();
      return;
    }
    void requestViewport();
    return () => clearSnapshotStatus();
  }, [active, clearSnapshotStatus, requestViewport]);

  const requestAfterMove = useDebouncedCallback(() => {
    void requestViewport();
  }, MOVE_DEBOUNCE_MS);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;
    map.on("moveend", requestAfterMove);
    return () => {
      map.off("moveend", requestAfterMove);
    };
  }, [active, mapReady, mapRef, requestAfterMove]);
}
