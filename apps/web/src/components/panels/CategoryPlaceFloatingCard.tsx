"use client";

import Paper from "@mui/material/Paper";
import {
  useCategorySearchStore,
  useDataSourceStore,
  useMergedPlace,
  usePlaceStore,
} from "@openmapx/core";
import { PANEL_WIDTH } from "@/lib/layout";
import { PlaceDetailContent } from "./place/PlaceDetailContent";

const CARD_WIDTH = 376;
const CARD_GAP = 24;

export function CategoryPlaceFloatingCard() {
  const { selectedPlace, setSelectedPlace } = usePlaceStore();
  const { activeCategory } = useCategorySearchStore();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const clearSelection = useDataSourceStore((s) => s.clearSelection);

  const { place, isLoading } = useMergedPlace(selectedPlace);

  // Show when a place is selected and either a category or data source is active
  if (!place || (activeCategory === null && activeSource === null)) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "absolute",
        left: { xs: 0, sm: PANEL_WIDTH + CARD_GAP },
        top: { xs: "auto", sm: 66 },
        bottom: { xs: 0, sm: "auto" },
        right: { xs: 0, sm: "auto" },
        width: { xs: "100%", sm: CARD_WIDTH },
        maxHeight: { xs: "65dvh", sm: "calc(100dvh - 78px)" },
        overflowY: "auto",
        borderRadius: { xs: "16px 16px 0 0", sm: 2 },
        zIndex: 10,
      }}
    >
      <PlaceDetailContent
        place={place}
        isLoading={isLoading}
        onClose={() => {
          setSelectedPlace(null);
          if (activeSource) clearSelection();
        }}
      />
    </Paper>
  );
}
