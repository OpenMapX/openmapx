export type TransportMode =
  | "bus"
  | "rail"
  | "subway"
  | "tram"
  | "ferry"
  | "gondola"
  | "funicular"
  | "cable_car"
  | "monorail"
  | "walking";

export interface TransitStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  modes: TransportMode[];
  platformCode?: string;
  parentStationId?: string;
  provider: string;
}

export interface TransitRoute {
  id: string; // "tl:{onestop_id}" | "tr:{id}"
  shortName: string;
  longName: string;
  mode: TransportMode;
  color?: string; // hex without #
  textColor?: string;
  operatorName: string;
  geometry?: GeoJSONLineString | GeoJSONMultiLineString;
}

export interface GeoJSONLineString {
  type: "LineString";
  coordinates: [number, number][];
}

export interface GeoJSONMultiLineString {
  type: "MultiLineString";
  coordinates: [number, number][][];
}

export interface TripRemark {
  text: string;
  type: "info" | "warning" | "cancellation";
}

export type OccupancyLevel = "low" | "medium" | "high" | "overcrowded";

export interface Departure {
  tripId: string;
  route: Pick<TransitRoute, "id" | "shortName" | "longName" | "mode" | "color">;
  headsign: string;
  scheduledAt: string; // ISO 8601
  expectedAt?: string; // ISO 8601 (realtime)
  delaySeconds?: number;
  platform?: string;
  canceled?: boolean;
  occupancy?: OccupancyLevel;
  remarks?: TripRemark[];
}

export interface TripLeg {
  mode: TransportMode;
  startTime: string; // ISO 8601
  endTime: string;
  from: { name: string; lat: number; lng: number; stopId?: string };
  to: { name: string; lat: number; lng: number; stopId?: string };
  route?: Pick<TransitRoute, "shortName" | "longName" | "color">;
  geometry: GeoJSONLineString;
  /** Prefixed trip ID (e.g. "db:1234567", "vbb:...", "mo:..."). Enables live trip tracking. */
  tripId?: string;
  /** Prefixed route ID (e.g. "db:line-123"). Enables route alerts and live vehicle display. */
  routeId?: string;
  /** @internal Number of intermediate stops (excluding from/to). Used to decide if geometry needs road-snapping. */
  _intermediateStopCount?: number;
  /** Index into the fare transfer array (from MOTIS fare data). */
  fareTransferIndex?: number;
  /** Index into the effective fare leg products for this transfer. */
  effectiveFareLegIndex?: number;
  /** Occupancy level for this transit leg (e.g. from RIS::Transports or FPTF). */
  occupancy?: OccupancyLevel;
}

export interface TripItinerary {
  duration: number; // seconds
  startTime: string;
  endTime: string;
  transfers: number;
  walkDistance: number; // meters
  legs: TripLeg[];
  fare?: TripFare;
}

export interface FareProduct {
  name: string;
  amount: number;
  currency: string;
  riderCategory?: { name: string; isDefault: boolean };
  media?: { name?: string; type: string };
}

export interface TripFare {
  transfers: Array<{
    rule?: string;
    transferProducts?: FareProduct[];
    legProducts: FareProduct[][][];
  }>;
}

export interface TripPlan {
  from: { name: string; lat: number; lng: number };
  to: { name: string; lat: number; lng: number };
  itineraries: TripItinerary[];
  provider?: string;
}

export type BBox = [west: number, south: number, east: number, north: number];

export type AlertSeverity = "info" | "warning" | "severe" | "critical";

export interface ServiceAlert {
  id: string;
  providers: string[];
  severity: AlertSeverity;
  effect?: string;
  title: string;
  description?: string;
  affectedRouteIds: string[];
  affectedStopIds: string[];
  activePeriods: { start: string; end?: string }[];
}

export interface VehiclePosition {
  id: string;
  provider: string;
  tripId?: string;
  routeId?: string;
  lat: number;
  lng: number;
  bearing?: number;
  speed?: number; // m/s
  label?: string;
  currentStopId?: string;
  currentStopSequence?: number;
  updatedAt: string; // ISO 8601
}

export interface RouteLive {
  vehicles: VehiclePosition[];
  alerts: ServiceAlert[];
}

export interface VehicleJourneyStop {
  stopId: string;
  name: string;
  lat: number;
  lng: number;
  platform?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  expectedArrival?: string;
  expectedDeparture?: string;
  delaySeconds?: number;
  canceled?: boolean;
  departed?: boolean;
}

export interface VehicleJourney {
  id: string;
  name: string;
  provider: string;
  occupancy?: OccupancyLevel;
  remarks?: TripRemark[];
  stops: VehicleJourneyStop[];
}

export interface Facility {
  id: string;
  stopId: string;
  name: string;
  type: "elevator" | "escalator" | "bike_storage" | "parking" | "other";
  isAccessible: boolean;
  provider: string;
}

export interface RouteStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  platformCode?: string;
  sequence: number;
}

export interface TripPlanParams {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  modes: string; // "WALK,TRANSIT" | "WALK,BUS" | etc.
  numItineraries?: number;
  /** When true, `date`+`time` is the desired arrival time, not departure. */
  arriveBy?: boolean;
  /** Language for localized responses (e.g. "en", "de"). */
  lang?: string;
}

/** A transit route that has been merged across multiple providers. */
export interface MergedRoute extends TransitRoute {
  /** All providers that reported this route (deduplicated). */
  providers: string[];
}

/** A departure that has been merged across multiple providers/stops. */
export interface MergedDeparture extends Departure {
  /** All providers that reported this departure (deduplicated). */
  providers: string[];
  /** All non-empty trip IDs collected from all providers (for fallback trip lookups). */
  tripIds?: string[];
}
