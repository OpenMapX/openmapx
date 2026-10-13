import { createPlace, type LngLat, PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";

import {
  type ContributingRecord,
  contributorsForField,
  contributorsForRecordFields,
  type FieldContributors,
} from "@openmapx/mobility-core/contributors";

/**
 * Data-source id the ev-charging integration registers its stations under. A
 * charge-planning stop and a browsed charger are the same station: both ids come
 * from `gatherMergedStations`, so the detail lookup resolves either one.
 */
export const EV_CHARGING_SOURCE_ID = "ev-charging";

/** Station fields needed to preview a charger; a charge stop's `station` satisfies it. */
export interface ChargerPlaceTarget extends ContributingRecord {
  fieldContributors?: FieldContributors;
  id: string;
  name: string;
  coordinates: LngLat;
}

/**
 * Open a charging station in the floating place card, exactly as clicking it in
 * the data-source layer or result list does. The preview place is set straight
 * away so the card appears without waiting for the detail request; the panel
 * then fetches the full station detail from the same source.
 *
 * Shared by the charge-plan stop list and the map's charge-stop pins so both
 * routes into the card stay identical.
 */
export function openChargerPlace(
  station: ChargerPlaceTarget,
  meta?: { placeCategory?: string; placeCategoryRaw?: string },
): void {
  usePlaceStore.getState().setSelectedPlace(
    createPlace({
      primaryScheme: EV_CHARGING_SOURCE_ID,
      ids: { [EV_CHARGING_SOURCE_ID]: station.id },
      name: station.name,
      address: station.name,
      coordinates: station.coordinates,
      contributors: contributorsForRecordFields(station, ["id", "name", "coordinates"]),
      fieldContributors: {
        name: contributorsForField(station, "name"),
        address: contributorsForField(station, "name"),
        coordinates: contributorsForField(station, "coordinates"),
        [`ids.${EV_CHARGING_SOURCE_ID}`]: contributorsForField(station, "id"),
      },
      category: meta?.placeCategory,
      rawCategory: meta?.placeCategoryRaw,
    }),
  );
  useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
}
