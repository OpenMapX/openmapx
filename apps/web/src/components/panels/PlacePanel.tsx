"use client";

import Paper from "@mui/material/Paper";
import {
  useCategorySearchStore,
  useDataSourceEnrichment,
  useDataSourceStore,
  usePlaceDetails,
  usePlaceStore,
  useReverseGeocoding,
} from "@openmapx/core";
import { useEffect, useState } from "react";
import { SidebarCollapseToggle } from "@/components/ui/SidebarCollapseToggle";
import { PANEL_WIDTH } from "@/lib/layout";
import { PlaceDetailContent } from "./place/PlaceDetailContent";

export function PlacePanel() {
  const { selectedPlace, setSidePanelCollapsed } = usePlaceStore();
  const { activeCategory } = useCategorySearchStore();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const selectedItem = useDataSourceStore((s) => s.selectedItem);
  const [collapsed, setCollapsed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => {
    setCollapsed(false);
  }, [selectedPlace?.id]);

  useEffect(() => {
    setSidePanelCollapsed(collapsed);
  }, [collapsed, setSidePanelCollapsed]);

  useEffect(() => {
    return () => setSidePanelCollapsed(false);
  }, [setSidePanelCollapsed]);

  // Coordinate/Plus Code places use a synthetic id — skip the API lookup
  // (it would always 404) and resolve the address via reverse geocoding instead.
  const isCoordinatePlace = selectedPlace?.id?.startsWith("coordinate-") ?? false;
  // Data source places (ocm:*, osm:*) also have synthetic IDs — skip place lookup,
  // use reverse geocoding to fill in the address.
  const isDataSourcePlace = selectedPlace?.dataSourceDetail !== undefined;
  const needsReverseGeo = isCoordinatePlace || isDataSourcePlace;

  const { data: details, isLoading } = usePlaceDetails(
    needsReverseGeo ? null : (selectedPlace?.id ?? null),
    selectedPlace?.coordinates,
    selectedPlace?.name,
  );

  const { data: reverseGeo } = useReverseGeocoding(
    needsReverseGeo ? (selectedPlace?.coordinates ?? null) : null,
  );

  // Try to enrich the place with data source detail (e.g. EV charger clicked on map style POI)
  const enrichedDetail = useDataSourceEnrichment(
    selectedPlace?.dataSourceDetail ? null : (selectedPlace ?? null),
  );

  const basePlace =
    details ??
    (selectedPlace
      ? {
          ...selectedPlace,
          ...(needsReverseGeo && reverseGeo
            ? {
                address: selectedPlace.address || reverseGeo.address,
                city: selectedPlace.city || reverseGeo.city?.split(",")[0].trim(),
              }
            : {}),
        }
      : null);

  // Preserve category/rawCategory from the original selection through enrichment,
  // so transit eligibility checks see the original POI type (e.g. "charging_station")
  // even after Nominatim overwrites the place with different category metadata.
  const withPreservedCategory =
    basePlace && selectedPlace && basePlace !== selectedPlace
      ? {
          ...basePlace,
          category: basePlace.category || selectedPlace.category,
          rawCategory: basePlace.rawCategory || selectedPlace.rawCategory,
        }
      : basePlace;

  // Merge enriched data source detail into the place if available
  const place =
    withPreservedCategory && enrichedDetail && !withPreservedCategory.dataSourceDetail
      ? { ...withPreservedCategory, dataSourceDetail: enrichedDetail }
      : withPreservedCategory;

  const showingDataSourceDetail = activeSource !== null && selectedItem !== null;

  // When a category is active, the floating card handles place display instead
  if (!place || (activeCategory !== null && !showingDataSourceDetail)) return null;

  return (
    <>
      <Paper
        elevation={0}
        sx={{
          position: "absolute",
          bottom: { xs: 0, sm: "auto" },
          top: { xs: "auto", sm: 0 },
          left: 0,
          right: { xs: 0, sm: "auto" },
          width: { xs: "100%", sm: PANEL_WIDTH },
          height: { xs: "auto", sm: "100dvh" },
          maxHeight: { xs: "60dvh", sm: "none" },
          overflowY: "auto",
          borderRadius: { xs: "16px 16px 0 0", sm: 0 },
          boxShadow: { xs: 6, sm: "4px 0 12px rgba(0,0,0,0.15)" },
          zIndex: 9,
          transform: { sm: collapsed ? "translateX(-100%)" : "translateX(0)" },
          transition: { sm: "transform 0.25s ease" },
        }}
      >
        <PlaceDetailContent place={place} isLoading={isLoading} clearSearchBar />
      </Paper>

      <SidebarCollapseToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
    </>
  );
}
