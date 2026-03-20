"use client";

import DirectionsTransitFilledIcon from "@mui/icons-material/DirectionsTransitFilled";
import HikingIcon from "@mui/icons-material/Hiking";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import PedalBikeIcon from "@mui/icons-material/PedalBike";
import SatelliteAltIcon from "@mui/icons-material/SatelliteAlt";
import TerrainIcon from "@mui/icons-material/Terrain";
import TrafficIcon from "@mui/icons-material/Traffic";
import type { MapLayer, OverlayId } from "@openmapx/core";
import type { ReactNode } from "react";
import {
  airQualityPreview,
  cyclingMapPreview,
  defaultMapPreview,
  earthquakesPreview,
  hikingPreview,
  measurePreview,
  satellitePreview,
  standardMapPreview,
  streetViewPreview,
  terrainPreview,
  trafficPreview,
  transitPreview,
  travelTimePreview,
  wildfirePreview,
  winterSportsPreview,
} from "./layerPreviewSvgs";

export interface BaseLayerOption {
  id: MapLayer;
  labelKey: string;
  icon: ReactNode;
  preview: ReactNode;
}

export interface DetailOption {
  key: "traffic" | "transit" | "hiking";
  labelKey: string;
  icon: ReactNode;
  preview: ReactNode;
  overlayId?: OverlayId;
}

export interface DesktopMoreOption {
  id: string;
  labelKey: string;
  preview: ReactNode;
  selected?: boolean;
  overlayId?: OverlayId;
}

export const BASE_LAYER_OPTIONS: BaseLayerOption[] = [
  {
    id: "default",
    labelKey: "default",
    icon: <MapOutlinedIcon sx={{ fontSize: 16 }} />,
    preview: defaultMapPreview,
  },
  {
    id: "satellite",
    labelKey: "satellite",
    icon: <SatelliteAltIcon sx={{ fontSize: 16 }} />,
    preview: satellitePreview,
  },
  {
    id: "terrain",
    labelKey: "terrain",
    icon: <TerrainIcon sx={{ fontSize: 16 }} />,
    preview: terrainPreview,
  },
  {
    id: "cycling",
    labelKey: "cyclingMap",
    icon: <PedalBikeIcon sx={{ fontSize: 16 }} />,
    preview: cyclingMapPreview,
  },
];

export const DETAIL_OPTIONS: DetailOption[] = [
  {
    key: "traffic",
    labelKey: "traffic",
    icon: <TrafficIcon sx={{ fontSize: 14 }} />,
    preview: trafficPreview,
  },
  {
    key: "transit",
    labelKey: "transit",
    icon: <DirectionsTransitFilledIcon sx={{ fontSize: 14 }} />,
    preview: transitPreview,
  },
  {
    key: "hiking",
    labelKey: "hiking",
    icon: <HikingIcon sx={{ fontSize: 14 }} />,
    preview: hikingPreview,
    overlayId: "hiking",
  },
];

export const DESKTOP_MORE_MAP_DETAILS: readonly DesktopMoreOption[] = [
  {
    id: "public-transport",
    labelKey: "publicTransport",
    preview: transitPreview,
  },
  {
    id: "traffic",
    labelKey: "traffic",
    preview: trafficPreview,
  },
  {
    id: "cycling",
    labelKey: "cycling",
    overlayId: "cycling",
    preview: cyclingMapPreview,
  },
  {
    id: "terrain",
    labelKey: "terrain",
    preview: terrainPreview,
  },
  {
    id: "street-view",
    labelKey: "streetLevelImagery",
    overlayId: "street-view",
    preview: streetViewPreview,
  },
  {
    id: "wildfire",
    labelKey: "wildfires",
    preview: wildfirePreview,
  },
  {
    id: "air-quality",
    labelKey: "airQuality",
    overlayId: "air-quality",
    preview: airQualityPreview,
  },
  {
    id: "hiking",
    labelKey: "hiking",
    overlayId: "hiking",
    preview: hikingPreview,
  },
  {
    id: "winter-sports",
    labelKey: "winterSports",
    overlayId: "winter-sports",
    preview: winterSportsPreview,
  },
  {
    id: "earthquakes",
    labelKey: "earthquakes",
    overlayId: "earthquakes",
    preview: earthquakesPreview,
  },
];

export const DESKTOP_MORE_MAP_TOOLS: readonly DesktopMoreOption[] = [
  {
    id: "travel-time",
    labelKey: "travelTime",
    preview: travelTimePreview,
  },
  {
    id: "measure",
    labelKey: "measure",
    preview: measurePreview,
  },
];

export const DESKTOP_MORE_MAP_TYPES: readonly DesktopMoreOption[] = [
  {
    id: "standard",
    labelKey: "standard",
    preview: standardMapPreview,
  },
  {
    id: "satellite",
    labelKey: "satellite",
    preview: satellitePreview,
  },
];
