import type {
  LngLat,
  StreetLevelCapabilities,
  StreetLevelImage,
  StreetLevelLink,
} from "@openmapx/core";

export type {
  StreetLevelCapabilities,
  StreetLevelCoverage,
  StreetLevelImage,
  StreetLevelLink,
} from "@openmapx/core";

/**
 * A pluggable source of street-level imagery.
 *
 * `getLinks` returns raw neighbours only. Direction bucketing and arrow
 * selection are shared client-side concerns (`selectArrowLinks` in
 * @openmapx/core) so that every provider navigates identically.
 */
export interface StreetLevelProvider {
  readonly id: string;
  readonly name: string;
  capabilities(): StreetLevelCapabilities;
  /** Nearest image to a point, or null when the provider has no coverage there. */
  findNearest(lngLat: LngLat, radiusM?: number): Promise<StreetLevelImage | null>;
  getImage(id: string): Promise<StreetLevelImage | null>;
  getLinks(id: string): Promise<StreetLevelLink[]>;
}
