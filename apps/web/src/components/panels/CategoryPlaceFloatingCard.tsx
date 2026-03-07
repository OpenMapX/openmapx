"use client";

import Paper from "@mui/material/Paper";
import { useCategorySearchStore, usePlaceDetails, usePlaceStore } from "@openmapx/core";
import { PlaceDetailContent } from "./place/PlaceDetailContent";

const SIDEBAR_WIDTH = 400;
const CARD_WIDTH = 376;
const CARD_GAP = 24;

export function CategoryPlaceFloatingCard() {
  const { selectedPlace, setSelectedPlace } = usePlaceStore();
  const { activeCategory } = useCategorySearchStore();

  const { data: details, isLoading } = usePlaceDetails(
    selectedPlace?.id ?? null,
    selectedPlace?.coordinates,
    selectedPlace?.name,
  );

  const place = details ?? selectedPlace;

  if (!place || activeCategory === null) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "absolute",
        // Desktop: float to the right of the category sidebar
        left: { xs: 0, sm: SIDEBAR_WIDTH + CARD_GAP },
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
        onClose={() => setSelectedPlace(null)}
      />
    </Paper>
  );
}
