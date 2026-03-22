import type { LngLat } from "./geometry";

export interface ElevationPoint {
  /** Cumulative distance from route start in metres */
  distance: number;
  /** Height above sea level in metres */
  elevation: number;
  /** Coordinate for map hover sync */
  lngLat: LngLat;
}

export interface ElevationStats {
  totalAscent: number;
  totalDescent: number;
  maxElevation: number;
  minElevation: number;
  averageGrade: number;
  maxGrade: number;
}

export interface ElevationProfile {
  points: ElevationPoint[];
  stats: ElevationStats;
}

export interface ElevationApiResponse {
  points: Array<{ distance: number; elevation: number }>;
  interval: number;
}
