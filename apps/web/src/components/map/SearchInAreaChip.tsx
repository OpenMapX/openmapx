"use client";

import SearchIcon from "@mui/icons-material/Search";
import Chip from "@mui/material/Chip";
import {
  useCategorySearchStore,
  useDataSourceStore,
  useDataSources,
  usePlaceStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMap } from "@/lib/MapContext";
import { BRAND } from "@/lib/theme";

// Floating card: sidebar(400) + gap(24) + card(376) = 800px from left edge
const FLOATING_CARD_RIGHT_EDGE = 800;

export function SearchInAreaChip() {
  const t = useTranslations("search");
  const {
    activeCategory,
    autoRefresh,
    mapMoved: categoryMoved,
    setSearchBbox: setCategorySearchBbox,
    setMapMoved: setCategoryMapMoved,
  } = useCategorySearchStore();
  const mode = useCategorySearchStore((s) => s.mode);
  const anchor = useCategorySearchStore((s) => s.anchor);
  const isViewportText = mode === "text" && anchor === null;
  const { selectedPlace } = usePlaceStore();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const dsMapMoved = useDataSourceStore((s) => s.mapMoved);
  const viewportZoom = useDataSourceStore((s) => s.viewportZoom);
  const setDsSearchBbox = useDataSourceStore((s) => s.setSearchBbox);
  const setDsMapMoved = useDataSourceStore((s) => s.setMapMoved);
  const { data: sourcesData } = useDataSources();
  const { mapRef } = useMap();

  const activeMinZoom = useMemo(() => {
    if (!activeSource || !sourcesData?.sources) return 0;
    return sourcesData.sources.find((s) => s.id === activeSource)?.minZoom ?? 0;
  }, [activeSource, sourcesData]);

  const floatingCardOpen = (activeCategory !== null || isViewportText) && selectedPlace !== null;

  // Show when a category search, a viewport text search, or a data source is
  // active and the map has moved.
  const showForCategory =
    (activeCategory !== null || isViewportText) && categoryMoved && !autoRefresh;
  const showForDataSource = activeSource !== null && dsMapMoved && viewportZoom >= activeMinZoom;

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
      label={t("searchInArea")}
      icon={<SearchIcon sx={{ fontSize: 16, color: "inherit !important" }} />}
      onClick={handleClick}
      sx={{
        position: "absolute",
        // Below the category chips row:
        // Desktop: chips at top=18, height=40px → top=66; Mobile: chips at top=72 → top=120
        top: {
          xs: "calc(120px + var(--omx-safe-top))",
          sm: "calc(66px + var(--omx-safe-top))",
        },
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
        boxShadow: "0 2px 6px var(--omx-shadow-soft)",
        cursor: "pointer",
        userSelect: "none",
        border: "1px solid var(--omx-shadow-soft)",
        "& .MuiChip-icon": {
          color: BRAND,
          ml: "10px",
          mr: "-4px",
        },
        // `action.hover` is a translucent MUI overlay; using it as the full
        // bgcolor lets the map show through since this chip floats over the
        // map. `--omx-chip-hover` is opaque and theme-aware.
        "&&:hover": {
          bgcolor: "var(--omx-chip-hover)",
        },
      }}
    />
  );
}
