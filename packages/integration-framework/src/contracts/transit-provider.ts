import type { BBox } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type {
  Departure,
  Facility,
  ServiceAlert,
  StopTransfer,
  TransitRoute,
  TransitStop,
  TransitStopInfrastructure,
  TripItinerary,
  TripPlan,
  VehicleJourney,
  VehiclePosition,
} from "@openmapx/mobility-core/transit";
import type { LineString } from "geojson";
import type { HealthCheckResult } from "../context.js";
import type { ProviderCallContext } from "../provider-execution.js";

/**
 * Per-runtime-feed attribution map returned by `getFeedAttribution`. Keys
 * MUST match what downstream consumers carry on `TransitStop.provider`,
 * `VehicleJourney.provider`, and `ServiceAlert.providers[]` so the
 * frontend can render the correct license chip via the `/providers`
 * endpoint.
 */
export interface ProviderAttribution {
  label: string;
  url?: string;
  license?: string;
  licenseUrl?: string;
}

export interface TransitCapabilities {
  stops: {
    lookup: boolean;
    nearby: boolean;
    bbox: boolean;
    search: boolean;
    infrastructure: boolean;
    platforms: boolean;
    timetable: boolean;
  };
  departures: boolean;
  arrivals: boolean;
  routes: {
    lookup: boolean;
    forStop: boolean;
    stops: boolean;
    geometry: boolean;
  };
  planning: boolean;
  /** Explicit planning matrix. Missing means every advanced constraint is unsupported. */
  planningFeatures?: TransitPlanningCapabilities;
  vehiclePositions: boolean;
  vehicleJourney: boolean;
  alerts: {
    byStop: boolean;
    byRoute: boolean;
    byBbox: boolean;
  };
  facilities: boolean;
}

export interface TransitPlanningMetadata {
  source: string;
  instance: string;
  datasetEpoch: string;
  rentalFormFactors: TransitRentalFormFactor[];
}

export type TransitProviderRole = "baseline" | "fallback" | "enrichment" | "regional";

export interface TransitPlanningCapabilities {
  maxTransfers: boolean;
  transferBuffer: boolean;
  wheelchairRequired: boolean;
  bikeTransport: boolean;
  elevation: boolean;
  rentalFilters: boolean;
  detailedTransfers: boolean;
  paging: boolean;
  refresh: boolean;
}

export type TransitRentalFormFactor =
  | "BICYCLE"
  | "CARGO_BICYCLE"
  | "SCOOTER_STANDING"
  | "SCOOTER_SEATED"
  | "CAR"
  | "MOPED";
export type TransitRentalPropulsion =
  | "HUMAN"
  | "ELECTRIC_ASSIST"
  | "ELECTRIC"
  | "COMBUSTION"
  | "HYBRID";
export interface TransitRentalFilter {
  formFactors?: TransitRentalFormFactor[];
  propulsionTypes?: TransitRentalPropulsion[];
  providerIds?: string[];
  groupIds?: string[];
  source: string;
  instance: string;
  datasetEpoch: string;
}
export interface TransitRentalFilters {
  direct?: TransitRentalFilter;
  preTransit?: TransitRentalFilter;
  postTransit?: TransitRentalFilter;
}

export interface TripPlanRequest {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  departureTime?: string;
  arrivalTime?: string;
  /** Transit mode allow-list passed to MOTIS `transitModes` (e.g. ["BUS", "TRAM"]). */
  modes?: string[];
  /** When true, request wheelchair-accessible routing (MOTIS pedestrianProfile=WHEELCHAIR). */
  wheelchair?: boolean;
  wheelchairRequired?: boolean;
  maxTransfers?: number;
  transferBuffer?: "standard" | "relaxed" | "extra";
  requireBikeTransport?: boolean;
  bikeHillPreference?: "default" | "avoid" | "strongly-avoid";
  rentalFilters?: TransitRentalFilters;
  capabilityEpoch?: string;
  pageCursor?: string;
  /** MOTIS `preTransitModes` — first-mile access modes (e.g. ["BIKE"], ["CAR_PARKING"]). */
  preTransitModes?: string[];
  /** MOTIS `postTransitModes` — last-mile egress modes. */
  postTransitModes?: string[];
  /** MOTIS `directModes` — non-transit door-to-door modes; surfaced as `direct` itineraries. */
  directModes?: string[];
  /** Number of itineraries to request (MOTIS `numItineraries`); the provider default applies when unset. */
  numItineraries?: number;
  /**
   * Restrict results to Deutschlandticket-valid connections (regional/local
   * transport only). Each provider applies this its own way — MOTIS intersects
   * the mode allow-list with the covered set, db-vendo uses DB's native
   * "Nur Deutschlandticket-Verbindungen" filter.
   */
  deutschlandticketOnly?: boolean;
}

export interface TripRefreshRequest {
  itineraryId: string;
  datasetEpoch: string;
  modes?: string[];
  wheelchairRequired?: boolean;
  requireBikeTransport?: boolean;
  detailedTransfers?: boolean;
}

// Re-exported so consumers of the framework barrel don't need a separate
// @openmapx/core import just for this one return type.
export type { VehicleJourney };

/**
 * Static timetable entry for a stop. Providers resolve
 * `getStopTimetable(stopId, date)` to a departure array, so the canonical shape
 * is reused here.
 */
export type TimetableEntry = Departure;

export interface TransitProvider {
  readonly id: string;
  readonly prefix: string;
  readonly coverage: { bbox: BBox } | { all: true };
  readonly priority: number;
  /** Operation policy role. */
  readonly role: TransitProviderRole;
  readonly capabilities: TransitCapabilities;
  readonly planningMetadata?: TransitPlanningMetadata;
  readonly attribution: Attribution[];

  getStop?(id: string): Promise<MobilityResult<TransitStop | null>>;
  getStopsNearby?(
    lat: number,
    lng: number,
    radiusMeters: number,
  ): Promise<MobilityResult<TransitStop[]>>;
  getStopsInBbox?(bbox: BBox): Promise<MobilityResult<TransitStop[]>>;
  searchStopsByName?(
    q: string,
    limit?: number,
    context?: ProviderCallContext,
  ): Promise<MobilityResult<TransitStop[]>>;
  getStopInfrastructure?(stopId: string): Promise<MobilityResult<TransitStopInfrastructure | null>>;
  getStopPlatforms?(stopId: string): Promise<MobilityResult<TransitStop[]>>;
  getStopTimetable?(stopId: string, date: string): Promise<MobilityResult<TimetableEntry[]>>;
  /** Accessibility-annotated transfers out of a stop (foot/wheelchair, elevator). */
  getStopTransfers?(stopId: string): Promise<MobilityResult<StopTransfer[]>>;

  getDepartures?(stopId: string, minutes: number): Promise<MobilityResult<Departure[]>>;
  /** Arrivals reuse the departure shape; the `direction` field
   *  distinguishes inbound from outbound. Providers populate it with arriving
   *  trips at the given stop within `minutes`. */
  getArrivals?(stopId: string, minutes: number): Promise<MobilityResult<Departure[]>>;

  getRoute?(routeId: string): Promise<MobilityResult<TransitRoute | null>>;
  getRouteStops?(routeId: string, hintStopId?: string): Promise<MobilityResult<TransitStop[]>>;
  getRoutesForStop?(stopId: string): Promise<MobilityResult<TransitRoute[]>>;
  getLegGeometry?(
    tripId: string,
    fromStopId?: string,
    toStopId?: string,
  ): Promise<MobilityResult<LineString | null>>;

  planTrip?(opts: TripPlanRequest): Promise<MobilityResult<TripPlan[]>>;
  refreshTrip?(opts: TripRefreshRequest): Promise<MobilityResult<TripItinerary | null>>;
  getVehicleJourney?(
    tripId: string,
    fallbackIds?: string[],
  ): Promise<MobilityResult<VehicleJourney | null>>;
  getVehiclePositions?(routeId: string): Promise<MobilityResult<VehiclePosition[]>>;
  getVehicleRadar?(bbox: BBox): Promise<MobilityResult<VehiclePosition[]>>;

  getAlertsForStop?(stopId: string): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForRoute?(routeId: string): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForBbox?(bbox: BBox): Promise<MobilityResult<ServiceAlert[]>>;
  getFacilities?(stopId: string): Promise<MobilityResult<Facility[]>>;

  /**
   * Optional bbox-scoped lookups. Not part of the declared capability set
   * because no consumer drives them today; kept on the interface so providers
   * (e.g. transit-overpass for route geometry) can opt in incrementally.
   */
  getRoutesInBbox?(bbox: BBox, zoom?: number): Promise<MobilityResult<TransitRoute[]>>;
  getReachableStops?(
    lat: number,
    lng: number,
    maxMinutes: number,
    modes?: string[],
  ): Promise<MobilityResult<TransitStop[]>>;

  /**
   * Optional per-instance attribution. Returned alongside the manifest-level
   * `dataSources[0]` attribution. Useful when one integration fronts many
   * distinct feeds or runtime instances each carrying its own license, such as
   * `transit-dynamic-registry` (one row per `transport-apis` instance).
   *
   * Keys MUST match what consumers look up: `TransitStop.provider`,
   * `VehicleJourney.provider`, `ServiceAlert.providers[]`.
   */
  getFeedAttribution?(): Promise<Record<string, ProviderAttribution>>;

  /** Optional. Providers that have no meaningful self-check (e.g. thin
   *  pass-throughs) may omit this and rely on `ctx.registerHealthCheck()`
   *  declared at integration setup instead. */
  healthCheck?(): Promise<HealthCheckResult>;
}
