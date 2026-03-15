"use client";

import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import DirectionsIcon from "@mui/icons-material/Directions";
import SearchIcon from "@mui/icons-material/Search";
import ShareIcon from "@mui/icons-material/Share";
import Box from "@mui/material/Box";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import { useDirectionsStore, usePlaceStore } from "@openmapx/core";
import type { ReactNode } from "react";
import { useState } from "react";
import { TEAL, TEAL_LIGHT } from "@/lib/theme";

interface ActionButtonProps {
  icon: ReactNode;
  label: string;
  filled?: boolean;
  onClick?: () => void;
}

function ActionButton({ icon, label, filled = false, onClick }: ActionButtonProps) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.75,
        cursor: "pointer",
        minWidth: 40,
      }}
      onClick={onClick}
    >
      <Box
        sx={{
          width: 40,
          height: 40,
          borderRadius: "50%",
          bgcolor: filled ? TEAL : TEAL_LIGHT,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "filter 0.15s",
          "&:hover": { filter: "brightness(0.93)" },
          "& svg": { fontSize: 20, color: filled ? "#fff" : TEAL },
        }}
      >
        {icon}
      </Box>
      <Typography
        variant="caption"
        fontWeight={500}
        align="center"
        sx={{ color: TEAL, lineHeight: 1.3 }}
      >
        {label}
      </Typography>
    </Box>
  );
}

interface Props {
  place: Place;
}

export function PlaceActionButtons({ place }: Props) {
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const { setDestination, open: openDirections } = useDirectionsStore();
  const { setSelectedPlace } = usePlaceStore();

  const handleDirections = () => {
    setDestination(place.coordinates, place.name);
    openDirections();
    setSelectedPlace(null);
  };

  const handleShare = async () => {
    const [lng, lat] = place.coordinates;
    const params = new URLSearchParams({
      place: place.id,
      lat: lat.toFixed(6),
      lng: lng.toFixed(6),
      name: place.name,
    });
    if (place.category) params.set("category", place.category);
    if (place.rawCategory) params.set("rawCategory", place.rawCategory);
    const url = `${window.location.origin}/?${params.toString()}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: place.name, url });
      } else {
        await navigator.clipboard.writeText(url);
        setSnackbar("Link copied to clipboard");
      }
    } catch {
      // User cancelled share dialog — ignore
    }
  };

  return (
    <>
      <Box sx={{ display: "flex", justifyContent: "space-around", py: 1 }}>
        <ActionButton
          icon={<DirectionsIcon />}
          label="Directions"
          filled
          onClick={handleDirections}
        />
        <ActionButton icon={<BookmarkBorderIcon />} label="Save" />
        <ActionButton icon={<SearchIcon />} label="Nearby" />
        <ActionButton icon={<ShareIcon />} label="Share" onClick={handleShare} />
      </Box>

      <Snackbar
        open={snackbar !== null}
        autoHideDuration={2500}
        onClose={() => setSnackbar(null)}
        message={snackbar}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </>
  );
}
