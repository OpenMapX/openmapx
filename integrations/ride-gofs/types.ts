import type {
  GofsBookingRule,
  GofsCalendar,
  GofsFare,
  GofsOperatingRule,
  GofsServiceBrand,
  GofsSystemInformation,
  GofsVehicleType,
  GofsZoneFeature,
} from "@openmapx/mobility-formats";

/**
 * How a keyed feed expects its credential. Feeds differ: the Montreal taxi
 * registry wants an `X-API-KEY` header, others take a query parameter.
 */
export type GofsAuth =
  | { kind: "header"; name: string; value: string }
  | { kind: "query"; name: string; value: string };

/** One GOFS feed, from the catalog or the operator's own list. */
export interface GofsFeedConfig {
  id: string;
  name: string;
  /** Absolute URL of the feed's discovery document. */
  url: string;
  /** Present only when a credential has been stored for this feed. */
  auth?: GofsAuth;
}

/** Everything static a feed publishes, resolved through discovery. */
export interface GofsStaticFeed {
  system: GofsSystemInformation;
  brands: GofsServiceBrand[];
  zones: GofsZoneFeature[];
  rules: GofsOperatingRule[];
  calendars: GofsCalendar[];
  fares: GofsFare[];
  bookingRules: GofsBookingRule[];
  vehicleTypes: GofsVehicleType[];
  /** Null when the feed publishes no realtime booking endpoint. */
  realtimeBookingUrl: string | null;
  /** Null when the feed publishes no wait-time endpoint. */
  waitTimeUrl: string | null;
}

export interface GofsPointQuery {
  pickup: [number, number];
  dropoff?: [number, number];
  pickupAddress?: string;
  dropoffAddress?: string;
  brandIds?: string[];
}
