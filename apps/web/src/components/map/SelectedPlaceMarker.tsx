"use client";

import { PANEL, useMergedPlace, usePlaceStore, useSidebarStore } from "@openmapx/core";
import { usePinMarker } from "@/hooks/usePinMarker";
import { useHiddenStylePoi } from "./useHiddenStylePoi";

export function SelectedPlaceMarker() {
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  // The pin carries the same name as the place panel's title, which is the
  // merged name, not necessarily the one the place was selected under.
  const { place } = useMergedPlace(selectedPlace);
  const name = place?.name || selectedPlace?.name || "";
  usePinMarker(
    selectedPlace?.coordinates ?? null,
    name,
    true,
    undefined,
    selectedPlace ? () => useSidebarStore.getState().openDetail(PANEL.PLACE_CARD) : undefined,
  );
  useHiddenStylePoi(
    selectedPlace
      ? {
          coordinates: selectedPlace.coordinates,
          names: [selectedPlace.name, name],
          stylePoiId: selectedPlace.ids?.stylePoi,
        }
      : null,
  );
  return null;
}
