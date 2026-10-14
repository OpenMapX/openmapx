"use client";
import { useEffect, useId } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { renderedMapAttributionTracker } from "@/integration-api/overlay/renderedMapAttributionTracker";

/** Native basemap pixels use installed receipts and the shared rendered pass. */
export function BaseAttributions() {
  const { mapRef, mapReady } = useMap();
  const map = mapRef.current;
  const instance = useId();
  useEffect(() => {
    if (!map || !mapReady) return;
    const owner = `native-basemap:${instance}`;
    return renderedMapAttributionTracker(map).subscribe(owner, {
      kind: "native",
      publish: (entries) => {
        const store = useMapAttributionStore.getState();
        if (entries.length) store.setLayer(owner, entries);
        else store.clearLayer(owner);
      },
    });
  }, [map, mapReady, instance]);
  return null;
}
