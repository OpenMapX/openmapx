"use client";

import { usePlaceStore } from "@openmapx/core";
import { usePinMarker } from "@/hooks/usePinMarker";

export function SelectedPlaceMarker() {
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  usePinMarker(selectedPlace?.coordinates ?? null, selectedPlace?.name ?? "");
  return null;
}
