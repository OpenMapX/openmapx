import type { CategoryPlace, DataSourceResult } from "@openmapx/core";
import type { I18nToken } from "@openmapx/integration-framework/strings";

/** The data source that knows car parks' access, fees and free spaces. */
export const PARKING_SOURCE_ID = "parking";

/** Who may park, when a site says, that rules it out for a visitor. */
const RESTRICTED_ACCESS = new Set<DataSourceResult["access"]>(["permit", "private", "restricted"]);

/** A parking candidate; `summary` is the parking source's free-space line, when it has one. */
export interface NearbyParkingPlace extends CategoryPlace {
  summary?: I18nToken;
  /** True when the parking source has a current reading of no free space. */
  full?: boolean;
}

/** Whether a visitor can park at a parking-source site: it is not closed and not reserved for others. */
export function isUsableParking(result: DataSourceResult): boolean {
  return result.status !== "non-operational" && !RESTRICTED_ACCESS.has(result.access);
}

/** A parking-source site as a candidate, keeping its credits and saying whether it is free. */
export function toNearbyParking(result: DataSourceResult): NearbyParkingPlace {
  return {
    id: result.id,
    name: result.name,
    coordinates: result.coordinates,
    category: PARKING_SOURCE_ID,
    ...(result.contributors ? { contributors: result.contributors } : {}),
    ...(result.fieldContributors ? { fieldContributors: result.fieldContributors } : {}),
    ...(result.fee ? { osmTags: { fee: result.fee === "free" ? "no" : "yes" } } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    // The parking source marks a site full only from a current reading.
    ...(result.variant === "full" ? { full: true } : {}),
  };
}
