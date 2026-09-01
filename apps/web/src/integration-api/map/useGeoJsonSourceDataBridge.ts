"use client";

import { useCallback, useEffect, useRef } from "react";
import type { MapContextValue } from "@/integration-api/map/MapContext";
import {
  createGeoJsonSourceDataBridge,
  type GeoJsonSourceDataApplyResult,
  type GeoJsonSourceDataBridge,
  type GeoJsonSourceDataEntry,
} from "./layerStyleUtils";

export interface GeoJsonSourceDataRequest {
  signal: AbortSignal;
  /** True only while this request may publish data to the visible overlay. */
  isCurrent: () => boolean;
  /** True until a newer request starts or the hook unmounts, including after a hide abort. */
  isLatest: () => boolean;
  cancel: () => void;
}

function incompatibleSignature(result: GeoJsonSourceDataApplyResult): string | null {
  if (result.status !== "incompatible") return null;
  return result.incompatibleSources
    .map(({ sourceId, sourceType }) => `${sourceId} (${sourceType})`)
    .sort()
    .join(", ");
}

/**
 * Connect a retained GeoJSON payload bridge to the map's style/source
 * lifecycle. Source-owning effects may create their sources before or after
 * this hook runs; the immediate pass, microtask pass, and MapLibre events cover
 * both orderings and style rebuilds.
 */
export function useGeoJsonSourceDataBridge(
  params: Pick<MapContextValue, "mapRef" | "mapReady" | "styleVersion"> & {
    visible: boolean;
  },
): {
  publish: (entries: readonly GeoJsonSourceDataEntry[]) => GeoJsonSourceDataApplyResult | undefined;
  apply: () => GeoJsonSourceDataApplyResult | undefined;
  /** Clear currently mounted sources without retaining data while hidden. */
  reset: (entries: readonly GeoJsonSourceDataEntry[]) => void;
  clear: (sourceIds?: readonly string[]) => void;
  /** Start a latest-wins request that is aborted on replacement, hide, or unmount. */
  beginRequest: () => GeoJsonSourceDataRequest;
} {
  const { mapRef, mapReady, styleVersion, visible } = params;
  const bridgeRef = useRef<GeoJsonSourceDataBridge | null>(null);
  if (!bridgeRef.current) bridgeRef.current = createGeoJsonSourceDataBridge();
  const bridge = bridgeRef.current;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const mountedRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const reportedIncompatibilitiesRef = useRef(new Set<string>());

  const reportResult = useCallback((result: GeoJsonSourceDataApplyResult) => {
    const signature = incompatibleSignature(result);
    if (!signature || reportedIncompatibilitiesRef.current.has(signature)) return;
    reportedIncompatibilitiesRef.current.add(signature);
    console.error(
      `GeoJSON data bridge cannot update incompatible MapLibre source(s): ${signature}`,
    );
  }, []);

  const apply = useCallback(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const result = bridge.apply(map);
    reportResult(result);
    return result;
  }, [bridge, mapRef, reportResult]);

  const publish = useCallback(
    (entries: readonly GeoJsonSourceDataEntry[]) => {
      if (!visibleRef.current) return undefined;
      bridge.publish(entries);
      return apply();
    },
    [apply, bridge],
  );

  const reset = useCallback(
    (entries: readonly GeoJsonSourceDataEntry[]) => {
      bridge.publish(entries);
      try {
        apply();
      } finally {
        // A reset is a teardown operation, not replayable state. Forget it even
        // when MapLibre throws because the style is disappearing underneath us.
        bridge.clear(entries.map(({ sourceId }) => sourceId));
      }
    },
    [apply, bridge],
  );

  const clear = useCallback((sourceIds?: readonly string[]) => bridge.clear(sourceIds), [bridge]);

  const abortActiveRequest = useCallback(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  }, []);

  const beginRequest = useCallback((): GeoJsonSourceDataRequest => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    requestControllerRef.current = controller;
    if (!visibleRef.current) controller.abort();
    return {
      signal: controller.signal,
      isCurrent: () =>
        !controller.signal.aborted &&
        visibleRef.current &&
        requestGenerationRef.current === generation,
      isLatest: () => mountedRef.current && requestGenerationRef.current === generation,
      cancel: () => {
        controller.abort();
        if (requestGenerationRef.current === generation) {
          requestControllerRef.current = null;
        }
      },
    };
  }, []);

  useEffect(() => {
    if (visible) return;
    bridge.clear();
    abortActiveRequest();
  }, [abortActiveRequest, bridge, visible]);

  useEffect(() => {
    // React Strict Mode replays effects, so restore this flag in setup as well
    // as initializing it during render.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      abortActiveRequest();
    };
  }, [abortActiveRequest]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !visible) return;

    let disposed = false;
    let microtaskPending = false;
    const applyWhenReady = () => {
      if (disposed || !visibleRef.current) return;
      const result = bridge.apply(map);
      reportResult(result);
      if (result.status === "incompatible" || microtaskPending) return;
      // A source-owning effect can run later in the same React commit or later
      // in the same MapLibre event. Run once after those handlers finish.
      microtaskPending = true;
      queueMicrotask(() => {
        microtaskPending = false;
        if (!disposed && visibleRef.current) {
          const replayResult = bridge.apply(map);
          reportResult(replayResult);
        }
      });
    };

    applyWhenReady();
    map.on("style.load", applyWhenReady);
    map.on("styledata", applyWhenReady);
    map.on("idle", applyWhenReady);

    return () => {
      disposed = true;
      map.off("style.load", applyWhenReady);
      map.off("styledata", applyWhenReady);
      map.off("idle", applyWhenReady);
    };
  }, [bridge, mapReady, mapRef, reportResult, styleVersion, visible]);

  return { publish, apply, reset, clear, beginRequest };
}
