"use client";

import SearchIcon from "@mui/icons-material/Search";
import Chip from "@mui/material/Chip";
import { useCategorySearchStore, useDataSourceStore, usePlaceStore } from "@openmapx/core";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMap } from "@/lib/MapContext";

// Floating card: sidebar(400) + gap(24) + card(376) = 800px from left edge
const FLOATING_CARD_RIGHT_EDGE = 800;

export function SearchInAreaChip() {
  const {
    activeCategory,
    mapMoved: categoryMoved,
    setSearchBbox: setCategorySearchBbox,
    setMapMoved: setCategoryMapMoved,
  } = useCategorySearchStore();
  const { selectedPlace } = usePlaceStore();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const dsMapMoved = useDataSourceStore((s) => s.mapMoved);
  const setDsSearchBbox = useDataSourceStore((s) => s.setSearchBbox);
  const setDsMapMoved = useDataSourceStore((s) => s.setMapMoved);
  const { mapRef } = useMap();

  const floatingCardOpen = activeCategory !== null && selectedPlace !== null;

  // Show when either a category or data source is active and map has moved
  const showForCategory = activeCategory !== null && categoryMoved;
  const showForDataSource = activeSource !== null && dsMapMoved;

  if (!showForCategory && !showForDataSource) return null;

  const handleClick = () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const bbox = {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    };

    if (showForCategory) {
      setCategorySearchBbox(bbox);
      setCategoryMapMoved(false);
    }

    if (showForDataSource) {
      setDsSearchBbox(bbox);
      setDsMapMoved(false);
    }
  };

  return (
    <Chip
      label="Search in this area"
      icon={<SearchIcon sx={{ fontSize: 16, color: "inherit !important" }} />}
      onClick={handleClick}
      sx={{
        position: "absolute",
        // Below the category chips row:
        // Desktop: chips at top=18, height=40px → top=66; Mobile: chips at top=72 → top=120
        top: { xs: 120, sm: 66 },
        // When the floating card is open, center in the remaining map area to its right.
        // Remaining area: FLOATING_CARD_RIGHT_EDGE → 100vw, center = (edge + 100%) / 2
        left: {
          xs: "50%",
          sm: floatingCardOpen
            ? `calc(${FLOATING_CARD_RIGHT_EDGE / 2}px + 50%)`
            : `calc(${PANEL_WIDTH / 2}px + 50%)`,
        },
        transform: "translateX(-50%)",
        zIndex: 10,
        height: 36,
        borderRadius: "18px",
        fontWeight: 500,
        fontSize: 13,
        bgcolor: "background.paper",
        color: "text.primary",
        boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
        cursor: "pointer",
        userSelect: "none",
        border: "1px solid rgba(0,0,0,0.15)",
        "& .MuiChip-icon": {
          color: "#007b8b",
          ml: "10px",
          mr: "-4px",
        },
        "&&:hover": {
          bgcolor: "grey.100",
        },
      }}
    />
  );
}
