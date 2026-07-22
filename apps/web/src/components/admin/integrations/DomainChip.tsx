"use client";

import type { ChipProps } from "@mui/material/Chip";
import Chip from "@mui/material/Chip";

type ChipColor = ChipProps["color"];

const DOMAIN_COLOR: Record<string, ChipColor> = {
  geocoding: "primary",
  routing: "secondary",
  transit: "success",
  "street-level-imagery": "info",
  "map-overlay": "warning",
  "poi-search": "error",
  photos: "primary",
  knowledge: "secondary",
  "data-source": "info",
};

const DOMAIN_LABEL: Record<string, string> = {
  geocoding: "Geocoding",
  routing: "Routing",
  transit: "Transit",
  "street-level-imagery": "Street-level imagery",
  "map-overlay": "Map Overlay",
  "poi-search": "POI Search",
  photos: "Photos",
  knowledge: "Knowledge",
  "data-source": "Data Source",
};

interface DomainChipProps {
  domain: string;
  size?: "small" | "medium";
}

export function DomainChip({ domain, size = "small" }: DomainChipProps) {
  const color = DOMAIN_COLOR[domain] ?? "default";
  const label = DOMAIN_LABEL[domain] ?? domain;

  return (
    <Chip
      label={label}
      color={color}
      size={size}
      variant="outlined"
      sx={{ fontWeight: 500, fontSize: "0.7rem" }}
    />
  );
}
