"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { type DataSourceBranding, proxyImageUrl } from "@openmapx/core";
import { useState } from "react";

interface Props {
  branding?: DataSourceBranding;
  fallbackName?: string;
  size?: number;
}

function fallbackInitial(branding?: DataSourceBranding, fallbackName?: string): string {
  const value = branding?.name ?? branding?.legalName ?? fallbackName ?? "?";
  return value.trim().charAt(0).toUpperCase() || "?";
}

export function BrandMark({ branding, fallbackName, size = 28 }: Props) {
  const rawImageUrl = branding?.logoUrl ?? branding?.imageUrl;
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageUrl =
    rawImageUrl && failedImageUrl !== rawImageUrl ? proxyImageUrl(rawImageUrl) : null;
  const radius = size <= 24 ? 1.25 : 1.5;

  if (imageUrl && rawImageUrl) {
    return (
      <Box
        component="img"
        src={imageUrl}
        alt={branding?.name ?? fallbackName ?? "Brand"}
        onError={() => setFailedImageUrl(rawImageUrl)}
        sx={{
          width: size,
          height: size,
          display: "block",
          flexShrink: 0,
          objectFit: "contain",
          borderRadius: radius,
          border: "1px solid",
          borderColor: "divider",
          bgcolor: "background.paper",
          p: size <= 24 ? 0.25 : 0.5,
        }}
      />
    );
  }

  return (
    <Box
      sx={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        borderRadius: radius,
        border: "1px solid",
        borderColor: "divider",
        bgcolor: branding?.color ? `${branding.color}22` : "action.hover",
        color: branding?.color ?? "text.primary",
      }}
    >
      <Typography
        component="span"
        sx={{
          fontSize: size <= 24 ? 11 : 13,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {fallbackInitial(branding, fallbackName)}
      </Typography>
    </Box>
  );
}
