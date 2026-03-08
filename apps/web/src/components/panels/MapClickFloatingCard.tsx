"use client";

import CloseIcon from "@mui/icons-material/Close";
import DirectionsIcon from "@mui/icons-material/Directions";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import {
  useDirectionsStore,
  useMapClickStore,
  usePlaceStore,
  useReverseGeocoding,
  useSearchStore,
} from "@openmapx/core";
import { useMap } from "@/lib/MapContext";

export function MapClickFloatingCard() {
  const { clickedLngLat, setClickedLngLat } = useMapClickStore();
  const { setSelectedPlace } = usePlaceStore();
  const { setQuery, setIsFocused } = useSearchStore();
  const { setDestination, open: openDirections } = useDirectionsStore();
  const { flyTo } = useMap();

  const { data: reverseGeo, isLoading } = useReverseGeocoding(clickedLngLat);

  if (!clickedLngLat) return null;

  const [lng, lat] = clickedLngLat;
  const coordLabel = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const placeName = reverseGeo?.city || reverseGeo?.address || coordLabel;

  const handleCoordClick = () => {
    flyTo(clickedLngLat, 15);
    setQuery(coordLabel);
    setIsFocused(false);
    setSelectedPlace({
      id: `coordinate-${lat.toFixed(6)}-${lng.toFixed(6)}`,
      name: placeName,
      address: reverseGeo?.address ?? coordLabel,
      coordinates: clickedLngLat,
    });
    setClickedLngLat(null);
  };

  const handleDirections = () => {
    setDestination(clickedLngLat, reverseGeo?.address ?? coordLabel);
    openDirections();
    setClickedLngLat(null);
  };

  return (
    <Paper
      elevation={3}
      sx={{
        position: "absolute",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
        width: { xs: "calc(100% - 32px)", sm: 320 },
        maxWidth: 320,
        borderRadius: 2,
        overflow: "visible",
      }}
    >
      <Box sx={{ px: 1.5, pt: 1.25, pb: 1.25 }}>
        {/* Header row: icon + name + close */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <LocationOnIcon sx={{ color: "text.secondary", fontSize: 18, flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {isLoading ? (
              <Skeleton variant="text" width="55%" height={18} />
            ) : (
              <Typography
                variant="body2"
                fontWeight={600}
                sx={{ lineHeight: 1.3, wordBreak: "break-word" }}
              >
                {placeName}
              </Typography>
            )}
          </Box>
          <IconButton
            size="small"
            onClick={() => setClickedLngLat(null)}
            aria-label="Close"
            sx={{ mr: -0.5 }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>

        {/* Divider */}
        <Box sx={{ borderTop: 1, borderColor: "divider", mt: 1, mb: 1 }} />

        {/* Coordinate + action buttons */}
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Box
            component="button"
            onClick={handleCoordClick}
            sx={{
              color: "teal",
              fontWeight: 500,
              fontSize: 12,
              cursor: "pointer",
              border: "none",
              background: "none",
              p: 0,
              fontFamily: "inherit",
              "&:hover": { textDecoration: "underline" },
            }}
          >
            {coordLabel}
          </Box>
          <IconButton
            size="small"
            onClick={handleDirections}
            aria-label="Directions"
            sx={{
              bgcolor: "teal",
              color: "white",
              width: 32,
              height: 32,
              borderRadius: "50%",
              "&:hover": { bgcolor: "#00695c" },
            }}
          >
            <DirectionsIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
      </Box>
    </Paper>
  );
}
