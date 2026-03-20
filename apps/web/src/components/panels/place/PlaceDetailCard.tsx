"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import { useDataSourceStore, useMergedPlace, usePlaceStore, useSidebarStore } from "@openmapx/core";
import { PlaceDetailContent } from "./PlaceDetailContent";

export function PlaceDetailCard() {
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const { place, isLoading } = useMergedPlace(selectedPlace);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const closeDetail = useSidebarStore((s) => s.closeDetail);
  const clearSelection = useDataSourceStore((s) => s.clearSelection);

  if (!place) return null;

  return (
    <Box sx={{ position: "relative" }}>
      <IconButton
        size="small"
        onClick={() => {
          setSelectedPlace(null);
          clearSelection();
          closeDetail();
        }}
        sx={{ position: "absolute", right: 8, top: 8, zIndex: 1 }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
      <PlaceDetailContent place={place} isLoading={isLoading} />
    </Box>
  );
}
