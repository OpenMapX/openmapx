import type { Ids } from "@openmapx/core";
import type { Attribution } from "./attribution.js";

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

export interface TransitFormationReference {
  operatorRef?: string;
  operatingDayRef?: string;
  trainNumber?: string;
}

export interface TransitFormationStopSummary {
  platform?: string;
  scheduledAt?: string;
  shortFormation?: string;
  stopId?: string;
  stopName?: string;
}

export interface TransitFormationVehicleDetail {
  bikeSpaces?: number;
  closed?: boolean;
  hasAirConditioning?: boolean;
  hasLowFloorAccess?: boolean;
  hasToilet?: boolean;
  id?: string;
  lengthMeters?: number;
  order?: number;
  sector?: string;
  seatsFirstClass?: number;
  seatsSecondClass?: number;
  typeCode?: string;
  typeName?: string;
  wheelchairSpaces?: number;
}

export interface TransitFormationDetail {
  lastUpdate?: string;
  lengthMeters?: number;
  operatorCode?: string;
  operationDate?: string;
  seats?: number;
  shortFormation?: string;
  source: string;
  stops?: TransitFormationStopSummary[];
  trainNumber?: string;
  vehicleCount?: number;
  vehicles?: TransitFormationVehicleDetail[];
}

export interface TransitServiceAttribute {
  accessFacility?: string;
  code?: string;
  text?: string;
  userText?: string;
}

export interface TransitServiceInfo {
  attributes?: TransitServiceAttribute[];
  canceled?: boolean;
  destinationStopPointRef?: string;
  destinationText?: string;
  deviation?: boolean;
  directionRef?: string;
  formation?: TransitFormationReference[];
  journeyRef?: string;
  lineRef?: string;
  modeName?: string;
  modeShortName?: string;
  occupancy?: OccupancyLevel;
  occupancyClasses?: {
    firstClass?: OccupancyLevel;
    secondClass?: OccupancyLevel;
  };
  occupancyRaw?: string;
  occupancySource?: string;
  occupancyUpdatedAt?: string;
  operatingDayRef?: string;
  operatorAbbreviation?: string;
  operatorName?: string;
  operatorOrganisationNumber?: string;
  operatorParticipantRef?: string;
  operatorRef?: string;
  operatorRefs?: string[];
  originStopPointRef?: string;
  originText?: string;
  productCategoryName?: string;
  productCategoryRef?: string;
  productCategoryShortName?: string;
  ptMode?: string;
  publicCode?: string;
  publishedLineName?: string;
  publishedServiceName?: string;
  routeDescription?: string;
  serviceFeatureRefs?: string[];
  situationIds?: string[];
  submode?: string;
  trainNumber?: string;
  undefinedDelay?: boolean;
  unplanned?: boolean;
  vehicleFeatureRefs?: string[];
  vehicleRef?: string;
  viaStopPointRefs?: string[];
  viaTexts?: string[];
}

export interface TransitIntermodalLeg {
  attributes?: TransitServiceAttribute[];
  bufferTimeSeconds?: number;
  durationSeconds?: number;
  feasibility?: string[];
  guidanceTexts?: string[];
  legDescription?: string;
  lengthMeters?: number;
  personalMode?: string;
  situationIds?: string[];
  timeWindowEnd?: string;
  timeWindowStart?: string;
  transferMode?: string;
  transferType?: string;
  walkDurationSeconds?: number;
}

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
  formation?: TransitFormationReference[];
  remarks?: TripRemark[];
  serviceInfo?: TransitServiceInfo;
}

export interface FareProduct {
  authorityName?: string;
  authorityRef?: string;
  id?: string;
  infoUrls?: string[];
  name: string;
  amount: number;
  currency: string;
  netAmount?: number;
  riderCategory?: { name: string; isDefault: boolean };
  media?: { name?: string; type: string };
  saleUrls?: string[];
  travelClass?: string;
  vatRate?: number;
}

export interface TripFare {
  results?: Array<{
    fromLegId?: string;
    products: FareProduct[];
    toLegId?: string;
  }>;
  source?: string;
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
  /** Richer OJP/SIRI service metadata for the transit vehicle operating this leg. */
  serviceInfo?: TransitServiceInfo;
  /** Additional modeling for transfer/continuous/intermodal legs. */
  intermodal?: TransitIntermodalLeg;
  fareTransferIndex?: number;
  effectiveFareLegIndex?: number;
  /** Occupancy level for this transit leg (e.g. from RIS::Transports or FPTF). */
  occupancy?: OccupancyLevel;
  formation?: TransitFormationReference[];
  boardNameSuffix?: string;
  alightNameSuffix?: string;
  /**
   * Per-leg attribution: which upstream feeds contributed this specific leg.
   * Typically a subset of the envelope-level attributions; the orchestrator
   * fans it out so the UI can render per-leg credits inline. Optional —
   * providers that cannot compute it (single-feed planners) emit nothing.
   */
  attributions?: Attribution[];
}

export interface TripItinerary {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  walkDistance: number;
  distanceMeters?: number;
  /** Estimated CO2 emissions for the itinerary in grams, when the provider supplies it. */
  co2Grams?: number;
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
  formation?: TransitFormationReference[];
  formationDetails?: TransitFormationDetail;
  remarks?: TripRemark[];
  serviceInfo?: TransitServiceInfo;
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

export interface TransitStopAreaSummary {
  id: string;
  name: string;
  lat: number;
  lng: number;
  modes: TransportMode[];
  level: "parent_stop" | "child_stop" | "platform";
  stopType?: string;
  weighting?: string;
  parentStopId?: string;
}

export interface TransitPlatformDetail {
  id: string;
  name: string;
  lat: number;
  lng: number;
  modes: TransportMode[];
  parentStopId: string;
  publicCode?: string;
  privateCode?: string;
  bearing?: number;
  boardingPositions?: string[];
  accessibilityLabels?: string[];
  amenityLabels?: string[];
}

export interface TransitAccessibilityItem {
  id: string;
  category: "step_free" | "wheelchair" | "elevator" | "escalator" | "visual" | "audible" | "other";
  label: string;
  available: boolean;
}

export interface TransitAmenityItem {
  id: string;
  category: "waiting_room" | "ticketing" | "toilets" | "bike_storage" | "parking" | "other";
  label: string;
  count?: number;
}

export interface TransitStopParking {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: "bike_parking" | "parking" | "park_and_ride" | "other";
  vehicleTypes: string[];
  capacity?: number;
  freeSpaces?: number;
  hasRealtimeData?: boolean;
}

export type TransitInterchangeComplexity =
  | "simple_stop"
  | "interchange"
  | "regional_hub"
  | "major_interchange";

export interface TransitStationIntelligence {
  complexity: TransitInterchangeComplexity;
  modeCount: number;
  hasParking: boolean;
  hasRealtimeParking: boolean;
}

export interface TransitFareZoneSummary {
  id: string;
  name: string;
  authorityId?: string;
  authorityName?: string;
  privateCode?: string;
  hasGeometry?: boolean;
  isDeprecatedTariffZone?: boolean;
}

export interface TransitTopographicPlaceSummary {
  id: string;
  name: string;
  placeType?: string;
  parentTopographicPlaceId?: string;
}

export interface TransitStopInfrastructureFact {
  label: string;
  value: string;
}

export interface TransitGeoJsonPolygon {
  type: "Polygon";
  coordinates: [number, number][][];
}

export interface TransitGeoJsonMultiPolygon {
  type: "MultiPolygon";
  coordinates: [number, number][][][];
}

export interface TransitStopInfrastructureGeometry {
  stopArea?: TransitGeoJsonPolygon | TransitGeoJsonMultiPolygon;
  fareZones?: Array<{
    fareZoneId: string;
    geometry: TransitGeoJsonPolygon | TransitGeoJsonMultiPolygon;
  }>;
}

export interface TransitStopInfrastructure {
  stopId: string;
  provider: string;
  sourceId: string;
  displayName: string;
  focusLevel: "parent_stop" | "child_stop" | "platform";
  requestedStop: TransitStopAreaSummary;
  canonicalStop: TransitStopAreaSummary;
  parentStop?: TransitStopAreaSummary;
  siblingStops: TransitStopAreaSummary[];
  childStops: TransitStopAreaSummary[];
  platforms: TransitPlatformDetail[];
  accessibility: TransitAccessibilityItem[];
  amenities: TransitAmenityItem[];
  parking: TransitStopParking[];
  fareZones: TransitFareZoneSummary[];
  topographicPlace?: TransitTopographicPlaceSummary;
  stationIntelligence?: TransitStationIntelligence;
  facts: TransitStopInfrastructureFact[];
  geometry?: TransitStopInfrastructureGeometry;
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
