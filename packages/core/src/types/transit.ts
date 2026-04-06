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
  id: string;
  shortName: string;
  longName: string;
  mode: TransportMode;
  color?: string;
  textColor?: string;
  operatorName: string;
  geometry?: {
    type: "LineString" | "MultiLineString";
    coordinates: [number, number][] | [number, number][][];
  };
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
  scheduledAt: string;
  expectedAt?: string;
  delaySeconds?: number;
  platform?: string;
  canceled?: boolean;
  occupancy?: OccupancyLevel;
  remarks?: TripRemark[];
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

export interface TripLeg {
  mode: TransportMode;
  startTime: string;
  endTime: string;
  from: { name: string; lat: number; lng: number; stopId?: string };
  to: { name: string; lat: number; lng: number; stopId?: string };
  route?: Pick<TransitRoute, "shortName" | "longName" | "color">;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  /** Prefixed trip ID (e.g. "db:1234567"). Present on transit legs. Enables live trip tracking. */
  tripId?: string;
  /** Prefixed route ID (e.g. "db:line-123"). Enables route alerts and live vehicle display. */
  routeId?: string;
  /** Number of intermediate stops between from and to (excluding endpoints). @internal sent by backend. */
  _intermediateStopCount?: number;
  fareTransferIndex?: number;
  effectiveFareLegIndex?: number;
  /** Occupancy level for this transit leg (e.g. from RIS::Transports or FPTF). */
  occupancy?: OccupancyLevel;
}

export interface TripItinerary {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  walkDistance: number;
  legs: TripLeg[];
  fare?: TripFare;
}

export interface TripPlan {
  from: { name: string; lat: number; lng: number };
  to: { name: string; lat: number; lng: number };
  itineraries: TripItinerary[];
  provider?: string;
}

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
  speed?: number;
  label?: string;
  currentStopId?: string;
  currentStopSequence?: number;
  updatedAt: string;
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

/** A transit route merged across multiple providers. */
export interface MergedRoute extends TransitRoute {
  providers: string[];
  /** Suggested stop ID to resolve route stop sequences for providers lacking route-stops APIs. */
  hintStopId?: string;
}

/** A departure merged across multiple providers/stops. */
export interface MergedDeparture extends Departure {
  providers: string[];
  /** All non-empty trip IDs collected from all providers (for fallback trip lookups). */
  tripIds?: string[];
}
