"use client";

import {
  createPlace,
  PANEL,
  type Place,
  useDataSourceDetail,
  useDataSourceStore,
  useDataSources,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { useEffect, useMemo } from "react";

export function DataSourceDetailBridge() {
  const selectedItem = useDataSourceStore((s) => s.selectedItem);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const { data: sourcesData } = useDataSources();

  const sourceMeta = useMemo(() => {
    if (!selectedItem || !sourcesData?.sources) return null;
    return sourcesData.sources.find((s) => s.id === selectedItem.sourceId) ?? null;
  }, [selectedItem, sourcesData]);

  const { data: detail } = useDataSourceDetail(
    selectedItem?.sourceId ?? null,
    selectedItem?.itemId ?? null,
  );

  useEffect(() => {
    if (!detail || !selectedItem) return;

    // Skip fallback details with invalid coordinates (station not in cache)
    if (detail.coordinates[0] === 0 && detail.coordinates[1] === 0) return;

    const addressParts = [
      detail.address?.line1,
      detail.address?.town,
      detail.address?.country,
    ].filter(Boolean);

    // Data-source places use the provider id as the primary scheme — each
    // data-source integration registers a resolver under its own id
    // (ev-charging, parking, fuel, …).
    const scheme = selectedItem.sourceId;
    const place: Place = createPlace({
      primaryScheme: scheme,
      ids: { [scheme]: detail.id },
      name: detail.name,
      address: addressParts.join(", "),
      city: detail.address?.town,
      coordinates: detail.coordinates,
      category: sourceMeta?.placeCategory ?? detail.name,
      rawCategory: sourceMeta?.placeCategoryRaw ?? "",
      website: detail.operator?.url,
      openingHours: detail.openingHours,
      dataSourceDetail: detail,
    });

    setSelectedPlace(place);
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  }, [detail, selectedItem, setSelectedPlace, sourceMeta]);

  return null;
}
