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
  | "walking"
  // Non-transit street modes, used for intermodal first/last-mile and direct
  // (door-to-door) legs returned by the transit planner. `cycling` also covers
  // bike-share rentals; `driving` covers car, park-and-ride and car-share.
  | "cycling"
  | "driving";

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
  /**
   * Travel time in minutes to reach this stop, populated only by reachability
   * (one-to-all) queries. Lets the UI colour stops by time band.
   */
  reachMinutes?: number;
  /** Number of transfers used to reach this stop in a reachability query. */
  reachTransfers?: number;
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
  route: Pick<TransitRoute, "id" | "shortName" | "longName" | "mode" | "color" | "textColor">;
  headsign: string;
  scheduledAt: string;
  expectedAt?: string;
  delaySeconds?: number;
  platform?: string;
  /** Scheduled platform/track; distinct from {@link platform} to flag changes. */
  scheduledPlatform?: string;
  canceled?: boolean;
  occupancy?: OccupancyLevel;
  formation?: TransitFormationReference[];
  remarks?: TripRemark[];
  serviceInfo?: TransitServiceInfo;
  provenance?: TransitObservationProvenance;
}

export interface TransitObservationProvenance {
  baselineSource: string;
  instance: string;
  datasetEpoch?: string;
  realtimeCompleteness: "none" | "merged" | "changed" | "unknown";
  observedAt: string;
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

/**
 * Vehicle-rental (GBFS bike/scooter/car-share) details for a rental leg,
 * derived from the MOTIS `Rental` object. Present only on `RENTAL` legs.
 */
export interface TransitRentalInfo {
  systemId: string;
  systemName?: string;
  /** Provider display name (falls back to systemName). */
  providerName?: string;
  /** Brand colour (hex, without a leading `#`, matching route/leg colours). */
  color?: string;
  /** GBFS form factor, e.g. "BICYCLE", "SCOOTER_STANDING", "CAR". */
  formFactor?: string;
  propulsionType?: string;
  providerId?: string;
  providerGroupId?: string;
  /** Where the rental must be returned; absent means MOTIS did not report it. */
  returnConstraint?: "NONE" | "ANY_STATION" | "ROUNDTRIP_STATION";
  fromStationName?: string;
  toStationName?: string;
  /** Best booking deep-link (web URI, falling back to the system URL). */
  bookingUrl?: string;
}

export interface TransitPlace {
  name: string;
  lat: number;
  lng: number;
  stopId?: string;
  /** OSM floor/level. Absence is distinct from ground level (0). */
  level?: number;
  /** Current platform/track (realtime if available, else scheduled). */
  platformCode?: string;
  /**
   * Scheduled platform/track from the static timetable. Kept distinct from
   * {@link platformCode} so a realtime platform change is derivable
   * (`platformCode !== scheduledPlatformCode`).
   */
  scheduledPlatformCode?: string;
}

export interface TransitStep {
  /** Stable MOTIS direction code; presentation layers localize it. */
  instruction: string;
  streetName?: string;
  coordinates?: [number, number][];
  fromLevel?: number;
  toLevel?: number;
  distanceMeters: number;
  durationSeconds?: number;
  stairs?: boolean;
  elevator?: boolean;
  accessibility?: "accessible" | "restricted" | "unknown";
  accessRestriction?: string;
  ascentMeters?: number;
  descentMeters?: number;
}

/**
 * On-demand / flexible transport metadata for a leg whose MOTIS mode is
 * `ODM`, `RIDE_SHARING` or `FLEX`. These services usually require advance
 * booking, so the UI surfaces a booking link and pickup window.
 */
export interface TransitFlexInfo {
  kind: "odm" | "ride_sharing" | "flex";
  /** Booking deep-link (route or agency URL from the feed), when available. */
  bookingUrl?: string;
  /** Flex service area / location-group name (FLEX only). */
  areaName?: string;
  /** ISO start of the pickup/drop-off booking window (FLEX only). */
  pickupWindowStart?: string;
  /** ISO end of the pickup/drop-off booking window (FLEX only). */
  pickupWindowEnd?: string;
}

/** An alternative departure for a transit leg (earlier/later same-route service). */
export interface TransitLegAlternative {
  startTime: string;
  endTime: string;
  /** Prefixed trip id of the alternative's transit leg, when available. */
  tripId?: string;
  routeShortName?: string;
}

export interface TripLeg {
  mode: TransportMode;
  startTime: string;
  endTime: string;
  /**
   * Scheduled leg departure/arrival from the static timetable (MOTIS
   * `scheduledStartTime`/`scheduledEndTime`). Kept alongside the realtime
   * {@link startTime}/{@link endTime} so per-leg delay is derivable without a
   * separate trip fetch. Transit legs only.
   */
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  from: TransitPlace;
  to: TransitPlace;
  route?: Pick<TransitRoute, "shortName" | "longName" | "color" | "textColor">;
  /**
   * Destination sign shown on the vehicle (MOTIS `Leg.headsign`), e.g. the
   * "towards …" text riders match against at the platform. Transit legs only.
   */
  headsign?: string;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  distanceMeters?: number;
  durationSeconds?: number;
  /** Whether MOTIS had realtime data for this leg. */
  realtime?: boolean;
  cancelled?: boolean;
  interlineWithPrevious?: boolean;
  bikesAllowed?: boolean;
  /** Absence means MOTIS did not report the restriction. */
  wheelchairAccessible?: boolean;
  steps?: TransitStep[];
  ascentMeters?: number;
  descentMeters?: number;
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
  /** GBFS vehicle-rental details, present on bike/scooter/car-share (`RENTAL`) legs. */
  rental?: TransitRentalInfo;
  /** On-demand / flexible transport details, present on ODM/RIDE_SHARING/FLEX legs. */
  flex?: TransitFlexInfo;
  /**
   * Alternative departures that could replace this transit leg (earlier/later
   * services on the same or comparable routes), from MOTIS leg alternatives.
   * Present only on transit legs when alternatives were requested.
   */
  alternatives?: TransitLegAlternative[];
  /** Occupancy level for this transit leg (e.g. from RIS::Transports or FPTF). */
  occupancy?: OccupancyLevel;
  formation?: TransitFormationReference[];
  boardNameSuffix?: string;
  alightNameSuffix?: string;
  /**
   * Service alerts/disruptions affecting this leg or its board/alight stops
   * (from MOTIS `Leg.alerts` + endpoint `Place.alerts`). Surfaced during
   * navigation so a cancellation or disruption on the ridden line is visible.
   */
  alerts?: ServiceAlert[];
  /**
   * Per-leg attribution: which upstream feeds contributed this specific leg.
   * Typically a subset of the envelope-level attributions; the orchestrator
   * fans it out so the UI can render per-leg credits inline. Optional —
   * providers that cannot compute it (single-feed planners) emit nothing.
   */
  attributions?: Attribution[];
}

export interface TripItinerary {
  id?: string;
  source?: string;
  instance?: string;
  datasetEpoch?: string;
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  walkDistance: number;
  distanceMeters?: number;
  /** Estimated CO2 emissions for the itinerary in grams, when the provider supplies it. */
  co2Grams?: number;
  ascentMeters?: number;
  descentMeters?: number;
  /** Hard requirements contradicted by provider output. */
  invalidRequirements?: string[];
  /** Opaque OpenMapX handle; never a raw MOTIS itinerary reference. */
  refreshToken?: string;
  refreshedAt?: string;
  plannedAt?: string;
  legs: TripLeg[];
  fare?: TripFare;
}

export interface TripPlan {
  from: { name: string; lat: number; lng: number };
  to: { name: string; lat: number; lng: number };
  itineraries: TripItinerary[];
  provider?: string;
  source?: string;
  instance?: string;
  datasetEpoch?: string;
  /** Provider-native cursors are internal and must be replaced by signed BFF tokens. */
  previousPageCursor?: string;
  nextPageCursor?: string;
  previousPageToken?: string;
  nextPageToken?: string;
}

export type AlertSeverity = "info" | "warning" | "severe" | "critical";

export interface ServiceAlert {
  id: string;
  providers: string[];
  severity: AlertSeverity;
  effect?: string;
  /** Disruption cause (e.g. MAINTENANCE, ACCIDENT), when the feed provides it. */
  cause?: string;
  title: string;
  description?: string;
  /** Text-to-speech-optimized header/description for voice guidance. */
  ttsTitle?: string;
  ttsDescription?: string;
  /** Operator's disruption page for "more info". */
  url?: string;
  imageUrl?: string;
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
  /** Vehicle's transport mode, for map icon/colour. */
  mode?: TransportMode;
  label?: string;
  currentStopId?: string;
  currentStopSequence?: number;
  updatedAt: string;
}

export interface RouteLive {
  vehicles: VehiclePosition[];
  alerts: ServiceAlert[];
}

/**
 * An accessibility-annotated transfer option between two stops, from the MOTIS
 * `transfers` endpoint. Durations are in minutes; absence means no path was
 * found for that profile (e.g. no `wheelchairMinutes` = no step-free route).
 */
export interface StopTransfer {
  toStopId: string;
  toName: string;
  /** Walking transfer time for the foot profile. */
  footMinutes?: number;
  /** Transfer time for the wheelchair profile; absent = no step-free path. */
  wheelchairMinutes?: number;
  /** Whether the step-free path relies on an elevator. */
  wheelchairUsesElevator?: boolean;
}

export interface VehicleJourneyStop {
  stopId: string;
  name: string;
  lat: number;
  lng: number;
  platform?: string;
  /** Scheduled platform/track; distinct from {@link platform} to flag changes. */
  scheduledPlatform?: string;
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
  /**
   * Human-readable names for {@link providers}, resolved from each provider's
   * attribution (e.g. "ms" → "MOTIS (self-hosted)"). Provider ids and attribution
   * sourceIds live in different namespaces, so the UI cannot derive these itself.
   */
  providerNames?: string[];
  /** Suggested stop ID to resolve route stop sequences for providers lacking route-stops APIs. */
  hintStopId?: string;
}

/** A departure merged across multiple providers/stops. */
export interface MergedDeparture extends Departure {
  providers: string[];
  /** All non-empty trip IDs collected from all providers (for fallback trip lookups). */
  tripIds?: string[];
}
