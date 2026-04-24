export type GtfsRouteMode =
  | "bus"
  | "rail"
  | "subway"
  | "tram"
  | "ferry"
  | "gondola"
  | "funicular"
  | "cable_car"
  | "monorail";

export const GTFS_ROUTE_TYPE_MODE: Readonly<Record<number, GtfsRouteMode>> = {
  0: "tram",
  1: "subway",
  2: "rail",
  3: "bus",
  4: "ferry",
  5: "cable_car",
  6: "gondola",
  7: "funicular",
  11: "bus",
  12: "monorail",
};

/**
 * Map GTFS route_type values, including Google extended ranges, into OpenMapX's
 * transit mode set.
 */
export function mapGtfsRouteTypeToMode(routeType: number): GtfsRouteMode {
  if (GTFS_ROUTE_TYPE_MODE[routeType]) return GTFS_ROUTE_TYPE_MODE[routeType];
  if (routeType >= 100 && routeType < 200) return "rail";
  if (routeType >= 200 && routeType < 300) return "bus";
  if (routeType >= 400 && routeType < 500) return "subway";
  if (routeType >= 700 && routeType < 800) return "bus";
  if (routeType >= 900 && routeType < 1000) return "tram";
  if (routeType >= 1000 && routeType < 1100) return "ferry";
  if (routeType >= 1200 && routeType < 1300) return "ferry";
  if (routeType >= 1300 && routeType < 1400) return "gondola";
  if (routeType >= 1400 && routeType < 1500) return "funicular";
  return "bus";
}

/** Convert GTFS date "YYYYMMDD" to ISO "YYYY-MM-DD". */
export function gtfsDateToIso(value: string): string {
  if (value.length !== 8) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}
