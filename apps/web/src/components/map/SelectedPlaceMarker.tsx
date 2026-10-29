"use client";

import { PANEL, useMergedPlace, usePlaceStore, useSidebarStore } from "@openmapx/core";
import {
  contributorsForField,
  contributorsForRecordFields,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { usePinMarker } from "@/hooks/usePinMarker";
import { useHiddenStylePoi } from "./useHiddenStylePoi";

export function SelectedPlaceMarker() {
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  // The pin carries the same name as the place panel's title, which is the
  // merged name, not necessarily the one the place was selected under.
  const { place } = useMergedPlace(selectedPlace);
  const name = place?.name || selectedPlace?.name || "";
  const coordinatesContributors = selectedPlace
    ? contributorsForRecordFields(selectedPlace, ["coordinates.0", "coordinates.1"])
    : [];
  usePinMarker(
    selectedPlace?.coordinates ?? null,
    name,
    true,
    undefined,
    selectedPlace ? () => useSidebarStore.getState().openDetail(PANEL.PLACE_CARD) : undefined,
    coordinatesContributors,
    snapshotContributors(
      coordinatesContributors,
      place?.name
        ? contributorsForField(place, "name")
        : selectedPlace
          ? contributorsForField(selectedPlace, "name")
          : [],
    ),
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
