"use client";

import type { ChipProps } from "@mui/material/Chip";
import Chip from "@mui/material/Chip";
import { useTranslations } from "next-intl";

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

const DOMAIN_LABEL_KEY: Record<string, string> = {
  geocoding: "domainGeocoding",
  routing: "domainRouting",
  transit: "domainTransit",
  "street-level-imagery": "domainStreetLevelImagery",
  "map-overlay": "domainMapOverlay",
  "poi-search": "domainPoiSearch",
  photos: "domainPhotos",
  knowledge: "domainKnowledge",
  "data-source": "domainDataSource",
  weather: "domainWeather",
  "road-conditions": "domainRoadConditions",
  "fuel-stations": "domainFuelStations",
  "parking-sites": "domainParkingSites",
  "charging-sites": "domainChargingSites",
  cameras: "domainCameras",
  "message-signs": "domainMessageSigns",
  "road-weather": "domainRoadWeather",
  "service-vehicles": "domainServiceVehicles",
  "border-crossings": "domainBorderCrossings",
  reviews: "domainReviews",
  "live-transit": "domainLiveTransit",
  "search-suggestions": "domainSearchSuggestions",
  "ride-hailing": "domainRideHailing",
  "air-quality": "domainAirQuality",
  "landmark-models": "domainLandmarkModels",
  hazards: "domainHazards",
  "gtfs-catalog": "domainGtfsCatalog",
};

interface DomainChipProps {
  domain: string;
  size?: "small" | "medium";
}

export function DomainChip({ domain, size = "small" }: DomainChipProps) {
  const color = DOMAIN_COLOR[domain] ?? "default";
  const t = useTranslations("adminIntegrations");
  const labelKey = DOMAIN_LABEL_KEY[domain];
  const label = labelKey ? t(labelKey) : domain;

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
