import { type CategoryPlace, type DataSourceResult, presentOpeningHoursInfo } from "@openmapx/core";
import type { I18nToken } from "@openmapx/integration-framework/strings";
import type { Attribution } from "@openmapx/mobility-core/attribution";

/** The data source that knows car parks' access, fees and free spaces. */
export const PARKING_SOURCE_ID = "parking";

/** Who may park at a site, when its source says. */
export type ParkingAccess = NonNullable<DataSourceResult["access"]>;

/** Who may park, when a site says, that rules it out for a visitor. */
const RESTRICTED_ACCESS: ReadonlySet<ParkingAccess> = new Set(["permit", "private", "restricted"]);

/** OSM `access` values as the parking source reads them. */
const OSM_ACCESS: Readonly<Record<string, ParkingAccess>> = {
  yes: "public",
  permissive: "public",
  customers: "customers",
  permit: "permit",
  private: "private",
  no: "private",
  destination: "restricted",
  delivery: "restricted",
};

/** OSM `parking_space` values that keep a mapped space for one group of drivers. */
const RESERVED_SPACES: ReadonlySet<string> = new Set([
  "disabled",
  "charging",
  "parent",
  "women",
  "delivery",
  "taxi",
  "car_sharing",
]);

/** The walk from a car park to the destination along the path network. */
export interface ParkingWalk {
  seconds: number;
  meters: number;
  /** The routing sources the walk was measured with. */
  contributors: readonly Attribution[];
}

/** A parking candidate in the arrival card, from either source, with what is known about it. */
export interface NearbyParkingPlace extends CategoryPlace {
  /** The parking source's free-space line, when it has one. */
  summary?: I18nToken;
  /** True when the parking source has a current reading of no free space. */
  full?: boolean;
  fee?: "free" | "paid";
  access?: ParkingAccess;
  walk?: ParkingWalk;
}

/** Whether a visitor may park at a site its source describes so. */
function openToVisitors(access: ParkingAccess | undefined): boolean {
  return access === undefined || !RESTRICTED_ACCESS.has(access);
}

/**
 * A parking-source site as a candidate, keeping its credits, or null when a
 * visitor cannot park there: it is closed, or kept for others. The search
 * asked only for sites open now, so hours are already judged.
 */
export function fromParkingSourceResult(result: DataSourceResult): NearbyParkingPlace | null {
  if (result.status === "non-operational" || !openToVisitors(result.access)) return null;
  return {
    id: result.id,
    name: result.name,
    coordinates: result.coordinates,
    category: PARKING_SOURCE_ID,
    ...(result.contributors ? { contributors: result.contributors } : {}),
    ...(result.fieldContributors ? { fieldContributors: result.fieldContributors } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    // The parking source marks a site full only from a current reading.
    ...(result.variant === "full" ? { full: true } : {}),
    ...(result.fee ? { fee: result.fee } : {}),
    ...(result.access ? { access: result.access } : {}),
  };
}

/** Whether a place's evaluated hours, while still current, say it is closed now. */
function closedByHours(place: CategoryPlace, now: number): boolean {
  const info = presentOpeningHoursInfo(place.openingHoursInfo, place.openingHours, now);
  return info?.status?.isUnknown !== true && info?.status?.isOpen === false;
}

/**
 * A mapped parking place as a candidate, or null when a visitor cannot park
 * there now: it is private or for permit holders, a space kept for one group,
 * or closed by its hours.
 */
export function fromPlaceSearch(place: CategoryPlace, now = Date.now()): NearbyParkingPlace | null {
  const tags = place.osmTags ?? {};
  const access = tags.access ? OSM_ACCESS[tags.access] : undefined;
  if (!openToVisitors(access)) return null;
  if (tags.parking_space && RESERVED_SPACES.has(tags.parking_space)) return null;
  if (closedByHours(place, now)) return null;
  const fee = tags.fee === "no" ? "free" : tags.fee === "yes" ? "paid" : undefined;
  return {
    ...place,
    ...(fee ? { fee } : {}),
    ...(access ? { access } : {}),
  };
}
