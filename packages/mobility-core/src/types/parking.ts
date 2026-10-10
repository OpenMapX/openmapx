import type { Attribution } from "./attribution.js";

export type ParkingSiteType =
  | "off_street"
  | "on_street"
  | "park_and_ride"
  | "truck_parking"
  | "rest_area_parking";

export type ParkingLayout =
  | "single_level"
  | "multi_storey"
  | "underground"
  | "surface"
  | "automated"
  | "covered"
  | "nested"
  | "unknown";

export type ParkingStatus =
  | "open"
  | "closed"
  | "full"
  | "almost_full"
  | "spaces_available"
  | "closed_abnormally"
  | "unknown";

export type ParkingTrend = "filling" | "clearing" | "steady";

/**
 * What a site, or one of its areas, reports about its spaces. A count is
 * absent when the source does not give it, never a zero standing in for
 * "unknown".
 */
export interface ParkingCounts {
  capacity?: number;
  /** Free spaces. */
  available?: number;
  status?: ParkingStatus;
  trend?: ParkingTrend;
  /** ISO 8601 time the counts were reported upstream. */
  at?: string;
  /** True when a reading the counts come from is past its `validUntil`. */
  stale: boolean;
}

/**
 * The spaces of one vehicle type reserved for one user group at a site.
 * Presence without a count is an area with no `capacity`.
 */
export interface ParkingArea extends ParkingCounts {
  /** `<vehicleType>:<userGroup>`, unique within the site. */
  key: string;
  vehicleType: string;
  /** `any` for untyped spaces. */
  userGroup: string;
}

/**
 * A tariff. A `flat` row is a price for a stay up to `toMin`, starting at
 * `fromMin`. A `per_hour` row is an hourly price charged in steps of
 * `stepMin`, applying from `fromMin` to `toMin`.
 */
export interface ParkingRate {
  currency: string;
  rows: {
    kind: "flat" | "per_hour";
    amount: number;
    fromMin?: number;
    toMin?: number;
    stepMin?: number;
    userGroups?: string[];
  }[];
  text?: string;
}

export interface ParkingSite extends ParkingCounts {
  id: string;
  name: string;
  /** ISO 3166-1 alpha-2 code of the site's country, when known. */
  country?: string;
  /** [lng, lat] */
  coordinates: [number, number];
  type?: ParkingSiteType;
  layout?: ParkingLayout;
  closed: boolean;
  operator?: string;
  website?: string;
  address?: string;
  /** OSM-format opening_hours string. */
  openingHours?: string;
  openingHoursText?: string;
  audience?: "public" | "customers" | "permit" | "private" | "restricted" | "unknown";
  free?: boolean;
  /** Maximum vehicle height in centimetres. */
  heightLimitCm?: number;
  areas: ParkingArea[];
  rates: ParkingRate[];
  tariffText?: string;
  notes?: string;
  sources: string[];
  attributions: Attribution[];
}
