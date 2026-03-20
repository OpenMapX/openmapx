"use client";

import { useMergedPlace, usePlaceStore } from "@openmapx/core";
import { PlaceDetailContent } from "./PlaceDetailContent";

export function PlacePanelContent() {
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const { place, isLoading } = useMergedPlace(selectedPlace);

  if (!place) return null;

  return <PlaceDetailContent place={place} isLoading={isLoading} clearSearchBar />;
}
