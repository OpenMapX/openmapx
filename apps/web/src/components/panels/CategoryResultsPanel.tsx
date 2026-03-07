"use client";

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { CategoryId, CategoryPlace, OpeningHoursFilter } from "@openmapx/core";
import {
  isOpenAt,
  parseOpeningHours,
  useCategorySearch,
  useCategorySearchStore,
  usePlaceStore,
} from "@openmapx/core";

function applyHoursFilter(
  results: CategoryPlace[],
  filter: OpeningHoursFilter,
  openAtDay: number | null,
  openAtHour: number | null,
): CategoryPlace[] {
  if (filter === "any") return results;
  if (filter === "open_24h") return results.filter((p) => p.openingHours === "24/7");
  if (filter === "open_now")
    return results.filter((p) => parseOpeningHours(p.openingHours)?.isOpen === true);
  if (filter === "open_at") {
    if (openAtDay === null && openAtHour === null) return results;
    return results.filter((p) => isOpenAt(p.openingHours, openAtDay, openAtHour));
  }
  return results;
}

import { useEffect, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";

const PANEL_WIDTH = 400;

function CategoryPlaceCard({
  place,
  isHovered,
  onSelect,
  onHover,
  onHoverEnd,
}: {
  place: CategoryPlace;
  isHovered: boolean;
  onSelect: (place: CategoryPlace) => void;
  onHover: (id: string) => void;
  onHoverEnd: () => void;
}) {
  const tagLabel = place.category
    ? place.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;

  return (
    <Box
      component="button"
      type="button"
      onClick={() => onSelect(place)}
      onMouseEnter={() => onHover(place.id)}
      onMouseLeave={onHoverEnd}
      sx={{
        width: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        cursor: "pointer",
        px: 2,
        py: 1.5,
        bgcolor: isHovered ? "rgba(0,0,0,0.06)" : "transparent",
        "&:hover": { bgcolor: "rgba(0,0,0,0.06)" },
      }}
    >
      <Typography variant="body1" fontWeight={600} sx={{ mb: 0.25 }}>
        {place.name}
      </Typography>

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center", mb: 0.25 }}>
        {tagLabel && (
          <Typography variant="caption" color="text.secondary">
            {tagLabel}
          </Typography>
        )}
        {tagLabel && place.address && (
          <Typography variant="caption" color="text.secondary">
            ·
          </Typography>
        )}
        {place.address && (
          <Typography variant="caption" color="text.secondary">
            {place.address}
          </Typography>
        )}
      </Box>

      {(() => {
        const hours = parseOpeningHours(place.openingHours);
        if (!hours) return null;
        return (
          <Typography variant="caption" color={hours.isOpen ? "success.main" : "error.main"}>
            {hours.isOpen ? `Open · ${hours.detail}` : `Closed · ${hours.detail}`}
          </Typography>
        );
      })()}
    </Box>
  );
}

export function CategoryResultsPanel() {
  const {
    activeCategory,
    searchBbox,
    setSearchBbox,
    setMapMoved,
    hoveredCategoryPlaceId,
    setHoveredCategoryPlaceId,
    openingHoursFilter,
    openAtDay,
    openAtHour,
  } = useCategorySearchStore();
  const { setSelectedPlace } = usePlaceStore();
  const { flyTo, mapRef, mapReady } = useMap();
  const [collapsed, setCollapsed] = useState(false);
  const prevCategoryRef = useRef<CategoryId | null>(null);

  const { data: rawResults, isLoading, isError } = useCategorySearch(activeCategory, searchBbox);
  const results = rawResults
    ? applyHoursFilter(rawResults, openingHoursFilter, openAtDay, openAtHour)
    : rawResults;

  // Auto-search when category becomes active or changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger on activeCategory change
  useEffect(() => {
    if (!activeCategory || !mapRef.current || !mapReady) return;
    if (activeCategory === prevCategoryRef.current) return;
    prevCategoryRef.current = activeCategory;

    const bounds = mapRef.current.getBounds();
    setSearchBbox({
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    });
    setCollapsed(false);
    setMapMoved(false);
  }, [activeCategory, mapReady]);

  // Clear prev category ref when category is cleared
  useEffect(() => {
    if (!activeCategory) {
      prevCategoryRef.current = null;
      setMapMoved(false);
    }
  }, [activeCategory, setMapMoved]);

  // Listen for map movement to show "Search in this area"
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !activeCategory) return;

    const onMoveEnd = () => setMapMoved(true);
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [mapRef, mapReady, activeCategory, setMapMoved]);

  const handleSelectPlace = (place: CategoryPlace) => {
    flyTo(place.coordinates, 17);
    setSelectedPlace({
      id: place.id,
      name: place.name,
      address: place.address ?? place.name,
      coordinates: place.coordinates,
      category: place.category,
      phone: place.phone,
      website: place.website,
      openingHours: place.openingHours,
    });
  };

  if (!activeCategory) return null;

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
          maxHeight: { xs: "65dvh", sm: "none" },
          overflowY: "auto",
          borderRadius: { xs: "16px 16px 0 0", sm: 0 },
          boxShadow: { xs: 6, sm: "4px 0 12px rgba(0,0,0,0.15)" },
          zIndex: 9,
          transform: { sm: collapsed ? "translateX(-100%)" : "translateX(0)" },
          transition: { sm: "transform 0.25s ease" },
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Results area */}
        <Box sx={{ flex: 1, overflowY: "auto", pt: { xs: 2, sm: "72px" } }}>
          {isLoading && (
            <Box sx={{ px: 2, py: 2 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <Box key={i} sx={{ mb: 2 }}>
                  <Skeleton variant="text" width="60%" height={20} />
                  <Skeleton variant="text" width="80%" height={16} />
                </Box>
              ))}
            </Box>
          )}

          {isError && (
            <Box sx={{ px: 2, py: 2 }}>
              <Alert severity="error" variant="outlined">
                Failed to load results. Try again.
              </Alert>
            </Box>
          )}

          {!isLoading && !isError && results && results.length === 0 && (
            <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
              <Typography color="text.secondary">No results found in this area.</Typography>
            </Box>
          )}

          {!isLoading && results && results.length > 0 && (
            <>
              <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
                <Typography variant="body2" color="text.secondary">
                  {results.length} result{results.length !== 1 ? "s" : ""}
                </Typography>
              </Box>
              {results.map((place, i) => (
                <Box key={place.id}>
                  {i > 0 && <Divider sx={{ mx: 2 }} />}
                  <CategoryPlaceCard
                    place={place}
                    isHovered={hoveredCategoryPlaceId === place.id}
                    onSelect={handleSelectPlace}
                    onHover={setHoveredCategoryPlaceId}
                    onHoverEnd={() => setHoveredCategoryPlaceId(null)}
                  />
                </Box>
              ))}
            </>
          )}
        </Box>

        {isLoading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 3, flexShrink: 0 }}>
            <CircularProgress size={24} />
          </Box>
        )}
      </Paper>

      {/* Desktop collapse toggle */}
      <Tooltip title={collapsed ? "Show sidebar" : "Hide sidebar"} placement="right">
        <IconButton
          onClick={() => setCollapsed((c) => !c)}
          size="small"
          sx={{
            display: { xs: "none", sm: "flex" },
            alignItems: "center",
            justifyContent: "center",
            position: "absolute",
            top: "50%",
            left: collapsed ? 0 : PANEL_WIDTH,
            transform: "translateY(-50%)",
            transition: "left 0.25s ease",
            zIndex: 9,
            bgcolor: "background.paper",
            borderRadius: "0 6px 6px 0",
            boxShadow: "2px 2px 8px rgba(0,0,0,0.15)",
            width: 20,
            height: 48,
            padding: 0,
            "&:hover": { bgcolor: "grey.50" },
          }}
          aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {collapsed ? (
            <ChevronRightIcon sx={{ fontSize: 16 }} />
          ) : (
            <ChevronLeftIcon sx={{ fontSize: 16 }} />
          )}
        </IconButton>
      </Tooltip>
    </>
  );
}
