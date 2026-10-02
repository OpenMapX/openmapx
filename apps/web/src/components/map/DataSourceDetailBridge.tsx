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
import { useEffect, useMemo, useRef } from "react";

export function DataSourceDetailBridge() {
  const selectedItem = useDataSourceStore((s) => s.selectedItem);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const placeRevision = usePlaceStore((s) => s.selectionRevision);
  const { data: sourcesData } = useDataSources();
  const selectionRevision = useRef<number | null>(null);
  const previousPlaceRevision = useRef<number | null>(null);
  const needsSelection = useRef(false);
  const ownedItem = useRef<typeof selectedItem | undefined>(undefined);

  // A fresh data-source choice owns its detail request. Retained metadata or
  // refetches must not reclaim the place after another user selection.
  useEffect(() => {
    if (ownedItem.current === selectedItem) return;
    ownedItem.current = selectedItem;
    const revision = usePlaceStore.getState().selectionRevision;
    // Marker/list clicks already published a preview. Context clicks only
    // selectItem, so even choosing the same item must start a fresh session.
    needsSelection.current = previousPlaceRevision.current === revision;
    selectionRevision.current = selectedItem ? revision : null;
  }, [selectedItem]);

  useEffect(() => {
    previousPlaceRevision.current = placeRevision;
  }, [placeRevision]);

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
    if (selectionRevision.current !== usePlaceStore.getState().selectionRevision) return;

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

    const current = usePlaceStore.getState();
    if (!needsSelection.current && current.selectedPlace?.ids[scheme] === detail.id) {
      // Preview resolution and refetch enrich the same detail session.
      current.enrichSelectedPlace(current.selectionRevision, place);
    } else {
      setSelectedPlace(place);
      selectionRevision.current = usePlaceStore.getState().selectionRevision;
    }
    needsSelection.current = false;
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  }, [detail, selectedItem, setSelectedPlace, sourceMeta]);

  return null;
}
