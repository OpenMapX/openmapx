"use client";

import type { MapLayer } from "@openmapx/core";
import type { ReactNode } from "react";
import {
  cyclingMapPreview,
  defaultMapPreview,
  satellitePreview,
  terrainPreview,
} from "./layerPreviewSvgs";

export interface BaseLayerOption {
  id: MapLayer;
  labelKey: string;
  preview: ReactNode;
}

export const BASE_LAYER_OPTIONS: [BaseLayerOption, ...BaseLayerOption[]] = [
  {
    id: "default",
    labelKey: "default",
    preview: defaultMapPreview,
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
