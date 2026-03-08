"use client";

import AccountBalanceIcon from "@mui/icons-material/AccountBalance";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import HotelIcon from "@mui/icons-material/Hotel";
import LocalActivityIcon from "@mui/icons-material/LocalActivity";
import LocalAtmIcon from "@mui/icons-material/LocalAtm";
import LocalPharmacyIcon from "@mui/icons-material/LocalPharmacy";
import RestaurantIcon from "@mui/icons-material/Restaurant";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import type { CategoryId } from "@openmapx/core";
import {
  CATEGORY_DEFINITIONS,
  useCategorySearchStore,
  useDirectionsStore,
  useSearchStore,
} from "@openmapx/core";
import type { ReactNode } from "react";

const CATEGORY_ICONS: Partial<Record<CategoryId, ReactNode>> = {
  restaurants: <RestaurantIcon sx={{ fontSize: 16 }} />,
  hotels: <HotelIcon sx={{ fontSize: 16 }} />,
  activities: <LocalActivityIcon sx={{ fontSize: 16 }} />,
  museums: <AccountBalanceIcon sx={{ fontSize: 16 }} />,
  transit: <DirectionsBusIcon sx={{ fontSize: 16 }} />,
  pharmacies: <LocalPharmacyIcon sx={{ fontSize: 16 }} />,
  atms: <LocalAtmIcon sx={{ fontSize: 16 }} />,
};

export function CategoryChips() {
  const { activeCategory, setActiveCategory, clearCategory } = useCategorySearchStore();
  const { setQuery } = useSearchStore();
  const { isOpen: directionsOpen } = useDirectionsStore();

  if (directionsOpen || activeCategory) return null;

  return (
    <Box
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
        // Ensure chips don't get clipped visually
        py: "2px",
      }}
    >
      <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>
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
              onClick={() => {
                if (isActive) {
                  clearCategory();
                  setQuery("");
                } else {
                  setActiveCategory(cat.id);
                  setQuery(cat.label);
                }
              }}
              variant={isActive ? "filled" : "outlined"}
              sx={{
                height: 36,
                borderRadius: "18px",
                fontWeight: 500,
                fontSize: 13,
                bgcolor: isActive ? "#007b8b" : "background.paper",
                color: isActive ? "#fff" : "text.primary",
                borderColor: isActive ? "#007b8b" : "rgba(0,0,0,0.23)",
                boxShadow: isActive ? "none" : "0 1px 3px rgba(0,0,0,0.15)",
                cursor: "pointer",
                userSelect: "none",
                flexShrink: 0,
                "& .MuiChip-icon": {
                  color: "inherit",
                  ml: "10px",
                  mr: "-4px",
                },
                "&&:hover": {
                  bgcolor: isActive ? "#006475" : "grey.300",
                },
              }}
            />
          );
        })}
      </Box>
    </Box>
  );
}
