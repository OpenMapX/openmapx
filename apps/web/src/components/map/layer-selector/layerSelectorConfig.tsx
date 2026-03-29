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
  buildingsPreview,
  cyclingMapPreview,
  defaultMapPreview,
  earthquakesPreview,
  hikingPreview,
  liveTrainsPreview,
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
  serviceId?: string;
}

export interface DesktopMoreOption {
  id: string;
  labelKey: string;
  preview: ReactNode;
  selected?: boolean;
  overlayId?: OverlayId;
  serviceId?: string;
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
    overlayId: "traffic",
    serviceId: "tomtom-traffic",
  },
  {
    key: "transit",
    labelKey: "transit",
    icon: <DirectionsTransitFilledIcon sx={{ fontSize: 14 }} />,
    preview: transitPreview,
    overlayId: "transit",
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
  // Transport & Mobilität
  {
    id: "traffic",
    labelKey: "traffic",
    preview: trafficPreview,
    overlayId: "traffic",
    serviceId: "tomtom-traffic",
  },
  {
    id: "public-transport",
    labelKey: "publicTransport",
    preview: transitPreview,
    overlayId: "transit",
  },
  {
    id: "live-trains",
    labelKey: "liveTrains",
    overlayId: "live-trains",
    preview: liveTrainsPreview,
  },
  {
    id: "cycling",
    labelKey: "cycling",
    overlayId: "cycling",
    preview: cyclingMapPreview,
  },
  // Kartenansichten
  {
    id: "street-view",
    labelKey: "streetLevelImagery",
    overlayId: "street-view",
    serviceId: "mapillary",
    preview: streetViewPreview,
  },
  {
    id: "3d-buildings",
    labelKey: "3dBuildings",
    overlayId: "3d-buildings",
    preview: buildingsPreview,
  },
  // Outdoor & Freizeit
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
  // Umwelt & Gefahren
  {
    id: "air-quality",
    labelKey: "airQuality",
    overlayId: "air-quality",
    serviceId: "openaq",
    preview: airQualityPreview,
  },
  {
    id: "wildfire",
    labelKey: "wildfires",
    overlayId: "wildfires",
    serviceId: "firms-wildfires",
    preview: wildfirePreview,
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
    id: "default",
    labelKey: "standard",
    preview: standardMapPreview,
  },
  {
    id: "satellite",
    labelKey: "satellite",
    preview: satellitePreview,
  },
  {
    id: "terrain",
    labelKey: "terrain",
    preview: terrainPreview,
  },
  {
    id: "cycling",
    labelKey: "cyclingMap",
    preview: cyclingMapPreview,
  },
];
