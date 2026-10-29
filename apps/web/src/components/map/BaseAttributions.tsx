"use client";
import { buildAttributionPresentation } from "@openmapx/core/attribution";
import { useEffect, useId } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { installedNativeBasemap } from "@/integration-api/overlay/nativeBasemap";

/** Conservatively credit the installed native style; never inspect viewport exposure. */
export function BaseAttributions() {
  const { mapRef, mapReady } = useMap();
  const map = mapRef.current;
  const instance = useId();
  useEffect(() => {
    if (!map || !mapReady) return;
    const owner = `native-basemap:${instance}`;
    const unsubscribe = installedNativeBasemap(map).subscribe((receipts) => {
      const entries = receipts.map((receipt) => buildAttributionPresentation(receipt, "map"));
      const store = useMapAttributionStore.getState();
      if (entries.length) store.setLayer(owner, entries);
      else store.clearLayer(owner);
    });
    return () => {
      unsubscribe();
      useMapAttributionStore.getState().clearLayer(owner);
    };
  }, [map, mapReady, instance]);
  return null;
}
