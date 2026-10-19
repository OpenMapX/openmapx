import {
  createPlace,
  idsFromPrimary,
  PANEL,
  type SavedPlace,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { savedPlaceContributorsForPlace } from "@openmapx/core/saved-place-contributors";

export function savedPlaceToPlace(place: SavedPlace) {
  const identity = (place.placeId ? idsFromPrimary(place.placeId) : null) ?? {
    primaryScheme: "saved",
    ids: { saved: place.id },
  };
  return createPlace({
    ...identity,
    ...savedPlaceContributorsForPlace(place.fieldContributors),
    name: place.name,
    address: place.address ?? "",
    coordinates: [place.lng, place.lat],
  });
}

export function openSavedPlace(
  place: SavedPlace,
  flyTo: (coordinates: [number, number], zoom: number) => void,
) {
  usePlaceStore.getState().setSelectedPlace(savedPlaceToPlace(place));
  useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  flyTo([place.lng, place.lat], 15);
}
