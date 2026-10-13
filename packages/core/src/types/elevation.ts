import type { ContributingRecord, FieldContributors } from "@openmapx/mobility-core/contributors";
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

export interface ElevationProfile extends ContributingRecord {
  /** The acquisition provider is known but exact DEM lineage is not supplied. */
  contributorCoverage?: "partial";
  points: ElevationPoint[];
  stats: ElevationStats;
}

export interface ElevationApiResponse extends ContributingRecord {
  fieldContributors?: FieldContributors;
  contributorCoverage?: "partial";
  points: Array<{ distance: number; elevation: number }>;
  interval: number;
}
