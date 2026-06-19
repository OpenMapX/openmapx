"use client";

import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Skeleton from "@mui/material/Skeleton";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import type { CategoryPlace } from "@openmapx/core";
import {
  AD_HOC_CATEGORY_ID,
  categoryPlaceToPlace,
  isAreaTooLarge,
  PANEL,
  resolveStopAsPlace,
  useCategorySearchStore,
  usePlaceStore,
  useSidebarStore,
  useTransitStops,
} from "@openmapx/core";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import type maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { ResultItemName, ResultList, ResultListItem } from "@/components/ui/ResultListItem";
import { useMap } from "@/lib/MapContext";
import { useAttributionFromHooks } from "@/lib/useAttributionFromHooks";
import { useExploreReachResults } from "@/lib/useExploreReachResults";
import { ExploreTravelTimeControl } from "./ExploreTravelTimeControl";

const TRANSIT_MODE_ICONS: Partial<Record<TransportMode, typeof TrainIcon>> = {
  rail: TrainIcon,
  tram: TramIcon,
  bus: DirectionsBusIcon,
};

function TransitStopCard({
  stop,
  onSelect,
}: {
  stop: TransitStop;
  onSelect: (stop: TransitStop) => void;
}) {
  return (
    <ResultListItem onClick={() => onSelect(stop)} hoverBg="rgba(0,0,0,0.06)">
      <ResultItemName>{stop.name}</ResultItemName>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        {Array.from(new Set(stop.modes)).map((m) => {
          const Icon = TRANSIT_MODE_ICONS[m] ?? DirectionsBusIcon;
          return <Icon key={m} sx={{ fontSize: 16, color: "text.secondary" }} />;
        })}
      </Box>
    </ResultListItem>
  );
}

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
  const tp = useTranslations("place");
  const tc = useTranslations("common");
  const tagLabel = place.category
    ? place.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;

  return (
    <ResultListItem
      onClick={() => onSelect(place)}
      onMouseEnter={() => onHover(place.id)}
      onMouseLeave={onHoverEnd}
      selected={isHovered}
      hoverBg="rgba(0,0,0,0.06)"
    >
      <ResultItemName>{place.name}</ResultItemName>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center", mb: 0.25 }}>
        {tagLabel && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {tagLabel}
          </Typography>
        )}
        {tagLabel && place.address && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            ·
          </Typography>
        )}
        {place.address && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {place.address}
          </Typography>
        )}
      </Box>
      {(() => {
        const hours = place.openingHoursInfo?.status ?? null;
        if (hours) {
          if (hours.isUnknown) {
            return (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {hours.detail}
              </Typography>
            );
          }
          return (
            <Typography variant="caption" color={hours.isOpen ? "success.main" : "error.main"}>
              {hours.isOpen
                ? tp("openDetail", { detail: hours.detail })
                : tp("closedDetail", { detail: hours.detail })}
            </Typography>
          );
        }
        if (place.isOpen !== undefined) {
          return (
            <Typography variant="caption" color={place.isOpen ? "success.main" : "error.main"}>
              {place.isOpen ? tc("open") : tc("closed")}
            </Typography>
          );
        }
        return null;
      })()}
    </ResultListItem>
  );
}

export function CategoryResultsContent() {
  const ts = useTranslations("search");
  const tc = useTranslations("common");
  const {
    activeCategory,
    searchBbox,
    setSearchBbox,
    setMapMoved,
    hoveredCategoryPlaceId,
    setHoveredCategoryPlaceId,
  } = useCategorySearchStore();
  const anchor = useCategorySearchStore((s) => s.anchor);
  const adHocLabel = useCategorySearchStore((s) => s.adHocLabel);
  const mode = useCategorySearchStore((s) => s.mode);
  const autoRefresh = useCategorySearchStore((s) => s.autoRefresh);
  const setAutoRefresh = useCategorySearchStore((s) => s.setAutoRefresh);
  // Viewport text search (top search bar, no anchor) behaves like a category:
  // panning offers "search this area" + the auto-refresh toggle.
  const isViewportText = mode === "text" && anchor === null;
  const { setSelectedPlace } = usePlaceStore();
  const { flyTo, mapRef, mapReady } = useMap();

  const { filtered, isLoading, isError, error, partial, isTransitCategory } =
    useExploreReachResults();
  const transitStopsQuery = useTransitStops(isTransitCategory ? searchBbox : null);
  const { data: transitStops, isPending: transitPending } = transitStopsQuery;
  const transitAttributions = useAttributionFromHooks(transitStopsQuery);
  const transitLoading = isTransitCategory && transitPending;

  const prevCategoryRef = useRef<string | null>(null);

  const results = filtered;

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
    setMapMoved(false);
  }, [activeCategory, mapReady]);

  // Clear prev category ref when category is cleared
  useEffect(() => {
    if (!activeCategory) {
      prevCategoryRef.current = null;
      setMapMoved(false);
    }
  }, [activeCategory, setMapMoved]);

  // Map movement: auto-refresh the search when enabled, otherwise show the
  // manual "Search this area" chip.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || (!activeCategory && !isViewportText)) return;

    const onMoveEnd = (e: maplibregl.MapLibreEvent) => {
      // Ignore app-driven camera moves (flyTo on result select, fitBounds on
      // launch — tagged with `programmatic`). Only react to real user pan/zoom.
      if ((e as { programmatic?: boolean }).programmatic) return;
      if (autoRefresh) {
        const b = map.getBounds();
        setSearchBbox({
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
        });
        setMapMoved(false);
      } else {
        setMapMoved(true);
      }
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [mapRef, mapReady, activeCategory, isViewportText, autoRefresh, setSearchBbox, setMapMoved]);

  const handleSelectPlace = (place: CategoryPlace) => {
    flyTo(place.coordinates, 17);
    setSelectedPlace(categoryPlaceToPlace(place, activeCategory ?? undefined));
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  };

  const handleSelectStop = (s: TransitStop) => {
    flyTo([s.lng, s.lat], 16);
    void resolveStopAsPlace(s).then((place) => {
      setSelectedPlace(place);
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    });
  };

  return (
    <Box sx={{ flex: 1, overflowY: "auto", pt: { xs: 2, sm: "72px" } }}>
      {(anchor || activeCategory || isViewportText) && (
        <Box
          sx={{
            px: 2,
            py: 1,
            borderBottom: "1px solid var(--omx-border)",
            display: "flex",
            flexDirection: "column",
            gap: 0.75,
          }}
        >
          {anchor && <ExploreTravelTimeControl />}
          {(activeCategory || isViewportText) && (
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
              }
              label={<Typography variant="body2">{ts("updateOnMapMove")}</Typography>}
            />
          )}
        </Box>
      )}
      {(isTransitCategory ? transitLoading : isLoading) && (
        <Box sx={{ px: 2, py: 2 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Box key={i} sx={{ mb: 2 }}>
              <Skeleton variant="text" width="60%" height={20} />
              <Skeleton variant="text" width="80%" height={16} />
            </Box>
          ))}
        </Box>
      )}
      {!isTransitCategory && isError && (
        <Box sx={{ px: 2, py: 2 }}>
          <Alert severity={isAreaTooLarge(error) ? "info" : "error"} variant="outlined">
            {isAreaTooLarge(error) ? ts("zoomInToSearch") : ts("failedToLoad")}
          </Alert>
        </Box>
      )}
      {!isTransitCategory && !isError && partial && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <Alert severity="info" variant="outlined">
            {ts("partialResults")}
          </Alert>
        </Box>
      )}
      {/* Transit: empty state */}
      {isTransitCategory && !transitLoading && transitStops && transitStops.length === 0 && (
        <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
          <Typography
            sx={{
              color: "text.secondary",
            }}
          >
            {ts("noStopsFound")}
          </Typography>
        </Box>
      )}
      {/* Transit: results list */}
      {isTransitCategory && !transitLoading && transitStops && transitStops.length > 0 && (
        <>
          <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {tc("stopsCount", { count: transitStops.length })}
            </Typography>
          </Box>
          <AttributionStrip
            attributions={transitAttributions}
            variant="inline"
            label={tc("dataSources")}
          />
          <ResultList
            items={transitStops}
            getKey={(stop) => stop.id}
            renderItem={(stop) => <TransitStopCard stop={stop} onSelect={handleSelectStop} />}
          />
        </>
      )}
      {/* Non-transit: empty state */}
      {!isTransitCategory && !isLoading && !isError && results && results.length === 0 && (
        <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
          <Typography
            sx={{
              color: "text.secondary",
            }}
          >
            {ts("noResultsFound")}
          </Typography>
        </Box>
      )}
      {/* Non-transit: results list */}
      {!isTransitCategory && !isLoading && results && results.length > 0 && (
        <>
          {activeCategory === AD_HOC_CATEGORY_ID && (adHocLabel ?? null) !== null && (
            <Box sx={{ px: 2, pt: 1.5, pb: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {adHocLabel}
              </Typography>
            </Box>
          )}
          <Box sx={{ px: 2, pt: 1.5, pb: 0.5, display: "flex", alignItems: "center", gap: 1 }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                flex: 1,
              }}
            >
              {tc("resultsCount", { count: results.length })}
            </Typography>
          </Box>
          <ResultList
            items={results}
            getKey={(place) => place.id}
            renderItem={(place) => (
              <CategoryPlaceCard
                place={place}
                isHovered={hoveredCategoryPlaceId === place.id}
                onSelect={handleSelectPlace}
                onHover={setHoveredCategoryPlaceId}
                onHoverEnd={() => setHoveredCategoryPlaceId(null)}
              />
            )}
          />
        </>
      )}
    </Box>
  );
}
