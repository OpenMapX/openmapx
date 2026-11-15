import type { LabeledPlace, LngLat } from "@openmapx/core";
import { createPlace, idsFromPrimary, PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";
import { savedPlaceContributorsForPlace } from "@openmapx/core/saved-place-contributors";

/** Opens a labelled place (Home, Work, a custom label) in the place panel and flies to it. */
export function openLabeledPlace(
  label: LabeledPlace,
  flyTo: (center: LngLat, zoom?: number) => void,
): void {
  const identity = (label.placeId ? idsFromPrimary(label.placeId) : null) ?? {
    primaryScheme: "label",
    ids: { label: label.id },
  };
  usePlaceStore.getState().setSelectedPlace(
    createPlace({
      ...identity,
      ...savedPlaceContributorsForPlace(label.fieldContributors),
      name: label.name,
      address: label.address ?? "",
      coordinates: [label.lng, label.lat],
    }),
  );
  useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  flyTo([label.lng, label.lat], 15);
}

/** The user's Home and Work, in that order, among their labelled places. */
export function homeAndWork(labels: readonly LabeledPlace[] | undefined) {
  return (["home", "work"] as const).flatMap((key) => {
    const label = labels?.find((l) => l.label.toLowerCase() === key);
    return label ? [{ key, label }] : [];
  });
}
