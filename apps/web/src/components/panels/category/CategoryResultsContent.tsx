"use client";

import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { CategoryPlace, TransitStop, TransportMode } from "@openmapx/core";
import {
  categoryPlaceToPlace,
  isAreaTooLarge,
  PANEL,
  parseOpeningHours,
  resolveProvider,
  resolveStopAsPlace,
  useCategorySearchStore,
  useFilteredCategoryResults,
  usePlaceStore,
  useProviders,
  useSidebarStore,
  useTransitStops,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";

const TRANSIT_MODE_ICONS: Partial<Record<TransportMode, typeof TrainIcon>> = {
  rail: TrainIcon,
  tram: TramIcon,
  bus: DirectionsBusIcon,
};

function TransitStopCard({
  stop,
  onSelect,
  providers,
}: {
  stop: TransitStop;
  onSelect: (stop: TransitStop) => void;
  providers: Record<string, { label: string; url: string }> | undefined;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onSelect(stop)}
      sx={{
        width: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        cursor: "pointer",
        px: 2,
        py: 1.5,
        "&:hover": { bgcolor: "rgba(0,0,0,0.06)" },
      }}
    >
      <Typography variant="body1" fontWeight={600} sx={{ mb: 0.25 }}>
        {stop.name}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        {Array.from(new Set(stop.modes)).map((m) => {
          const Icon = TRANSIT_MODE_ICONS[m] ?? DirectionsBusIcon;
          return <Icon key={m} sx={{ fontSize: 16, color: "text.secondary" }} />;
        })}
        {(() => {
          const attr = resolveProvider(providers ?? {}, stop.provider);
          return (
            <Typography variant="caption" color="text.secondary">
              {attr.url ? (
                <Link
                  href={attr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  color="inherit"
                  underline="hover"
                  onClick={(e) => e.stopPropagation()}
                >
                  {attr.label}
                </Link>
              ) : (
                attr.label
              )}
              {attr.license &&
                (attr.licenseUrl ? (
                  <>
                    {" ("}
                    <Link
                      href={attr.licenseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      color="inherit"
                      underline="hover"
                    >
                      {attr.license}
                    </Link>
                    {")"}
                  </>
                ) : (
                  ` (${attr.license})`
                ))}
            </Typography>
          );
        })()}
      </Box>
    </Box>
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
        const hours = parseOpeningHours(place.openingHours, {
          lat: place.coordinates[1],
          lon: place.coordinates[0],
        });
        if (hours) {
          if (hours.isUnknown) {
            return (
              <Typography variant="caption" color="text.secondary">
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
    </Box>
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
  const { setSelectedPlace } = usePlaceStore();
  const { flyTo, mapRef, mapReady } = useMap();

  const { filtered, isLoading, isError, error, partial, isTransitCategory } =
    useFilteredCategoryResults();
  const { data: transitStops, isPending: transitPending } = useTransitStops(
    isTransitCategory ? searchBbox : null,
  );
  const { data: providers } = useProviders();
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
          <Typography color="text.secondary">{ts("noStopsFound")}</Typography>
        </Box>
      )}

      {/* Transit: results list */}
      {isTransitCategory && !transitLoading && transitStops && transitStops.length > 0 && (
        <>
          <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {tc("stopsCount", { count: transitStops.length })}
            </Typography>
          </Box>
          {transitStops.map((stop, i) => (
            <Box key={stop.id}>
              {i > 0 && <Divider sx={{ mx: 2 }} />}
              <TransitStopCard stop={stop} onSelect={handleSelectStop} providers={providers} />
            </Box>
          ))}
        </>
      )}

      {/* Non-transit: empty state */}
      {!isTransitCategory && !isLoading && !isError && results && results.length === 0 && (
        <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
          <Typography color="text.secondary">{ts("noResultsFound")}</Typography>
        </Box>
      )}

      {/* Non-transit: results list */}
      {!isTransitCategory && !isLoading && results && results.length > 0 && (
        <>
          <Box sx={{ px: 2, pt: 1.5, pb: 0.5, display: "flex", alignItems: "center", gap: 1 }}>
            <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
              {tc("resultsCount", { count: results.length })}
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
  );
}
