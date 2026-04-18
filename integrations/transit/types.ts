import type { BBox, Ids } from "@openmapx/core";

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
  /**
   * Canonical `scheme:value` id, typically `<provider>:<nativeId>`
   * (`tfl:490G00099A`, `mb:place-brntn`, `dyn:de/vrs:de:05315:11111`).
   * Duplicates `primaryScheme` + `ids[primaryScheme]` for convenience; use
   * the helpers in `@openmapx/core` to derive it consistently.
   */
  id: string;
  /**
   * Scheme key in `ids` that is canonical for this stop. Usually equal to
   * `provider`. Optional because many existing producers only set `id`
   * today; consumers that need the split should fall back to `parseId(id)`.
   */
  primaryScheme?: string;
  /**
   * Cross-reference map of every known identifier for this stop — native
   * provider id, plus any linked OSM/Wikidata refs a provider has matched.
   * Optional; when present, `geocodeStopAsPlace` carries entries forward
   * onto the resulting `Place.ids` so downstream panels can dispatch to
   * any of them.
   */
  ids?: Ids;
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

export interface TransitProviderCapabilities {
  stops: boolean;
  departures: boolean;
  arrivals: boolean;
  search: boolean;
  tripPlanning: boolean;
  alerts: boolean;
  vehicles: boolean;
}

export interface TripPlanParams {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  departureTime?: string;
  arrivalTime?: string;
  modes?: string[];
}

export interface AlertParams {
  stopId?: string;
  routeId?: string;
}

export interface TransitProvider {
  readonly id: string;
  readonly prefix: string;
  readonly coverage: { bbox: BBox };
  readonly priority: number;
  readonly capabilities: TransitProviderCapabilities;

  getStopsNearby?(lat: number, lng: number, radiusMeters: number): Promise<TransitStop[]>;
  getDepartures?(stopId: string, minutes: number): Promise<Departure[]>;
  getArrivals?(stopId: string, minutes: number): Promise<Departure[]>;
  searchByName?(query: string, limit: number): Promise<TransitStop[]>;
  getStop?(stopId: string): Promise<TransitStop | null>;
  getStopPlatforms?(stopId: string): Promise<TransitStop[]>;
  getStopTimetable?(stopId: string, date: string): Promise<Departure[]>;
  getRoutesForStop?(stopId: string): Promise<TransitRoute[]>;
  getRoutesInBbox?(bbox: BBox): Promise<TransitRoute[]>;
  getRoute?(routeId: string): Promise<TransitRoute | null>;
  getRouteStops?(routeId: string, hintStopId?: string): Promise<TransitStop[]>;
  planTrip?(params: TripPlanParams): Promise<TripPlan | null>;
  getLegGeometry?(
    tripId: string,
    fromStopId?: string,
    toStopId?: string,
  ): Promise<GeoJSONLineString | null>;
  getAlerts?(bbox: BBox): Promise<ServiceAlert[]>;
  getStopAlerts?(stopId: string): Promise<ServiceAlert[]>;
  getRouteAlerts?(routeId: string): Promise<ServiceAlert[]>;
  getVehiclePositions?(routeId: string): Promise<VehiclePosition[]>;
  getVehicleRadar?(bbox: BBox): Promise<VehiclePosition[]>;
  getVehicleJourney?(vehicleId: string, fallbackIds?: string[]): Promise<unknown>;
  getFacilities?(stopId: string): Promise<unknown>;
  getReachableStops?(
    lat: number,
    lng: number,
    maxMinutes: number,
    modes?: string[],
  ): Promise<TransitStop[]>;
}
