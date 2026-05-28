"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  formatDistance,
  haversineDistance,
  PANEL,
  useNearbyPlaces,
  useNearbyPlacesStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useMap } from "@/lib/MapContext";

function categoryLabel(place: Place): string | undefined {
  return place.category?.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function NearbyPlaceCard({
  place,
  sourcePlace,
  isHovered,
  onSelect,
  onHover,
  onHoverEnd,
}: {
  place: Place;
  sourcePlace: Place;
  isHovered: boolean;
  onSelect: (place: Place) => void;
  onHover: (id: string) => void;
  onHoverEnd: () => void;
}) {
  const tp = useTranslations("place");
  const tn = useTranslations("nearby");
  const tc = useTranslations("common");
  const label = categoryLabel(place);
  const distance = haversineDistance(sourcePlace.coordinates, place.coordinates);

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
      <Typography
        variant="body1"
        sx={{
          fontWeight: 600,
          mb: 0.25,
        }}
      >
        {place.name}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center", mb: 0.25 }}>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {tn("distanceAway", { distance: formatDistance(distance) })}
        </Typography>
        {label && (
          <>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              ·
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {label}
            </Typography>
          </>
        )}
        {place.address && place.address !== place.name && (
          <>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              ·
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {place.address}
            </Typography>
          </>
        )}
      </Box>
      {(() => {
        const hours = place.openingHoursInfo?.status ?? null;
        if (hours) {
          let color = "text.secondary";
          let content = hours.detail;
          if (!hours.isUnknown) {
            color = hours.isOpen ? "success.main" : "error.main";
            if (hours.isOpen) {
              content = tp("openDetail", { detail: hours.detail });
            } else {
              content = tp("closedDetail", { detail: hours.detail });
            }
          }
          return (
            <Typography variant="caption" color={color}>
              {content}
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

export function NearbyPlacesContent() {
  const tn = useTranslations("nearby");
  const ts = useTranslations("search");
  const tc = useTranslations("common");
  const { sourcePlace, radiusMetres, hoveredNearbyPlaceId, setHoveredNearbyPlaceId } =
    useNearbyPlacesStore();
  const { setSelectedPlace } = usePlaceStore();
  const { flyTo } = useMap();

  const { data, isLoading, isError } = useNearbyPlaces(
    sourcePlace?.coordinates ?? null,
    radiusMetres,
    {
      excludeId: sourcePlace?.id,
    },
  );

  const places = useMemo(() => {
    if (!sourcePlace || !data) return [];
    return data.filter((place) => place.id !== sourcePlace.id);
  }, [data, sourcePlace]);

  const handleSelectPlace = (place: Place) => {
    flyTo(place.coordinates, 17);
    setSelectedPlace(place);
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  };

  if (!sourcePlace) {
    return (
      <Box sx={{ flex: 1, overflowY: "auto", pt: { xs: 2, sm: "72px" }, px: 2 }}>
        <Typography
          variant="h6"
          sx={{
            fontWeight: 700,
            mb: 1,
          }}
        >
          {tn("title")}
        </Typography>
        <Typography
          sx={{
            color: "text.secondary",
          }}
        >
          {tn("sourceMissing")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ flex: 1, overflowY: "auto", pt: { xs: 2, sm: "72px" } }}>
      <Box sx={{ px: 2, pb: 1.5 }}>
        <Typography
          variant="h6"
          sx={{
            fontWeight: 700,
          }}
        >
          {tn("title")}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {tn("around", { name: sourcePlace.name })}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {tn("within", { distance: formatDistance(radiusMetres) })}
        </Typography>
      </Box>
      {isLoading && (
        <Box sx={{ px: 2, py: 2 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Box key={i} sx={{ mb: 2 }}>
              <Skeleton variant="text" width="60%" height={20} />
              <Skeleton variant="text" width="85%" height={16} />
            </Box>
          ))}
        </Box>
      )}
      {isError && (
        <Box sx={{ px: 2, py: 2 }}>
          <Alert severity="error" variant="outlined">
            {ts("failedToLoad")}
          </Alert>
        </Box>
      )}
      {!isLoading && !isError && places.length === 0 && (
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
      {!isLoading && !isError && places.length > 0 && (
        <>
          <Box sx={{ px: 2, pt: 0.5, pb: 0.5 }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {tc("resultsCount", { count: places.length })}
            </Typography>
          </Box>
          {places.map((place, i) => (
            <Box key={place.id}>
              {i > 0 && <Divider sx={{ mx: 2 }} />}
              <NearbyPlaceCard
                place={place}
                sourcePlace={sourcePlace}
                isHovered={hoveredNearbyPlaceId === place.id}
                onSelect={handleSelectPlace}
                onHover={setHoveredNearbyPlaceId}
                onHoverEnd={() => setHoveredNearbyPlaceId(null)}
              />
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}
