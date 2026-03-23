"use client";

import type { SvgIconComponent } from "@mui/icons-material";
import AccountBalanceIcon from "@mui/icons-material/AccountBalance";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import ElectricScooterIcon from "@mui/icons-material/ElectricScooter";
import EvStationIcon from "@mui/icons-material/EvStation";
import HotelIcon from "@mui/icons-material/Hotel";
import LocalActivityIcon from "@mui/icons-material/LocalActivity";
import LocalAtmIcon from "@mui/icons-material/LocalAtm";
import LocalGasStationIcon from "@mui/icons-material/LocalGasStation";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import LocalPharmacyIcon from "@mui/icons-material/LocalPharmacy";
import PedalBikeIcon from "@mui/icons-material/PedalBike";
import RestaurantIcon from "@mui/icons-material/Restaurant";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import type { CategoryId } from "@openmapx/core";
import {
  CATEGORY_DEFINITIONS,
  PANEL,
  useCategorySearchStore,
  useDataSourceStore,
  useDataSources,
  useDirectionsStore,
  useMapStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { TEAL } from "@/lib/theme";

const CATEGORY_ICONS: Partial<Record<CategoryId, ReactNode>> = {
  restaurants: <RestaurantIcon sx={{ fontSize: 16 }} />,
  hotels: <HotelIcon sx={{ fontSize: 16 }} />,
  activities: <LocalActivityIcon sx={{ fontSize: 16 }} />,
  museums: <AccountBalanceIcon sx={{ fontSize: 16 }} />,
  transit: <DirectionsBusIcon sx={{ fontSize: 16 }} />,
  pharmacies: <LocalPharmacyIcon sx={{ fontSize: 16 }} />,
  atms: <LocalAtmIcon sx={{ fontSize: 16 }} />,
};

const DATA_SOURCE_ICONS: Record<string, SvgIconComponent> = {
  "ev-charging": EvStationIcon,
  fuel: LocalGasStationIcon,
  parking: LocalParkingIcon,
  "bike-sharing": PedalBikeIcon,
  "scooter-sharing": ElectricScooterIcon,
  "car-sharing": DirectionsCarIcon,
};

export function CategoryChips() {
  const { activeCategory, setActiveCategory, clearCategory } = useCategorySearchStore();
  const { setQuery } = useSearchStore();
  const { isOpen: directionsOpen } = useDirectionsStore();
  const zoom = useMapStore((s) => s.zoom);
  const { activeSource, toggleSource, setActiveSource } = useDataSourceStore();
  const { data: sourcesData } = useDataSources();

  const handleSourceClick = useCallback(
    (sourceId: string, label: string, isActive: boolean) => {
      if (isActive) {
        toggleSource(sourceId);
        setQuery("");
        useSidebarStore.getState().closeSidebar();
      } else {
        clearCategory();
        toggleSource(sourceId);
        setQuery(label);
        useSidebarStore.getState().openSidebar(PANEL.DATASOURCE);
      }
    },
    [toggleSource, setQuery, clearCategory],
  );

  const handleCategoryClick = useCallback(
    (catId: CategoryId, label: string, isActive: boolean) => {
      if (isActive) {
        clearCategory();
        setQuery("");
        useSidebarStore.getState().closeSidebar();
      } else {
        setActiveSource(null);
        setActiveCategory(catId);
        setQuery(label);
        useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
      }
    },
    [clearCategory, setQuery, setActiveSource, setActiveCategory],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener("scroll", updateScrollState, { passive: true });
    return () => el.removeEventListener("scroll", updateScrollState);
  }, [updateScrollState]);

  const hidden = directionsOpen || activeCategory || activeSource;
  const zoomedOut = zoom < 9;

  if (hidden) return null;

  const FADE = 24;
  const leftEdge = canScrollLeft ? "transparent" : "black";
  const leftStop = canScrollLeft ? `black ${FADE}px` : "black 0px";
  const mask = `linear-gradient(to right, ${leftEdge}, ${leftStop}, black calc(100% - ${FADE}px), transparent)`;

  return (
    <Box
      ref={scrollRef}
      sx={{
        position: "absolute",
        // Desktop: same level as search bar. Mobile: below search bar (12+48+12=72)
        top: { xs: 72, sm: 18 },
        left: { xs: 0, sm: 420 },
        right: { xs: 0, sm: 108 },
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        px: { xs: 1, sm: 0 },
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
        "&::-webkit-scrollbar": { display: "none" },
        maskImage: mask,
        WebkitMaskImage: mask,
        // Ensure chips don't get clipped visually
        py: "2px",
        opacity: zoomedOut ? 0 : 1,
        pointerEvents: zoomedOut ? "none" : "auto",
        transition: "opacity 0.2s ease",
      }}
    >
      <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>
        {(sourcesData?.sources ?? []).map((source) => {
          const isActive = activeSource === source.id;
          const IconComponent = DATA_SOURCE_ICONS[source.id] ?? EvStationIcon;
          return (
            <Chip
              key={source.id}
              icon={
                <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
                  <IconComponent sx={{ fontSize: 16 }} />
                </Box>
              }
              label={source.categoryChipLabel}
              onClick={() => handleSourceClick(source.id, source.categoryChipLabel, isActive)}
              variant={isActive ? "filled" : "outlined"}
              color={isActive ? "primary" : "default"}
              sx={{
                height: 36,
                borderRadius: "18px",
                fontWeight: 500,
                fontSize: 13,
                bgcolor: isActive ? TEAL : "background.paper",
                color: isActive ? "#fff" : "text.primary",
                borderColor: isActive ? TEAL : "var(--omx-border)",
                boxShadow: isActive ? "none" : "0 1px 3px var(--omx-shadow-soft)",
                cursor: "pointer",
                userSelect: "none",
                flexShrink: 0,
                "& .MuiChip-icon": {
                  color: "inherit",
                  ml: "10px",
                  mr: "-4px",
                },
                "&&:hover": {
                  bgcolor: isActive ? "var(--omx-teal-hover)" : "var(--omx-chip-hover)",
                },
              }}
            />
          );
        })}
        {CATEGORY_DEFINITIONS.filter((cat) => cat.showInChipBar).map((cat) => {
          const isActive = activeCategory === cat.id;
          return (
            <Chip
              key={cat.id}
              label={cat.label}
              icon={
                <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
                  {CATEGORY_ICONS[cat.id]}
                </Box>
              }
              onClick={() => handleCategoryClick(cat.id, cat.label, isActive)}
              variant={isActive ? "filled" : "outlined"}
              sx={{
                height: 36,
                borderRadius: "18px",
                fontWeight: 500,
                fontSize: 13,
                bgcolor: isActive ? TEAL : "background.paper",
                color: isActive ? "#fff" : "text.primary",
                borderColor: isActive ? TEAL : "var(--omx-border)",
                boxShadow: isActive ? "none" : "0 1px 3px var(--omx-shadow-soft)",
                cursor: "pointer",
                userSelect: "none",
                flexShrink: 0,
                "& .MuiChip-icon": {
                  color: "inherit",
                  ml: "10px",
                  mr: "-4px",
                },
                "&&:hover": {
                  bgcolor: isActive ? "var(--omx-teal-hover)" : "var(--omx-chip-hover)",
                },
              }}
            />
          );
        })}
      </Box>
    </Box>
  );
}
