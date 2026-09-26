"use client";

import { PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";
import { usePinMarker } from "@/hooks/usePinMarker";

export function SelectedPlaceMarker() {
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  usePinMarker(
    selectedPlace?.coordinates ?? null,
    selectedPlace?.name ?? "",
    true,
    undefined,
    selectedPlace ? () => useSidebarStore.getState().openDetail(PANEL.PLACE_CARD) : undefined,
  );
  return null;
}
