import type { OccupancyLevel } from "@openmapx/core";

export const OCCUPANCY_COLOR: Record<OccupancyLevel, string> = {
  low: "#2e7d32",
  medium: "#e65100",
  high: "#b71c1c",
  overcrowded: "#6a1b1b",
};

export const OCCUPANCY_KEY: Record<OccupancyLevel, string> = {
  low: "lowOccupancy",
  medium: "mediumOccupancy",
  high: "highOccupancy",
  overcrowded: "overcrowdedOccupancy",
};
