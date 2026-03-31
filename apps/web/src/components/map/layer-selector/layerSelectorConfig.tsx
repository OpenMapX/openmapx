"use client";

import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import PedalBikeIcon from "@mui/icons-material/PedalBike";
import SatelliteAltIcon from "@mui/icons-material/SatelliteAlt";
import TerrainIcon from "@mui/icons-material/Terrain";
import type { MapLayer } from "@openmapx/core";
import type { ReactNode } from "react";
import {
  cyclingMapPreview,
  defaultMapPreview,
  satellitePreview,
  standardMapPreview,
  terrainPreview,
} from "./layerPreviewSvgs";

export interface BaseLayerOption {
  id: MapLayer;
  labelKey: string;
  icon: ReactNode;
  preview: ReactNode;
}

export interface DesktopMoreOption {
  id: string;
  labelKey: string;
  preview: ReactNode;
  selected?: boolean;
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
