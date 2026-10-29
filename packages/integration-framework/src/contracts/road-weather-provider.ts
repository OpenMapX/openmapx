import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type { RoadWeatherStation } from "@openmapx/mobility-core/road-weather";

export type {
  PrecipitationType,
  RoadSurfaceSensor,
  RoadSurfaceState,
  RoadWeatherAir,
  RoadWeatherStation,
  RoadWeatherValue,
} from "@openmapx/mobility-core/road-weather";

export interface RoadWeatherQuery {
  /** Source ids the operator's data-use policy disallows. */
  excludedSourceIds?: readonly string[];
}

/**
 * Pluggable "road-weather" capability: the road weather stations beside the
 * roads and what they measure now (the air, and the state and temperature of
 * the road surface). The first-party `road-weather` orchestrator merges every
 * registered provider behind the `road-weather` data source; consumers depend
 * only on this contract.
 *
 * A provider dedups its own stations; the orchestrator does not dedup across
 * providers and re-applies the excluded sources itself.
 */
export interface RoadWeatherProvider {
  /** The OpenMapX integration id. */
  readonly id: string;
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  /**
   * `partial` is set when stations may be missing: `area` when an upstream
   * covered only part of `bbox`, `unavailable` when it did not answer.
   */
  searchStations(
    bbox: BBox,
    q?: RoadWeatherQuery,
  ): Promise<{ stations: RoadWeatherStation[]; partial?: DataSourcePartialReason }>;
  /** The station with this id, or null when this provider does not hold it. */
  getStation(id: string, q?: RoadWeatherQuery): Promise<RoadWeatherStation | null>;
}
