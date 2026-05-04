"use client";

import BookmarkIcon from "@mui/icons-material/Bookmark";
import Box from "@mui/material/Box";
import { usePlaceDetails } from "@openmapx/core";
import { useState } from "react";

interface Props {
  lat: number;
  lng: number;
  name: string;
  placeId?: string | null;
  size?: number;
}

export function PlaceThumbnail({ lat, lng, name, placeId, size = 64 }: Props) {
  const { data: place } = usePlaceDetails(placeId ?? null, [lng, lat], name);
  const [failed, setFailed] = useState(false);

  const photo = place?.photos?.[0];
  const url = photo?.thumbnailUrl ?? photo?.url;
  const showImage = url && !failed;

  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: 2,
        // Theme-aware placeholder surface — `grey.200` is a fixed-light
        // shade and would stay near-white in dark mode.
        bgcolor: "action.hover",
        flexShrink: 0,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {showImage ? (
        <Box
          component="img"
          src={url}
          alt={name}
          onError={() => setFailed(true)}
          sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <BookmarkIcon sx={{ fontSize: 28, color: "grey.400" }} />
      )}
    </Box>
  );
}
