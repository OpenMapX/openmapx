"use client";

import type { Place } from "@openmapx/core";
import { useDataSourceDetail, useDataSourceStore, usePlaceStore } from "@openmapx/core";
import { useEffect } from "react";

export function DataSourceDetailBridge() {
  const selectedItem = useDataSourceStore((s) => s.selectedItem);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);

  const { data: detail } = useDataSourceDetail(
    selectedItem?.sourceId ?? null,
    selectedItem?.itemId ?? null,
  );

  useEffect(() => {
    if (!detail) return;

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
      category: "Charging Station",
      rawCategory: "charging_station",
      website: detail.operator?.url,
      dataSourceDetail: detail,
    };

    setSelectedPlace(place);
  }, [detail, setSelectedPlace]);

  return null;
}
