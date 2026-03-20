"use client";

import type { Place } from "@openmapx/core";
import {
  PANEL,
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
    if (!detail) return;

    // Skip fallback details with invalid coordinates (station not in cache)
    if (detail.coordinates[0] === 0 && detail.coordinates[1] === 0) return;

    const addressParts = [
      detail.address?.line1,
      detail.address?.town,
      detail.address?.country,
    ].filter(Boolean);

    const place: Place = {
      id: detail.id,
      name: detail.name,
      address: addressParts.join(", "),
      city: detail.address?.town,
      coordinates: detail.coordinates,
      category: sourceMeta?.placeCategory ?? detail.name,
      rawCategory: sourceMeta?.placeCategoryRaw ?? "",
      website: detail.operator?.url,
      openingHours: detail.openingHours,
      dataSourceDetail: detail,
    };

    setSelectedPlace(place);
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  }, [detail, setSelectedPlace, sourceMeta]);

  return null;
}
