import type {
  AlertSeverity,
  BBox,
  Departure,
  Facility,
  GeoJSONLineString,
  OccupancyLevel,
  RouteStop,
  ServiceAlert,
  TransitAccessibilityItem,
  TransitAmenityItem,
  TransitFareZoneSummary,
  TransitGeoJsonMultiPolygon,
  TransitGeoJsonPolygon,
  TransitInterchangeComplexity,
  TransitPlatformDetail,
  TransitRoute,
  TransitStationIntelligence,
  TransitStop,
  TransitStopAreaSummary,
  TransitStopInfrastructure,
  TransitStopInfrastructureFact,
  TransitStopInfrastructureGeometry,
  TransitStopParking,
  TransitTopographicPlaceSummary,
  TransportMode,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
  VehicleJourneyStop,
  VehiclePosition,
} from "@openmapx/core";
import { decodePolyline } from "@openmapx/core";

type EnturMultiModal = "parent" | "child" | "all";
type BoardMode = "departures" | "arrivals" | "both";

interface EnturFeatureCollection {
  features?: EnturFeature[];
}

interface EnturFeature {
  geometry?: {
    coordinates?: [number, number];
  };
  properties?: {
    id?: string;
    source_id?: string;
    layer?: string;
    name?: string;
    category?: string[];
    mode?: Array<Record<string, string | null>>;
  };
}

interface EnturStopPlaceSummary {
  id: string;
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  transportMode?: Array<string | null> | null;
  transportSubmode?: Array<string | null> | null;
}

interface EnturQuay {
  id: string;
  name?: string | null;
  publicCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  stopPlace?: EnturStopPlaceSummary | null;
  lines?: EnturLine[] | null;
}

interface EnturLine {
  id: string;
  publicCode?: string | null;
  name?: string | null;
  transportMode?: string | null;
  transportSubmode?: string | null;
  authority?: {
    id: string;
    name?: string | null;
  } | null;
  operator?: {
    id: string;
    name?: string | null;
  } | null;
  presentation?: {
    colour?: string | null;
    textColour?: string | null;
  } | null;
  journeyPatterns?: EnturJourneyPattern[] | null;
  situations?: EnturSituation[] | null;
  quays?: EnturQuay[] | null;
}

interface EnturJourneyPattern {
  id: string;
  name?: string | null;
  directionType?: string | null;
  quays?: EnturQuay[] | null;
  pointsOnLink?: {
    points?: string | null;
  } | null;
}

interface EnturEstimatedCall {
  quay?: EnturQuay | null;
  aimedArrivalTime?: string | null;
  expectedArrivalTime?: string | null;
  actualArrivalTime?: string | null;
  aimedDepartureTime?: string | null;
  expectedDepartureTime?: string | null;
  actualDepartureTime?: string | null;
  realtime?: boolean | null;
  occupancyStatus?: string | null;
  cancellation?: boolean | null;
  forBoarding?: boolean | null;
  forAlighting?: boolean | null;
  destinationDisplay?: {
    frontText?: string | null;
  } | null;
  serviceJourney?: {
    id: string;
    publicCode?: string | null;
    line?: EnturLine | null;
    transportMode?: string | null;
    transportSubmode?: string | null;
  } | null;
  situations?: EnturSituation[] | null;
}

interface EnturStopPlace extends EnturStopPlaceSummary {
  quays?: EnturQuay[] | null;
  estimatedCalls?: EnturEstimatedCall[] | null;
  situations?: EnturSituation[] | null;
}

interface EnturPlace {
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  quay?: EnturQuay | null;
}

interface EnturTripLeg {
  mode: string;
  transportSubmode?: string | null;
  realtime?: boolean | null;
  ride?: boolean | null;
  expectedStartTime?: string | null;
  expectedEndTime?: string | null;
  distance?: number | null;
  serviceDate?: string | null;
  fromPlace?: EnturPlace | null;
  toPlace?: EnturPlace | null;
  fromEstimatedCall?: EnturEstimatedCall | null;
  toEstimatedCall?: EnturEstimatedCall | null;
  line?: EnturLine | null;
  serviceJourney?: {
    id: string;
    publicCode?: string | null;
  } | null;
  pointsOnLink?: {
    points?: string | null;
  } | null;
  intermediateEstimatedCalls?: EnturEstimatedCall[] | null;
}

interface EnturTripPattern {
  expectedStartTime?: string | null;
  expectedEndTime?: string | null;
  duration?: number | null;
  streetDistance?: number | null;
  walkTime?: number | null;
  distance?: number | null;
  emission?: {
    co2?: number | null;
  } | null;
  legs?: EnturTripLeg[] | null;
}

interface EnturTrip {
  fromPlace?: EnturPlace | null;
  toPlace?: EnturPlace | null;
  tripPatterns?: EnturTripPattern[] | null;
}

interface EnturValidityPeriod {
  startTime?: string | null;
  endTime?: string | null;
}

interface EnturMultilingualText {
  value?: string | null;
  language?: string | null;
}

interface EnturSituation {
  id: string;
  summary?: EnturMultilingualText[] | null;
  description?: EnturMultilingualText[] | null;
  reportType?: string | null;
  severity?: string | null;
  validityPeriod?: EnturValidityPeriod | null;
  lines?: Array<Pick<EnturLine, "id"> | null> | null;
  stopPlaces?: Array<EnturStopPlaceSummary | null> | null;
  quays?: Array<EnturQuay | null> | null;
}

interface EnturVehicle {
  vehicleId?: string | null;
  lastUpdated?: string | null;
  bearing?: number | null;
  speed?: number | null;
  delay?: number | null;
  monitored?: boolean | null;
  mode?: string | null;
  occupancyStatus?: string | null;
  vehicleStatus?: string | null;
  line?: {
    lineRef?: string | null;
    lineName?: string | null;
    publicCode?: string | null;
  } | null;
  serviceJourney?: {
    id: string;
    date?: string | null;
  } | null;
  operator?: {
    operatorRef?: string | null;
    name?: string | null;
  } | null;
  codespace?: {
    codespaceId?: string | null;
  } | null;
  location?: {
    latitude?: number | null;
    longitude?: number | null;
  } | null;
  monitoredCall?: {
    stopPointRef?: string | null;
    order?: number | null;
    vehicleAtStop?: boolean | null;
  } | null;
}

interface EnturServiceJourney {
  id: string;
  publicCode?: string | null;
  transportMode?: string | null;
  transportSubmode?: string | null;
  line?: EnturLine | null;
  journeyPattern?: EnturJourneyPattern | null;
  quays?: EnturQuay[] | null;
  estimatedCalls?: EnturEstimatedCall[] | null;
  pointsOnLink?: {
    points?: string | null;
  } | null;
  situations?: EnturSituation[] | null;
}

interface NsrTextValue {
  lang?: string | null;
  value?: string | null;
}

interface NsrRefValue {
  ref?: string | null;
}

interface NsrRef {
  ref?: string | null;
  version?: string | null;
  created?: string | null;
  type?: string | null;
  value?: NsrRefValue | null;
}

interface NsrLocation {
  latitude?: number | null;
  longitude?: number | null;
}

interface NsrPoint {
  location?: NsrLocation | null;
}

interface NsrPosList {
  value?: number[] | null;
}

interface NsrLinearRingShape {
  posList?: NsrPosList | null;
}

interface NsrAbstractRingShape {
  type?: string | null;
  value?: NsrLinearRingShape | null;
}

interface NsrRingProperty {
  abstractRing?: NsrAbstractRingShape | null;
}

interface NsrPolygonShape {
  exterior?: NsrRingProperty | null;
  interior?: Array<NsrRingProperty | null> | null;
}

interface NsrAbstractSurfaceShape {
  type?: string | null;
  value?: NsrPolygonShape | NsrMultiSurfaceShape | null;
}

interface NsrSurfaceProperty {
  abstractSurface?: NsrAbstractSurfaceShape | null;
}

interface NsrSurfaceArray {
  abstractSurface?: Array<NsrAbstractSurfaceShape | null> | null;
}

interface NsrMultiSurfaceShape {
  surfaceMember?: Array<NsrSurfaceProperty | null> | null;
  surfaceMembers?: NsrSurfaceArray | null;
}

interface NsrPrivateCode {
  type?: string | null;
  value?: string | null;
}

interface NsrAccessibilityLimitation {
  id?: string | null;
  liftFreeAccess?: string | null;
  escalatorFreeAccess?: string | null;
  stepFreeAccess?: string | null;
  wheelchairAccess?: string | null;
  audibleSignalsAvailable?: string | null;
  visualSignsAvailable?: string | null;
}

interface NsrAccessibilityAssessment {
  limitations?: {
    accessibilityLimitation?: NsrAccessibilityLimitation | NsrAccessibilityLimitation[] | null;
  } | null;
}

interface NsrEquipmentValue {
  numberOfToilets?: number | null;
  seats?: number | null;
  numberOfMachines?: number | null;
  ticketMachines?: boolean | null;
  ticketOffice?: boolean | null;
}

interface NsrPlaceEquipmentItem {
  type?: string | null;
  value?: NsrEquipmentValue | null;
}

interface NsrBoardingPosition {
  id?: string | null;
  publicCode?: string | null;
  privateCode?: NsrPrivateCode | null;
  centroid?: NsrPoint | null;
}

interface NsrParking {
  id?: string | null;
  name?: NsrTextValue | null;
  parkingVehicleTypes?: string[] | null;
  totalCapacity?: number | null;
  principalCapacity?: number | null;
  realTimeOccupancyAvailable?: boolean | null;
  publicCode?: string | null;
  privateCode?: NsrPrivateCode | null;
  parkingType?: string | null;
  centroid?: NsrPoint | null;
  polygon?: NsrPolygonShape | null;
  multiSurface?: NsrMultiSurfaceShape | null;
}

interface NsrStopPlaceRecord {
  id?: string | null;
  name?: NsrTextValue | null;
  centroid?: NsrPoint | null;
  transportMode?: string | null;
  stopPlaceType?: string | null;
  weighting?: string | null;
  parentSiteRef?: NsrRef | null;
  topographicPlaceRef?: NsrRef | null;
  publicCode?: string | null;
  privateCode?: NsrPrivateCode | null;
  polygon?: NsrPolygonShape | null;
  multiSurface?: NsrMultiSurfaceShape | null;
  accessibilityAssessment?: NsrAccessibilityAssessment | null;
  placeEquipments?: {
    installedEquipmentRefOrInstalledEquipment?: Array<NsrPlaceEquipmentItem | null> | null;
  } | null;
  quays?: {
    quayRefOrQuay?: Array<NsrQuayRecord | null> | null;
  } | null;
  tariffZones?: {
    tariffZoneRef?: Array<NsrRef | null> | null;
  } | null;
}

interface NsrQuayRecord {
  id?: string | null;
  publicCode?: string | null;
  privateCode?: NsrPrivateCode | null;
  transportMode?: string | null;
  compassBearing?: number | null;
  centroid?: NsrPoint | null;
  polygon?: NsrPolygonShape | null;
  multiSurface?: NsrMultiSurfaceShape | null;
  accessibilityAssessment?: NsrAccessibilityAssessment | null;
  placeEquipments?: {
    installedEquipmentRefOrInstalledEquipment?: Array<NsrPlaceEquipmentItem | null> | null;
  } | null;
  boardingPositions?: {
    boardingPositionRefOrBoardingPosition?: Array<NsrBoardingPosition | null> | null;
  } | null;
  parentQuayRef?: NsrRef | null;
}

interface NsrFareZoneRecord {
  id?: string | null;
  name?: NsrTextValue | null;
  transportOrganisationRef?: NsrRef | null;
  privateCode?: NsrPrivateCode | null;
  polygon?: NsrPolygonShape | null;
  multiSurface?: NsrMultiSurfaceShape | null;
}

interface NsrTopographicPlaceRecord {
  id?: string | null;
  name?: NsrTextValue | null;
  descriptor?: {
    name?: NsrTextValue | null;
  } | null;
  topographicPlaceType?: string | null;
  parentTopographicPlaceRef?: NsrRef | null;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

const ENTUR_PREFIX = "entur:";
const NSR_PREFIX = "NSR:";
const DEFAULT_GEOCODER_ENDPOINT = "https://api.entur.io/geocoder/v1";
const DEFAULT_JOURNEY_PLANNER_ENDPOINT = "https://api.entur.io/journey-planner/v3/graphql";
const DEFAULT_VEHICLES_ENDPOINT = "https://api.entur.io/realtime/v2/vehicles/graphql";
const DEFAULT_NSR_ENDPOINT = "https://api.entur.io/stop-places/v1/read";
const DEFAULT_CLIENT_NAME = "openmapx-server";
const DEFAULT_BOUNDARY_COUNTRY = "NOR";
const DEFAULT_MULTI_MODAL: EnturMultiModal = "parent";
const REQUEST_TIMEOUT_MS = 8_000;
const FULL_DAY_SECONDS = 24 * 60 * 60;
const DAY_TOKEN_SEPARATOR = "|";

const FEATURE_CATEGORY_MODE_MAP: Record<string, TransportMode> = {
  railStation: "rail",
  vehicleRailInterchange: "rail",
  metroStation: "subway",
  tramStation: "tram",
  onstreetTram: "tram",
  busStation: "bus",
  coachStation: "bus",
  onstreetBus: "bus",
  ferryPort: "ferry",
  ferryStop: "ferry",
  harbourPort: "ferry",
  liftStation: "gondola",
};

const FEATURE_MODE_KEY_MAP: Record<string, TransportMode> = {
  bus: "bus",
  coach: "bus",
  rail: "rail",
  metro: "subway",
  subway: "subway",
  tram: "tram",
  ferry: "ferry",
  water: "ferry",
  lift: "gondola",
  cableway: "cable_car",
  cablecar: "cable_car",
  cable_car: "cable_car",
  funicular: "funicular",
  monorail: "monorail",
};

let geocoderEndpoint = DEFAULT_GEOCODER_ENDPOINT;
let journeyPlannerEndpoint = DEFAULT_JOURNEY_PLANNER_ENDPOINT;
let vehiclesEndpoint = DEFAULT_VEHICLES_ENDPOINT;
let nsrEndpoint = DEFAULT_NSR_ENDPOINT;
let clientName = DEFAULT_CLIENT_NAME;
let boundaryCountry = DEFAULT_BOUNDARY_COUNTRY;
let multiModal: EnturMultiModal = DEFAULT_MULTI_MODAL;

const NEARBY_STOPS_QUERY = `
query NearbyStops($latitude: Float!, $longitude: Float!, $maximumDistance: Float!, $maximumResults: Int!) {
  nearest(
    latitude: $latitude
    longitude: $longitude
    maximumDistance: $maximumDistance
    maximumResults: $maximumResults
    filterByPlaceTypes: [stopPlace]
    filterByInUse: true
    multiModalMode: parent
  ) {
    edges {
      node {
        distance
        place {
          __typename
          ... on StopPlace {
            id
            name
            latitude
            longitude
            transportMode
            transportSubmode
          }
        }
      }
    }
  }
}`;

const STOP_PLACE_DETAIL_QUERY = `
query StopPlaceDetail($id: String!) {
  stopPlace(id: $id) {
    id
    name
    latitude
    longitude
    transportMode
    transportSubmode
    quays {
      id
      name
      publicCode
      latitude
      longitude
      stopPlace {
        id
        name
        latitude
        longitude
        transportMode
        transportSubmode
      }
    }
  }
}`;

const QUAY_DETAIL_QUERY = `
query QuayDetail($id: String!) {
  quay(id: $id) {
    id
    name
    publicCode
    latitude
    longitude
    stopPlace {
      id
      name
      latitude
      longitude
      transportMode
      transportSubmode
    }
  }
}`;

const ESTIMATED_CALL_FIELDS = `
  quay {
    id
    name
    publicCode
    latitude
    longitude
    stopPlace {
      id
      name
      latitude
      longitude
      transportMode
      transportSubmode
    }
  }
  aimedArrivalTime
  expectedArrivalTime
  actualArrivalTime
  aimedDepartureTime
  expectedDepartureTime
  actualDepartureTime
  realtime
  occupancyStatus
  cancellation
  forBoarding
  forAlighting
  destinationDisplay { frontText }
  serviceJourney {
    id
    publicCode
    transportMode
    transportSubmode
    line {
      id
      publicCode
      name
      transportMode
      transportSubmode
      authority { id name }
      operator { id name }
      presentation { colour textColour }
    }
  }
  situations {
    id
    summary { value language }
    description { value language }
    reportType
    severity
    validityPeriod { startTime endTime }
    lines { id }
    stopPlaces { id name latitude longitude }
    quays {
      id
      name
      latitude
      longitude
      stopPlace { id name latitude longitude }
    }
  }
`;

const STOP_PLACE_BOARD_QUERY = `
query StopPlaceBoard(
  $id: String!
  $timeRange: Int!
  $numberOfDepartures: Int!
  $arrivalDeparture: ArrivalDeparture!
  $startTime: DateTime
) {
  stopPlace(id: $id) {
    id
    name
    situations {
      id
      summary { value language }
      description { value language }
      reportType
      severity
      validityPeriod { startTime endTime }
      lines { id }
      stopPlaces { id name latitude longitude }
      quays {
        id
        name
        latitude
        longitude
        stopPlace { id name latitude longitude }
      }
    }
    estimatedCalls(
      startTime: $startTime
      timeRange: $timeRange
      numberOfDepartures: $numberOfDepartures
      arrivalDeparture: $arrivalDeparture
      includeCancelledTrips: true
    ) {
      ${ESTIMATED_CALL_FIELDS}
    }
  }
}`;

const QUAY_BOARD_QUERY = `
query QuayBoard(
  $id: String!
  $timeRange: Int!
  $numberOfDepartures: Int!
  $arrivalDeparture: ArrivalDeparture!
  $startTime: DateTime
) {
  quay(id: $id) {
    id
    name
    publicCode
    stopPlace {
      id
      name
      latitude
      longitude
      transportMode
      transportSubmode
    }
    situations {
      id
      summary { value language }
      description { value language }
      reportType
      severity
      validityPeriod { startTime endTime }
      lines { id }
      stopPlaces { id name latitude longitude }
      quays {
        id
        name
        latitude
        longitude
        stopPlace { id name latitude longitude }
      }
    }
    estimatedCalls(
      startTime: $startTime
      timeRange: $timeRange
      numberOfDepartures: $numberOfDepartures
      arrivalDeparture: $arrivalDeparture
      includeCancelledTrips: true
    ) {
      ${ESTIMATED_CALL_FIELDS}
    }
  }
}`;

const STOP_PLACE_ROUTES_QUERY = `
query StopPlaceRoutes($id: String!) {
  stopPlace(id: $id) {
    id
    quays {
      id
      lines {
        id
        publicCode
        name
        transportMode
        transportSubmode
        authority { id name }
        operator { id name }
        presentation { colour textColour }
      }
    }
  }
}`;

const QUAY_ROUTES_QUERY = `
query QuayRoutes($id: String!) {
  quay(id: $id) {
    id
    lines {
      id
      publicCode
      name
      transportMode
      transportSubmode
      authority { id name }
      operator { id name }
      presentation { colour textColour }
    }
  }
}`;

const LINE_DETAIL_QUERY = `
query LineDetail($id: ID!) {
  line(id: $id) {
    id
    publicCode
    name
    transportMode
    transportSubmode
    authority { id name }
    operator { id name }
    presentation { colour textColour }
    journeyPatterns {
      id
      name
      directionType
      pointsOnLink { points }
      quays {
        id
        name
        publicCode
        latitude
        longitude
        stopPlace {
          id
          name
          latitude
          longitude
        }
      }
    }
    situations {
      id
      summary { value language }
      description { value language }
      reportType
      severity
      validityPeriod { startTime endTime }
      lines { id }
      stopPlaces { id name latitude longitude }
      quays {
        id
        name
        latitude
        longitude
        stopPlace { id name latitude longitude }
      }
    }
  }
}`;

const TRIP_PLAN_QUERY = `
query PlanTrip(
  $fromLat: Float!
  $fromLon: Float!
  $toLat: Float!
  $toLon: Float!
  $dateTime: DateTime!
  $arriveBy: Boolean
  $numTripPatterns: Int
) {
  trip(
    from: { coordinates: { latitude: $fromLat, longitude: $fromLon }, name: "Origin" }
    to: { coordinates: { latitude: $toLat, longitude: $toLon }, name: "Destination" }
    dateTime: $dateTime
    arriveBy: $arriveBy
    numTripPatterns: $numTripPatterns
  ) {
    fromPlace { name latitude longitude }
    toPlace { name latitude longitude }
    tripPatterns {
      expectedStartTime
      expectedEndTime
      duration
      streetDistance
      walkTime
      distance
      emission { co2 }
      legs {
        id
        mode
        transportSubmode
        realtime
        ride
        expectedStartTime
        expectedEndTime
        distance
        serviceDate
        fromPlace {
          name
          latitude
          longitude
          quay {
            id
            publicCode
            stopPlace { id name latitude longitude }
          }
        }
        toPlace {
          name
          latitude
          longitude
          quay {
            id
            publicCode
            stopPlace { id name latitude longitude }
          }
        }
        fromEstimatedCall {
          aimedDepartureTime
          expectedDepartureTime
          actualDepartureTime
          occupancyStatus
          cancellation
          destinationDisplay { frontText }
          quay {
            id
            publicCode
            stopPlace { id name latitude longitude }
          }
        }
        toEstimatedCall {
          aimedArrivalTime
          expectedArrivalTime
          actualArrivalTime
          occupancyStatus
          cancellation
          quay {
            id
            publicCode
            stopPlace { id name latitude longitude }
          }
        }
        line {
          id
          publicCode
          name
          transportMode
          transportSubmode
          authority { id name }
          operator { id name }
          presentation { colour textColour }
        }
        serviceJourney { id publicCode }
        pointsOnLink { points }
        intermediateEstimatedCalls {
          quay {
            id
            publicCode
            stopPlace { id name latitude longitude }
          }
          aimedArrivalTime
          expectedArrivalTime
          aimedDepartureTime
          expectedDepartureTime
          occupancyStatus
          cancellation
        }
      }
    }
  }
}`;

const SERVICE_JOURNEY_QUERY = `
query ServiceJourney($id: String!, $date: Date!) {
  serviceJourney(id: $id) {
    id
    publicCode
    transportMode
    transportSubmode
    pointsOnLink { points }
    situations {
      id
      summary { value language }
      description { value language }
      reportType
      severity
      validityPeriod { startTime endTime }
      lines { id }
      stopPlaces { id name latitude longitude }
      quays {
        id
        name
        latitude
        longitude
        stopPlace { id name latitude longitude }
      }
    }
    line {
      id
      publicCode
      name
      transportMode
      transportSubmode
      authority { id name }
      operator { id name }
      presentation { colour textColour }
    }
    journeyPattern {
      id
      name
      pointsOnLink { points }
      quays {
        id
        name
        publicCode
        latitude
        longitude
        stopPlace {
          id
          name
          latitude
          longitude
        }
      }
    }
    quays(first: 200) {
      id
      name
      publicCode
      latitude
      longitude
      stopPlace {
        id
        name
        latitude
        longitude
      }
    }
    estimatedCalls(date: $date) {
      quay {
        id
        name
        publicCode
        latitude
        longitude
        stopPlace {
          id
          name
          latitude
          longitude
        }
      }
      aimedArrivalTime
      expectedArrivalTime
      actualArrivalTime
      aimedDepartureTime
      expectedDepartureTime
      actualDepartureTime
      occupancyStatus
      cancellation
      forBoarding
      forAlighting
      situations {
        id
        summary { value language }
        description { value language }
        reportType
        severity
        validityPeriod { startTime endTime }
        lines { id }
        stopPlaces { id name latitude longitude }
        quays {
          id
          name
          latitude
          longitude
          stopPlace { id name latitude longitude }
        }
      }
    }
  }
}`;

const NATIONAL_SITUATIONS_QUERY = `
{
  situations {
    id
    summary { value language }
    description { value language }
    reportType
    severity
    validityPeriod { startTime endTime }
    lines { id }
    stopPlaces { id name latitude longitude }
    quays {
      id
      name
      latitude
      longitude
      stopPlace { id name latitude longitude }
    }
  }
}`;

const VEHICLES_BY_LINE_QUERY = `
query VehiclesByLine($lineRef: String!, $maxDataAge: Duration!) {
  vehicles(lineRef: $lineRef, maxDataAge: $maxDataAge, monitored: true) {
    vehicleId
    lastUpdated
    bearing
    speed
    delay
    monitored
    mode
    occupancyStatus
    vehicleStatus
    line { lineRef lineName publicCode }
    serviceJourney { id date }
    operator { operatorRef name }
    codespace { codespaceId }
    location { latitude longitude }
    monitoredCall { stopPointRef order vehicleAtStop }
  }
}`;

const VEHICLES_BY_BBOX_QUERY = `
query VehiclesByBoundingBox(
  $minLat: Float!
  $minLon: Float!
  $maxLat: Float!
  $maxLon: Float!
  $maxDataAge: Duration!
) {
  vehicles(
    boundingBox: { minLat: $minLat, minLon: $minLon, maxLat: $maxLat, maxLon: $maxLon }
    maxDataAge: $maxDataAge
    monitored: true
  ) {
    vehicleId
    lastUpdated
    bearing
    speed
    delay
    monitored
    mode
    occupancyStatus
    vehicleStatus
    line { lineRef lineName publicCode }
    serviceJourney { id date }
    operator { operatorRef name }
    codespace { codespaceId }
    location { latitude longitude }
    monitoredCall { stopPointRef order vehicleAtStop }
  }
}`;

const HEALTHCHECK_QUERY = `
query HealthCheck($id: String!) {
  stopPlace(id: $id) { id }
}`;

export function setEnturTransitConfig(config: {
  geocoderEndpoint?: string;
  journeyPlannerEndpoint?: string;
  vehiclesEndpoint?: string;
  nsrEndpoint?: string;
  clientName?: string;
  boundaryCountry?: string;
  multiModal?: EnturMultiModal;
}): void {
  geocoderEndpoint =
    config.geocoderEndpoint && config.geocoderEndpoint.trim().length > 0
      ? config.geocoderEndpoint.replace(/\/+$/, "")
      : DEFAULT_GEOCODER_ENDPOINT;
  journeyPlannerEndpoint =
    config.journeyPlannerEndpoint && config.journeyPlannerEndpoint.trim().length > 0
      ? config.journeyPlannerEndpoint.trim()
      : DEFAULT_JOURNEY_PLANNER_ENDPOINT;
  vehiclesEndpoint =
    config.vehiclesEndpoint && config.vehiclesEndpoint.trim().length > 0
      ? config.vehiclesEndpoint.trim()
      : DEFAULT_VEHICLES_ENDPOINT;
  nsrEndpoint =
    config.nsrEndpoint && config.nsrEndpoint.trim().length > 0
      ? config.nsrEndpoint.replace(/\/+$/, "")
      : DEFAULT_NSR_ENDPOINT;
  clientName =
    config.clientName && config.clientName.trim().length > 0
      ? config.clientName.trim()
      : DEFAULT_CLIENT_NAME;
  boundaryCountry =
    config.boundaryCountry && config.boundaryCountry.trim().length > 0
      ? config.boundaryCountry.trim().toUpperCase()
      : "";
  multiModal = config.multiModal ?? DEFAULT_MULTI_MODAL;
}

function withEnturPrefix(rawId: string): string {
  return `${ENTUR_PREFIX}${rawId}`;
}

function stripKnownPrefix(id: string): string {
  if (id.startsWith(ENTUR_PREFIX)) return id.slice(ENTUR_PREFIX.length);
  if (id.startsWith("nsr:")) return `${NSR_PREFIX}${id.slice(4)}`;
  return id;
}

function buildStopIdentity(rawId: string): Pick<TransitStop, "primaryScheme" | "ids"> {
  const ids: Record<string, string> = { entur: rawId };
  let primaryScheme = "entur";
  if (rawId.startsWith(NSR_PREFIX)) {
    ids.nsr = rawId.slice(NSR_PREFIX.length);
    primaryScheme = "nsr";
  }
  return { primaryScheme, ids };
}

function encodeServiceJourneyId(serviceJourneyId: string, date?: string): string {
  return withEnturPrefix(
    date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? `${date}${DAY_TOKEN_SEPARATOR}${serviceJourneyId}`
      : serviceJourneyId,
  );
}

function decodeServiceJourneyId(token: string): { serviceJourneyId: string; date?: string } {
  const raw = stripKnownPrefix(token);
  const separatorIndex = raw.indexOf(DAY_TOKEN_SEPARATOR);
  if (separatorIndex > 0) {
    const maybeDate = raw.slice(0, separatorIndex);
    if (/^\d{4}-\d{2}-\d{2}$/.test(maybeDate)) {
      return {
        date: maybeDate,
        serviceJourneyId: raw.slice(separatorIndex + 1),
      };
    }
  }
  return { serviceJourneyId: raw };
}

function isQuayId(rawId: string): boolean {
  return rawId.includes(":Quay:");
}

function isTruthyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toTransportMode(mode: string | null | undefined): TransportMode {
  const normalized = (mode ?? "").toLowerCase();
  switch (normalized) {
    case "rail":
      return "rail";
    case "metro":
      return "subway";
    case "tram":
      return "tram";
    case "water":
    case "ferry":
      return "ferry";
    case "lift":
      return "gondola";
    case "cableway":
      return "cable_car";
    case "funicular":
      return "funicular";
    case "monorail":
      return "monorail";
    case "coach":
    case "bus":
      return "bus";
    case "foot":
      return "walking";
    default:
      return "bus";
  }
}

function collectStopModes(
  transportModes?: Array<string | null> | null,
  categories?: string[] | null,
  featureModes?: Array<Record<string, string | null>> | null,
): TransportMode[] {
  const modes = new Set<TransportMode>();
  for (const raw of transportModes ?? []) {
    if (!raw) continue;
    modes.add(toTransportMode(raw));
  }
  for (const category of categories ?? []) {
    const mapped = FEATURE_CATEGORY_MODE_MAP[category];
    if (mapped) modes.add(mapped);
  }
  for (const entry of featureModes ?? []) {
    for (const [key] of Object.entries(entry)) {
      const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
      const mapped = FEATURE_MODE_KEY_MAP[normalized];
      if (mapped) modes.add(mapped);
    }
  }
  return modes.size > 0 ? [...modes] : ["bus"];
}

function toOccupancyLevel(raw: string | null | undefined): OccupancyLevel | undefined {
  switch (raw) {
    case "empty":
    case "manySeatsAvailable":
    case "seatsAvailable":
      return "low";
    case "fewSeatsAvailable":
    case "standingAvailable":
      return "medium";
    case "standingRoomOnly":
      return "high";
    case "crushedStandingRoomOnly":
    case "full":
    case "notAcceptingPassengers":
      return "overcrowded";
    default:
      return undefined;
  }
}

function toAlertSeverity(raw: string | null | undefined): AlertSeverity {
  switch (raw) {
    case "verySevere":
      return "critical";
    case "severe":
      return "severe";
    case "normal":
      return "warning";
    default:
      return "info";
  }
}

function pickLocalizedText(values: EnturMultilingualText[] | null | undefined): string | undefined {
  if (!values?.length) return undefined;
  const normalized = values.filter((value) => isTruthyString(value.value));
  for (const lang of ["en", "eng"]) {
    const match = normalized.find((value) => value.language?.toLowerCase() === lang);
    if (match?.value) return match.value;
  }
  for (const lang of ["no", "nor", "nob", "nno"]) {
    const match = normalized.find((value) => value.language?.toLowerCase() === lang);
    if (match?.value) return match.value;
  }
  return normalized[0]?.value ?? undefined;
}

function nsrTextValue(value: NsrTextValue | null | undefined): string | undefined {
  return isTruthyString(value?.value) ? value.value : undefined;
}

function normalizeColor(color: string | null | undefined): string | undefined {
  if (!isTruthyString(color)) return undefined;
  return color.replace(/^#/, "");
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function datePartFromIso(value: string | null | undefined): string | undefined {
  if (!isTruthyString(value)) return undefined;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

function shiftDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function dateCandidates(preferredDate?: string): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const ordered = [preferredDate, today, preferredDate ? shiftDate(preferredDate, -1) : undefined];
  if (preferredDate) {
    ordered.push(shiftDate(preferredDate, 1));
  } else {
    ordered.push(shiftDate(today, -1), shiftDate(today, 1));
  }
  return ordered.filter(
    (value, index, all): value is string => !!value && all.indexOf(value) === index,
  );
}

function calculateDelaySeconds(
  aimed: string | null | undefined,
  expected: string | null | undefined,
): number | undefined {
  if (!isTruthyString(aimed) || !isTruthyString(expected)) return undefined;
  const aimedMs = new Date(aimed).getTime();
  const expectedMs = new Date(expected).getTime();
  if (!Number.isFinite(aimedMs) || !Number.isFinite(expectedMs)) return undefined;
  const diff = Math.round((expectedMs - aimedMs) / 1000);
  return diff === 0 ? undefined : diff;
}

function decodePoints(points: string | null | undefined): [number, number][] {
  if (!isTruthyString(points)) return [];
  try {
    return decodePolyline(points);
  } catch {
    return [];
  }
}

function routeGeometryFromPatterns(
  patterns: EnturJourneyPattern[] | null | undefined,
): TransitRoute["geometry"] | undefined {
  const coordinates = (patterns ?? [])
    .map((pattern) => decodePoints(pattern.pointsOnLink?.points))
    .filter((line) => line.length >= 2);
  if (coordinates.length === 0) return undefined;
  if (coordinates.length === 1) {
    return { type: "LineString", coordinates: coordinates[0] };
  }
  return { type: "MultiLineString", coordinates };
}

function findNearestCoordinateIndex(
  coordinates: [number, number][],
  target: [number, number],
): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < coordinates.length; index++) {
    const [lng, lat] = coordinates[index];
    const deltaLng = lng - target[0];
    const deltaLat = lat - target[1];
    const score = deltaLng * deltaLng + deltaLat * deltaLat;
    if (score < bestDistance) {
      bestDistance = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function sliceGeometry(
  coordinates: [number, number][],
  fromCoord?: [number, number],
  toCoord?: [number, number],
): GeoJSONLineString | null {
  if (coordinates.length < 2) return null;
  if (!fromCoord || !toCoord) {
    return { type: "LineString", coordinates };
  }
  const start = findNearestCoordinateIndex(coordinates, fromCoord);
  const end = findNearestCoordinateIndex(coordinates, toCoord);
  if (end <= start) {
    return { type: "LineString", coordinates };
  }
  const sliced = coordinates.slice(start, end + 1);
  return sliced.length >= 2 ? { type: "LineString", coordinates: sliced } : null;
}

function pointFromStopOrQuay(
  rawStopId: string,
  estimatedCalls: EnturEstimatedCall[] | null | undefined,
): [number, number] | undefined {
  for (const call of estimatedCalls ?? []) {
    const quay = call.quay;
    if (!quay) continue;
    if (
      quay.id === rawStopId &&
      typeof quay.longitude === "number" &&
      typeof quay.latitude === "number"
    ) {
      return [quay.longitude, quay.latitude];
    }
    if (
      quay.stopPlace?.id === rawStopId &&
      typeof quay.stopPlace.longitude === "number" &&
      typeof quay.stopPlace.latitude === "number"
    ) {
      return [quay.stopPlace.longitude, quay.stopPlace.latitude];
    }
  }
  return undefined;
}

function isInsideBbox(bbox: BBox, longitude: number, latitude: number): boolean {
  return longitude >= bbox[0] && longitude <= bbox[2] && latitude >= bbox[1] && latitude <= bbox[3];
}

function normalizeLine(line: EnturLine | null | undefined): TransitRoute | null {
  if (!line?.id) return null;
  return {
    id: withEnturPrefix(line.id),
    shortName: line.publicCode ?? line.name ?? "",
    longName: line.name ?? line.publicCode ?? "",
    mode: toTransportMode(line.transportMode),
    color: normalizeColor(line.presentation?.colour),
    textColor: normalizeColor(line.presentation?.textColour),
    operatorName: line.operator?.name ?? line.authority?.name ?? "",
  };
}

function normalizeStopPlace(
  stopPlace: EnturStopPlaceSummary | null | undefined,
): TransitStop | null {
  if (
    !stopPlace?.id ||
    !isTruthyString(stopPlace.name) ||
    typeof stopPlace.latitude !== "number" ||
    typeof stopPlace.longitude !== "number"
  ) {
    return null;
  }
  return {
    id: withEnturPrefix(stopPlace.id),
    ...buildStopIdentity(stopPlace.id),
    name: stopPlace.name,
    lat: stopPlace.latitude,
    lng: stopPlace.longitude,
    modes: collectStopModes(stopPlace.transportMode),
    provider: "entur",
  };
}

function normalizeQuay(quay: EnturQuay | null | undefined): TransitStop | null {
  const stopPlace = quay?.stopPlace ?? null;
  const latitude = quay?.latitude ?? stopPlace?.latitude;
  const longitude = quay?.longitude ?? stopPlace?.longitude;
  const name = stopPlace?.name ?? quay?.name ?? null;
  if (
    !quay?.id ||
    !isTruthyString(name) ||
    typeof latitude !== "number" ||
    typeof longitude !== "number"
  ) {
    return null;
  }
  const stopModes = collectStopModes(stopPlace?.transportMode);
  return {
    id: withEnturPrefix(quay.id),
    ...buildStopIdentity(quay.id),
    name,
    lat: latitude,
    lng: longitude,
    modes: stopModes,
    platformCode: quay.publicCode ?? undefined,
    parentStationId: stopPlace?.id ? withEnturPrefix(stopPlace.id) : undefined,
    provider: "entur",
  };
}

function featureNativeId(feature: EnturFeature): string | undefined {
  return feature.properties?.id ?? feature.properties?.source_id;
}

function featureToTransitStop(feature: EnturFeature): TransitStop | null {
  const rawId = featureNativeId(feature);
  const coordinates = feature.geometry?.coordinates;
  if (
    feature.properties?.layer !== "venue" ||
    !rawId ||
    !rawId.startsWith(NSR_PREFIX) ||
    !coordinates ||
    coordinates.length < 2
  ) {
    return null;
  }
  const [lng, lat] = coordinates;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return {
    id: withEnturPrefix(rawId),
    ...buildStopIdentity(rawId),
    name: feature.properties?.name ?? rawId,
    lat,
    lng,
    modes: collectStopModes(undefined, feature.properties?.category, feature.properties?.mode),
    provider: "entur",
  };
}

function normalizeDeparture(
  call: EnturEstimatedCall,
  boardMode: Exclude<BoardMode, "both">,
): Departure | null {
  const line = normalizeLine(call.serviceJourney?.line);
  if (!line) return null;
  const scheduledAt = boardMode === "departures" ? call.aimedDepartureTime : call.aimedArrivalTime;
  const expectedAt =
    boardMode === "departures" ? call.expectedDepartureTime : call.expectedArrivalTime;
  if (!isTruthyString(scheduledAt)) return null;
  const date = datePartFromIso(
    boardMode === "departures" ? call.expectedDepartureTime : call.expectedArrivalTime,
  );
  return {
    tripId: call.serviceJourney?.id ? encodeServiceJourneyId(call.serviceJourney.id, date) : "",
    route: {
      id: line.id,
      shortName: line.shortName,
      longName: line.longName,
      mode: line.mode,
      color: line.color,
    },
    headsign:
      call.destinationDisplay?.frontText ?? call.serviceJourney?.line?.name ?? line.longName,
    scheduledAt,
    expectedAt: isTruthyString(expectedAt) && expectedAt !== scheduledAt ? expectedAt : undefined,
    delaySeconds: calculateDelaySeconds(scheduledAt, expectedAt),
    platform: call.quay?.publicCode ?? undefined,
    canceled: call.cancellation ?? false,
    occupancy: toOccupancyLevel(call.occupancyStatus),
    remarks: situationsToRemarks(call.situations),
  };
}

function mergeAlertArrays(alerts: ServiceAlert[]): ServiceAlert[] {
  const byId = new Map<string, ServiceAlert>();
  for (const alert of alerts) {
    const existing = byId.get(alert.id);
    if (!existing) {
      byId.set(alert.id, {
        ...alert,
        providers: [...alert.providers],
        affectedRouteIds: [...alert.affectedRouteIds],
        affectedStopIds: [...alert.affectedStopIds],
        activePeriods: [...alert.activePeriods],
      });
      continue;
    }
    for (const provider of alert.providers) {
      if (!existing.providers.includes(provider)) existing.providers.push(provider);
    }
    for (const routeId of alert.affectedRouteIds) {
      if (!existing.affectedRouteIds.includes(routeId)) existing.affectedRouteIds.push(routeId);
    }
    for (const stopId of alert.affectedStopIds) {
      if (!existing.affectedStopIds.includes(stopId)) existing.affectedStopIds.push(stopId);
    }
  }
  return Array.from(byId.values());
}

function situationToAlert(
  situation: EnturSituation,
  extra?: { routeId?: string; stopId?: string },
): ServiceAlert | null {
  if (!situation.id) return null;
  const title =
    pickLocalizedText(situation.summary) ??
    pickLocalizedText(situation.description) ??
    "Service alert";
  const affectedRouteIds = new Set<string>();
  const affectedStopIds = new Set<string>();
  if (extra?.routeId) affectedRouteIds.add(extra.routeId);
  if (extra?.stopId) affectedStopIds.add(extra.stopId);
  for (const line of situation.lines ?? []) {
    if (line?.id) affectedRouteIds.add(withEnturPrefix(line.id));
  }
  for (const stopPlace of situation.stopPlaces ?? []) {
    if (stopPlace?.id) affectedStopIds.add(withEnturPrefix(stopPlace.id));
  }
  for (const quay of situation.quays ?? []) {
    if (quay?.id) affectedStopIds.add(withEnturPrefix(quay.id));
    if (quay?.stopPlace?.id) affectedStopIds.add(withEnturPrefix(quay.stopPlace.id));
  }
  const activePeriods =
    situation.validityPeriod?.startTime != null
      ? [
          {
            start: situation.validityPeriod.startTime,
            end: situation.validityPeriod.endTime ?? undefined,
          },
        ]
      : [];
  return {
    id: withEnturPrefix(situation.id),
    providers: ["entur"],
    severity: toAlertSeverity(situation.severity),
    effect: situation.reportType ?? undefined,
    title,
    description: pickLocalizedText(situation.description),
    affectedRouteIds: [...affectedRouteIds],
    affectedStopIds: [...affectedStopIds],
    activePeriods,
  };
}

function situationsToRemarks(
  situations: EnturSituation[] | null | undefined,
): Departure["remarks"] | undefined {
  const remarks = (situations ?? [])
    .map((situation) => {
      const text = pickLocalizedText(situation.summary) ?? pickLocalizedText(situation.description);
      if (!text) return null;
      return {
        text,
        type:
          situation.severity === "severe" || situation.severity === "verySevere"
            ? ("warning" as const)
            : ("info" as const),
      };
    })
    .filter((remark): remark is NonNullable<typeof remark> => remark !== null);
  return remarks.length > 0 ? remarks : undefined;
}

function normalizeTripLeg(leg: EnturTripLeg): TripLeg | null {
  const fromLongitude = leg.fromPlace?.longitude;
  const fromLatitude = leg.fromPlace?.latitude;
  const toLongitude = leg.toPlace?.longitude;
  const toLatitude = leg.toPlace?.latitude;
  if (
    !isTruthyString(leg.expectedStartTime) ||
    !isTruthyString(leg.expectedEndTime) ||
    typeof fromLatitude !== "number" ||
    typeof fromLongitude !== "number" ||
    typeof toLatitude !== "number" ||
    typeof toLongitude !== "number"
  ) {
    return null;
  }

  const line = normalizeLine(leg.line);
  const geometryCoordinates = decodePoints(leg.pointsOnLink?.points);
  const geometry: GeoJSONLineString =
    geometryCoordinates.length >= 2
      ? { type: "LineString", coordinates: geometryCoordinates }
      : {
          type: "LineString",
          coordinates: [
            [fromLongitude, fromLatitude],
            [toLongitude, toLatitude],
          ],
        };

  const occupancyCandidates = [
    leg.fromEstimatedCall?.occupancyStatus,
    leg.toEstimatedCall?.occupancyStatus,
    ...(leg.intermediateEstimatedCalls ?? []).map((call) => call.occupancyStatus),
  ].map((status) => toOccupancyLevel(status));

  return {
    mode: leg.ride ? toTransportMode(leg.mode) : "walking",
    startTime: leg.expectedStartTime,
    endTime: leg.expectedEndTime,
    from: {
      name: leg.fromPlace?.name ?? "",
      lat: fromLatitude,
      lng: fromLongitude,
      stopId: leg.fromPlace?.quay?.stopPlace?.id
        ? withEnturPrefix(leg.fromPlace.quay.stopPlace.id)
        : leg.fromPlace?.quay?.id
          ? withEnturPrefix(leg.fromPlace.quay.id)
          : undefined,
    },
    to: {
      name: leg.toPlace?.name ?? "",
      lat: toLatitude,
      lng: toLongitude,
      stopId: leg.toPlace?.quay?.stopPlace?.id
        ? withEnturPrefix(leg.toPlace.quay.stopPlace.id)
        : leg.toPlace?.quay?.id
          ? withEnturPrefix(leg.toPlace.quay.id)
          : undefined,
    },
    route:
      leg.ride && line
        ? {
            shortName: line.shortName,
            longName: line.longName,
            color: line.color,
          }
        : undefined,
    geometry,
    tripId:
      leg.ride && leg.serviceJourney?.id
        ? encodeServiceJourneyId(
            leg.serviceJourney.id,
            leg.serviceDate ?? datePartFromIso(leg.expectedStartTime),
          )
        : undefined,
    routeId: leg.ride && line ? line.id : undefined,
    _intermediateStopCount: leg.intermediateEstimatedCalls?.length ?? 0,
    occupancy: occupancyCandidates.find((value) => value !== undefined),
  };
}

function normalizeTripPlan(trip: EnturTrip | null | undefined): TripPlan | null {
  const itineraries: TripItinerary[] = [];
  for (const pattern of trip?.tripPatterns ?? []) {
    const legs = (pattern.legs ?? [])
      .map((leg) => normalizeTripLeg(leg))
      .filter((leg): leg is TripLeg => leg !== null);
    if (legs.length === 0) continue;
    const walkDistance =
      typeof pattern.streetDistance === "number"
        ? Math.round(pattern.streetDistance)
        : Math.round(
            (pattern.legs ?? [])
              .filter((leg) => leg.ride !== true)
              .reduce((sum, leg) => sum + (leg.distance ?? 0), 0),
          );
    itineraries.push({
      duration: Math.round(pattern.duration ?? 0),
      startTime: pattern.expectedStartTime ?? legs[0].startTime,
      endTime: pattern.expectedEndTime ?? legs[legs.length - 1].endTime,
      transfers: Math.max(0, legs.filter((leg) => leg.route !== undefined).length - 1),
      walkDistance,
      co2Grams: typeof pattern.emission?.co2 === "number" ? pattern.emission.co2 : undefined,
      legs,
    });
  }
  if (itineraries.length === 0) return null;
  return {
    from: {
      name: trip?.fromPlace?.name ?? itineraries[0].legs[0]?.from.name ?? "",
      lat: trip?.fromPlace?.latitude ?? itineraries[0].legs[0]?.from.lat ?? 0,
      lng: trip?.fromPlace?.longitude ?? itineraries[0].legs[0]?.from.lng ?? 0,
    },
    to: {
      name:
        trip?.toPlace?.name ?? itineraries[0].legs[itineraries[0].legs.length - 1]?.to.name ?? "",
      lat:
        trip?.toPlace?.latitude ?? itineraries[0].legs[itineraries[0].legs.length - 1]?.to.lat ?? 0,
      lng:
        trip?.toPlace?.longitude ??
        itineraries[0].legs[itineraries[0].legs.length - 1]?.to.lng ??
        0,
    },
    itineraries,
    provider: "entur",
  };
}

function normalizeVehiclePosition(vehicle: EnturVehicle): VehiclePosition | null {
  if (
    !vehicle.location ||
    typeof vehicle.location.latitude !== "number" ||
    typeof vehicle.location.longitude !== "number" ||
    !isTruthyString(vehicle.lastUpdated)
  ) {
    return null;
  }
  const rawLineRef = vehicle.line?.lineRef;
  const rawServiceJourneyId = vehicle.serviceJourney?.id;
  const routeId = rawLineRef ? withEnturPrefix(rawLineRef) : undefined;
  const tripId = rawServiceJourneyId
    ? encodeServiceJourneyId(rawServiceJourneyId, vehicle.serviceJourney?.date ?? undefined)
    : undefined;
  const rawVehicleId =
    vehicle.vehicleId ??
    rawServiceJourneyId ??
    `${vehicle.location.latitude}:${vehicle.location.longitude}`;
  return {
    id: withEnturPrefix(`vehicle:${rawVehicleId}`),
    provider: "entur",
    tripId,
    routeId,
    lat: vehicle.location.latitude,
    lng: vehicle.location.longitude,
    bearing: vehicle.bearing ?? undefined,
    speed: vehicle.speed ?? undefined,
    label: vehicle.vehicleId ?? undefined,
    currentStopId: vehicle.monitoredCall?.stopPointRef
      ? withEnturPrefix(vehicle.monitoredCall.stopPointRef)
      : undefined,
    currentStopSequence: vehicle.monitoredCall?.order ?? undefined,
    updatedAt: vehicle.lastUpdated,
  };
}

function normalizeJourneyStop(call: EnturEstimatedCall): VehicleJourneyStop | null {
  const stopPlace = call.quay?.stopPlace ?? null;
  const latitude = stopPlace?.latitude ?? call.quay?.latitude;
  const longitude = stopPlace?.longitude ?? call.quay?.longitude;
  const name = stopPlace?.name ?? call.quay?.name ?? null;
  const stopId = stopPlace?.id ?? call.quay?.id;
  if (
    !stopId ||
    !isTruthyString(name) ||
    typeof latitude !== "number" ||
    typeof longitude !== "number"
  ) {
    return null;
  }
  return {
    stopId: withEnturPrefix(stopId),
    name,
    lat: latitude,
    lng: longitude,
    platform: call.quay?.publicCode ?? undefined,
    scheduledArrival: call.aimedArrivalTime ?? undefined,
    scheduledDeparture: call.aimedDepartureTime ?? undefined,
    expectedArrival: call.expectedArrivalTime ?? undefined,
    expectedDeparture: call.expectedDepartureTime ?? undefined,
    delaySeconds:
      calculateDelaySeconds(call.aimedDepartureTime, call.expectedDepartureTime) ??
      calculateDelaySeconds(call.aimedArrivalTime, call.expectedArrivalTime),
    canceled: call.cancellation ?? false,
    departed:
      isTruthyString(call.actualDepartureTime) ||
      (isTruthyString(call.expectedDepartureTime) &&
        new Date(call.expectedDepartureTime).getTime() < Date.now()),
  };
}

function chooseBestJourneyPattern(
  patterns: EnturJourneyPattern[] | null | undefined,
  hintStopId?: string,
): EnturJourneyPattern | null {
  const rawHint = hintStopId ? stripKnownPrefix(hintStopId) : undefined;
  let best: EnturJourneyPattern | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const pattern of patterns ?? []) {
    const quays = pattern.quays ?? [];
    let score = quays.length;
    if (rawHint) {
      const hasHint = quays.some((quay) => quay.id === rawHint || quay.stopPlace?.id === rawHint);
      if (hasHint) score += 10_000;
    }
    const hasGeometry = decodePoints(pattern.pointsOnLink?.points).length >= 2;
    if (hasGeometry) score += 100;
    if (score > bestScore) {
      best = pattern;
      bestScore = score;
    }
  }
  return best;
}

async function fetchGraphQl<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ET-Client-Name": clientName,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Entur GraphQL error ${response.status}`);
  }
  const json = (await response.json()) as GraphQlResponse<T>;
  if (json.errors?.length) {
    const message = json.errors
      .map((error) => error.message)
      .filter(isTruthyString)
      .join("; ");
    throw new Error(message || "Entur GraphQL error");
  }
  if (json.data == null) {
    throw new Error("Entur GraphQL returned no data");
  }
  return json.data;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "ET-Client-Name": clientName,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Entur HTTP error ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function fetchGeocoderAutocomplete(text: string, size: number): Promise<EnturFeature[]> {
  const url = new URL(`${geocoderEndpoint}/autocomplete`);
  url.searchParams.set("text", text);
  url.searchParams.set("size", String(size));
  if (boundaryCountry) {
    url.searchParams.set("boundary.country", boundaryCountry);
  }
  url.searchParams.set("multiModal", multiModal);
  const data = await fetchJson<EnturFeatureCollection>(url.toString());
  return data.features ?? [];
}

async function fetchNsrRecord<T>(path: string): Promise<T> {
  return fetchJson<T>(`${nsrEndpoint}${path}`);
}

async function fetchStopBoard(
  rawId: string,
  boardMode: Exclude<BoardMode, "both">,
  timeRangeSeconds: number,
  numberOfDepartures: number,
  startTime?: string,
): Promise<{ situations: EnturSituation[]; estimatedCalls: EnturEstimatedCall[] }> {
  if (isQuayId(rawId)) {
    const data = await fetchGraphQl<{
      quay?: {
        situations?: EnturSituation[] | null;
        estimatedCalls?: EnturEstimatedCall[] | null;
      } | null;
    }>(journeyPlannerEndpoint, QUAY_BOARD_QUERY, {
      id: rawId,
      timeRange: timeRangeSeconds,
      numberOfDepartures,
      arrivalDeparture: boardMode,
      startTime,
    });
    return {
      situations: data.quay?.situations ?? [],
      estimatedCalls: data.quay?.estimatedCalls ?? [],
    };
  }
  const data = await fetchGraphQl<{
    stopPlace?: {
      situations?: EnturSituation[] | null;
      estimatedCalls?: EnturEstimatedCall[] | null;
    } | null;
  }>(journeyPlannerEndpoint, STOP_PLACE_BOARD_QUERY, {
    id: rawId,
    timeRange: timeRangeSeconds,
    numberOfDepartures,
    arrivalDeparture: boardMode,
    startTime,
  });
  return {
    situations: data.stopPlace?.situations ?? [],
    estimatedCalls: data.stopPlace?.estimatedCalls ?? [],
  };
}

async function fetchServiceJourneyForDates(
  serviceJourneyId: string,
  preferredDate?: string,
): Promise<{ journey: EnturServiceJourney; date: string } | null> {
  for (const date of dateCandidates(preferredDate)) {
    const data = await fetchGraphQl<{ serviceJourney?: EnturServiceJourney | null }>(
      journeyPlannerEndpoint,
      SERVICE_JOURNEY_QUERY,
      { id: serviceJourneyId, date },
    );
    if (!data.serviceJourney) continue;
    if ((data.serviceJourney.estimatedCalls ?? []).length > 0) {
      return { journey: data.serviceJourney, date };
    }
    if (preferredDate === date) {
      return { journey: data.serviceJourney, date };
    }
  }
  return null;
}

function nsrArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value.filter((item): item is T => item != null);
  return value != null ? [value] : [];
}

function nsrRefValue(value: NsrRef | null | undefined): string | undefined {
  if (isTruthyString(value?.ref)) return value.ref;
  if (isTruthyString(value?.value?.ref)) return value.value.ref;
  return undefined;
}

function nsrPrivateCodeValue(value: NsrPrivateCode | null | undefined): string | undefined {
  return isTruthyString(value?.value) ? value.value : undefined;
}

function nsrPointLocation(point: NsrPoint | null | undefined): { lat: number; lng: number } | null {
  const latitude = point?.location?.latitude;
  const longitude = point?.location?.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  return { lat: latitude, lng: longitude };
}

function ensureClosedRing(coordinates: [number, number][]): [number, number][] {
  if (coordinates.length === 0) return coordinates;
  const [firstLng, firstLat] = coordinates[0];
  const [lastLng, lastLat] = coordinates[coordinates.length - 1];
  if (firstLng === lastLng && firstLat === lastLat) return coordinates;
  return [...coordinates, [firstLng, firstLat]];
}

function nsrCoordinatesFromPosList(value: number[] | null | undefined): [number, number][] | null {
  if (!Array.isArray(value) || value.length < 6 || value.length % 2 !== 0) return null;
  const coordinates: [number, number][] = [];
  for (let index = 0; index < value.length; index += 2) {
    const lat = value[index];
    const lng = value[index + 1];
    if (
      typeof lat !== "number" ||
      !Number.isFinite(lat) ||
      typeof lng !== "number" ||
      !Number.isFinite(lng)
    ) {
      return null;
    }
    coordinates.push([lng, lat]);
  }
  return ensureClosedRing(coordinates);
}

function nsrRingCoordinates(ring: NsrRingProperty | null | undefined): [number, number][] | null {
  return nsrCoordinatesFromPosList(ring?.abstractRing?.value?.posList?.value);
}

function nsrPolygonGeometry(
  polygon: NsrPolygonShape | null | undefined,
): TransitGeoJsonPolygon | null {
  const exterior = nsrRingCoordinates(polygon?.exterior);
  if (!exterior) return null;
  const interior = nsrArray(polygon?.interior)
    .map((ring) => nsrRingCoordinates(ring))
    .filter((ring): ring is [number, number][] => ring !== null);
  return {
    type: "Polygon",
    coordinates: [exterior, ...interior],
  };
}

function nsrSurfaceGeometry(
  surface: NsrAbstractSurfaceShape | null | undefined,
): TransitGeoJsonPolygon | TransitGeoJsonMultiPolygon | null {
  const value = surface?.value;
  if (!value) return null;
  if (surface.type === "Polygon" || "exterior" in value) {
    return nsrPolygonGeometry(value as NsrPolygonShape);
  }
  if (surface.type === "MultiSurface" || "surfaceMember" in value || "surfaceMembers" in value) {
    return nsrMultiSurfaceGeometry(value as NsrMultiSurfaceShape);
  }
  return null;
}

function nsrMultiSurfaceGeometry(
  multiSurface: NsrMultiSurfaceShape | null | undefined,
): TransitGeoJsonMultiPolygon | null {
  const members = [
    ...nsrArray(multiSurface?.surfaceMember)
      .map((member) => member?.abstractSurface ?? null)
      .filter((surface): surface is NsrAbstractSurfaceShape => surface !== null),
    ...nsrArray(multiSurface?.surfaceMembers?.abstractSurface).filter(
      (surface): surface is NsrAbstractSurfaceShape => surface !== null,
    ),
  ];
  const polygons = members.flatMap((surface) => {
    const geometry = nsrSurfaceGeometry(surface);
    if (!geometry) return [];
    return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  });
  return polygons.length > 0
    ? {
        type: "MultiPolygon",
        coordinates: polygons,
      }
    : null;
}

function nsrRecordGeometry(
  polygon: NsrPolygonShape | null | undefined,
  multiSurface: NsrMultiSurfaceShape | null | undefined,
): TransitGeoJsonPolygon | TransitGeoJsonMultiPolygon | null {
  return nsrPolygonGeometry(polygon) ?? nsrMultiSurfaceGeometry(multiSurface);
}

function humanizeNsrEnum(value: string | null | undefined): string | undefined {
  if (!isTruthyString(value)) return undefined;
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTransportModes(modes: TransportMode[]): string {
  return modes.map((mode) => humanizeNsrEnum(mode) ?? mode).join(", ");
}

function collectNsrLimitations(
  assessment: NsrAccessibilityAssessment | null | undefined,
): NsrAccessibilityLimitation[] {
  return nsrArray(assessment?.limitations?.accessibilityLimitation);
}

function collectNsrEquipmentItems(
  placeEquipments:
    | { installedEquipmentRefOrInstalledEquipment?: Array<NsrPlaceEquipmentItem | null> | null }
    | null
    | undefined,
): NsrPlaceEquipmentItem[] {
  return (placeEquipments?.installedEquipmentRefOrInstalledEquipment ?? []).filter(
    (item): item is NsrPlaceEquipmentItem => item != null,
  );
}

function collectNsrQuays(stopPlace: NsrStopPlaceRecord | null | undefined): NsrQuayRecord[] {
  return (stopPlace?.quays?.quayRefOrQuay ?? []).filter(
    (quay): quay is NsrQuayRecord => quay != null,
  );
}

function collectNsrTariffZoneRefs(stopPlace: NsrStopPlaceRecord | null | undefined): string[] {
  const refs = (stopPlace?.tariffZones?.tariffZoneRef ?? [])
    .map((ref) => nsrRefValue(ref))
    .filter((ref): ref is string => isTruthyString(ref));
  return Array.from(new Set(refs));
}

function transportModesFromStopPlace(stopPlace: NsrStopPlaceRecord): TransportMode[] {
  if (isTruthyString(stopPlace.transportMode)) {
    return [toTransportMode(stopPlace.transportMode)];
  }
  const modes = collectNsrQuays(stopPlace)
    .map((quay) =>
      isTruthyString(quay.transportMode) ? toTransportMode(quay.transportMode) : null,
    )
    .filter((mode): mode is TransportMode => mode !== null);
  return modes.length > 0 ? Array.from(new Set(modes)) : ["bus"];
}

function firstKnownStopLocation(
  stopPlace: NsrStopPlaceRecord | null | undefined,
): { lat: number; lng: number } | null {
  const centroid = nsrPointLocation(stopPlace?.centroid);
  if (centroid) return centroid;
  for (const quay of collectNsrQuays(stopPlace)) {
    const quayPoint = nsrPointLocation(quay.centroid);
    if (quayPoint) return quayPoint;
  }
  return null;
}

function normalizeNsrStopAreaSummary(
  stopPlace: NsrStopPlaceRecord | null | undefined,
  level: TransitStopAreaSummary["level"],
  options?: {
    modes?: TransportMode[];
    parentStopId?: string;
  },
): TransitStopAreaSummary | null {
  if (!isTruthyString(stopPlace?.id) || !isTruthyString(nsrTextValue(stopPlace?.name))) return null;
  const location = firstKnownStopLocation(stopPlace);
  if (!location) return null;
  const modes = options?.modes?.length ? options.modes : transportModesFromStopPlace(stopPlace);
  return {
    id: withEnturPrefix(stopPlace.id),
    name: nsrTextValue(stopPlace.name) as string,
    lat: location.lat,
    lng: location.lng,
    modes,
    level,
    stopType: stopPlace.stopPlaceType ?? undefined,
    weighting: stopPlace.weighting ?? undefined,
    parentStopId: options?.parentStopId,
  };
}

function normalizePlatformSummary(platform: TransitPlatformDetail): TransitStopAreaSummary {
  return {
    id: platform.id,
    name: platform.publicCode ? `Platform ${platform.publicCode}` : platform.name,
    lat: platform.lat,
    lng: platform.lng,
    modes: platform.modes,
    level: "platform",
    parentStopId: platform.parentStopId,
  };
}

function mergeAccessibilityItems(items: TransitAccessibilityItem[]): TransitAccessibilityItem[] {
  const merged = new Map<string, TransitAccessibilityItem>();
  for (const item of items) {
    const existing = merged.get(item.category);
    if (!existing) {
      merged.set(item.category, item);
      continue;
    }
    if (item.available && !existing.available) {
      merged.set(item.category, item);
    }
  }
  return Array.from(merged.values());
}

function mapNsrAccessibility(
  sourceId: string,
  limitations: NsrAccessibilityLimitation[],
): TransitAccessibilityItem[] {
  const definitions: Array<{
    key: keyof NsrAccessibilityLimitation;
    category: TransitAccessibilityItem["category"];
    label: string;
  }> = [
    { key: "stepFreeAccess", category: "step_free", label: "Step-free access" },
    { key: "wheelchairAccess", category: "wheelchair", label: "Wheelchair access" },
    { key: "liftFreeAccess", category: "elevator", label: "Elevator access" },
    { key: "escalatorFreeAccess", category: "escalator", label: "Escalator access" },
    { key: "visualSignsAvailable", category: "visual", label: "Visual signage" },
    { key: "audibleSignalsAvailable", category: "audible", label: "Audible signals" },
  ];
  return definitions
    .map((definition) => {
      const values = limitations
        .map((item) => item[definition.key])
        .filter((value): value is string => isTruthyString(value));
      if (values.some((value) => value === "TRUE")) {
        return {
          id: `${sourceId}:${definition.category}`,
          category: definition.category,
          label: definition.label,
          available: true,
        } satisfies TransitAccessibilityItem;
      }
      if (values.some((value) => value === "FALSE")) {
        return {
          id: `${sourceId}:${definition.category}`,
          category: definition.category,
          label: definition.label,
          available: false,
        } satisfies TransitAccessibilityItem;
      }
      return null;
    })
    .filter((item): item is TransitAccessibilityItem => item !== null);
}

function amenityFromEquipment(
  sourceId: string,
  item: NsrPlaceEquipmentItem,
): TransitAmenityItem | null {
  if (!isTruthyString(item.type)) return null;
  const normalized = item.type.toLowerCase();
  if (normalized === "waitingroomequipment") {
    return {
      id: `${sourceId}:waiting-room`,
      category: "waiting_room",
      label: "Waiting room",
      count:
        typeof item.value?.seats === "number" && Number.isFinite(item.value.seats)
          ? item.value.seats
          : undefined,
    };
  }
  if (normalized === "ticketingequipment") {
    return {
      id: `${sourceId}:ticketing`,
      category: "ticketing",
      label: "Ticketing",
      count:
        typeof item.value?.numberOfMachines === "number" &&
        Number.isFinite(item.value.numberOfMachines)
          ? item.value.numberOfMachines
          : undefined,
    };
  }
  if (normalized === "sanitaryequipment") {
    return {
      id: `${sourceId}:toilets`,
      category: "toilets",
      label: "Toilets",
      count:
        typeof item.value?.numberOfToilets === "number" &&
        Number.isFinite(item.value.numberOfToilets)
          ? item.value.numberOfToilets
          : undefined,
    };
  }
  if (normalized.includes("bicycle") || normalized.includes("cycle")) {
    return {
      id: `${sourceId}:bike-storage:${item.type}`,
      category: "bike_storage",
      label: "Bike storage",
    };
  }
  return {
    id: `${sourceId}:equipment:${item.type}`,
    category: "other",
    label: item.type.replace(/([a-z])([A-Z])/g, "$1 $2"),
  };
}

function mergeAmenityItems(items: TransitAmenityItem[]): TransitAmenityItem[] {
  const merged = new Map<string, TransitAmenityItem>();
  for (const item of items) {
    const key = `${item.category}:${item.label}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      continue;
    }
    merged.set(key, {
      ...existing,
      count:
        typeof existing.count === "number" || typeof item.count === "number"
          ? (existing.count ?? 0) + (item.count ?? 0)
          : undefined,
    });
  }
  return Array.from(merged.values());
}

function mapNsrAmenities(
  sourceId: string,
  equipmentItems: NsrPlaceEquipmentItem[],
): TransitAmenityItem[] {
  return mergeAmenityItems(
    equipmentItems
      .map((item) => amenityFromEquipment(sourceId, item))
      .filter((item): item is TransitAmenityItem => item !== null),
  );
}

function normalizeNsrPlatformDetail(
  quay: NsrQuayRecord,
  parentStop: NsrStopPlaceRecord,
  modes: TransportMode[],
): TransitPlatformDetail | null {
  if (!isTruthyString(quay.id)) return null;
  const quayLocation = nsrPointLocation(quay.centroid) ?? firstKnownStopLocation(parentStop);
  if (!quayLocation || !isTruthyString(parentStop.id)) return null;
  const accessibilityLabels = mapNsrAccessibility(
    withEnturPrefix(quay.id),
    collectNsrLimitations(quay.accessibilityAssessment),
  )
    .filter((item) => item.available)
    .map((item) => item.label);
  const amenityLabels = mapNsrAmenities(
    withEnturPrefix(quay.id),
    collectNsrEquipmentItems(quay.placeEquipments),
  ).map((item) => item.label);
  const boardingPositions = nsrArray(quay.boardingPositions?.boardingPositionRefOrBoardingPosition)
    .filter((position): position is NsrBoardingPosition => position != null)
    .map(
      (position) =>
        position.publicCode ?? nsrPrivateCodeValue(position.privateCode) ?? position.id ?? "",
    )
    .filter((value) => value.length > 0);
  return {
    id: withEnturPrefix(quay.id),
    name: nsrTextValue(parentStop.name) ?? quay.publicCode ?? quay.id,
    lat: quayLocation.lat,
    lng: quayLocation.lng,
    modes,
    parentStopId: withEnturPrefix(parentStop.id),
    publicCode: quay.publicCode ?? undefined,
    privateCode: nsrPrivateCodeValue(quay.privateCode),
    bearing: typeof quay.compassBearing === "number" ? quay.compassBearing : undefined,
    boardingPositions: boardingPositions.length > 0 ? boardingPositions : undefined,
    accessibilityLabels: accessibilityLabels.length > 0 ? accessibilityLabels : undefined,
    amenityLabels: amenityLabels.length > 0 ? amenityLabels : undefined,
  };
}

function mergePlatformDetails(items: TransitPlatformDetail[]): TransitPlatformDetail[] {
  const merged = new Map<string, TransitPlatformDetail>();
  for (const item of items) {
    if (!merged.has(item.id)) {
      merged.set(item.id, item);
      continue;
    }
    const existing = merged.get(item.id) as TransitPlatformDetail;
    merged.set(item.id, {
      ...existing,
      publicCode: existing.publicCode ?? item.publicCode,
      privateCode: existing.privateCode ?? item.privateCode,
      bearing: existing.bearing ?? item.bearing,
      boardingPositions:
        existing.boardingPositions?.length || item.boardingPositions?.length
          ? Array.from(
              new Set([...(existing.boardingPositions ?? []), ...(item.boardingPositions ?? [])]),
            )
          : undefined,
      accessibilityLabels:
        existing.accessibilityLabels?.length || item.accessibilityLabels?.length
          ? Array.from(
              new Set([
                ...(existing.accessibilityLabels ?? []),
                ...(item.accessibilityLabels ?? []),
              ]),
            )
          : undefined,
      amenityLabels:
        existing.amenityLabels?.length || item.amenityLabels?.length
          ? Array.from(new Set([...(existing.amenityLabels ?? []), ...(item.amenityLabels ?? [])]))
          : undefined,
    });
  }
  return Array.from(merged.values());
}

function parkingKindFromVehicleTypes(
  vehicleTypes: string[],
  parkingType?: string | null,
): TransitStopParking["kind"] {
  const normalizedParkingType = parkingType?.toUpperCase();
  if (
    normalizedParkingType === "PARK_AND_RIDE" ||
    normalizedParkingType === "TRAIN_STATION_PARKING"
  ) {
    return "park_and_ride";
  }

  const normalized = new Set(vehicleTypes.map((value) => value.toUpperCase()));
  if (normalized.has("PEDAL_CYCLE") || normalized.has("BICYCLE")) return "bike_parking";
  if (
    normalized.has("CAR") ||
    normalized.has("PASSENGER_CAR") ||
    normalized.has("AUTOMOBILE") ||
    normalized.has("MOTOR_VEHICLE")
  ) {
    return "park_and_ride";
  }
  return normalized.size > 0 ? "parking" : "other";
}

function mapNsrParking(parking: NsrParking): TransitStopParking | null {
  if (!isTruthyString(parking.id)) return null;
  const location = nsrPointLocation(parking.centroid);
  if (!location) return null;
  const vehicleTypes = parking.parkingVehicleTypes ?? [];
  return {
    id: parking.id,
    name: nsrTextValue(parking.name) ?? "Parking",
    lat: location.lat,
    lng: location.lng,
    kind: parkingKindFromVehicleTypes(vehicleTypes, parking.parkingType),
    vehicleTypes,
    capacity:
      typeof parking.totalCapacity === "number"
        ? parking.totalCapacity
        : typeof parking.principalCapacity === "number"
          ? parking.principalCapacity
          : undefined,
    hasRealtimeData: parking.realTimeOccupancyAvailable ?? undefined,
  };
}

function mapNsrFareZone(
  fareZone: NsrFareZoneRecord,
  fallbackId?: string,
): TransitFareZoneSummary | null {
  const id = fareZone.id ?? fallbackId;
  if (!isTruthyString(id)) return null;
  const authorityId = nsrRefValue(fareZone.transportOrganisationRef);
  return {
    id,
    name: nsrTextValue(fareZone.name) ?? id,
    authorityId,
    authorityName: authorityId?.split(":").at(-1),
    privateCode: nsrPrivateCodeValue(fareZone.privateCode),
    hasGeometry: Boolean(fareZone.polygon ?? fareZone.multiSurface),
    isDeprecatedTariffZone: id.includes(":TariffZone:"),
  };
}

function mapNsrTopographicPlace(
  topographicPlace: NsrTopographicPlaceRecord,
): TransitTopographicPlaceSummary | null {
  if (!isTruthyString(topographicPlace.id)) return null;
  const name =
    nsrTextValue(topographicPlace.name) ??
    nsrTextValue(topographicPlace.descriptor?.name) ??
    topographicPlace.id;
  return {
    id: topographicPlace.id,
    name,
    placeType: topographicPlace.topographicPlaceType ?? undefined,
    parentTopographicPlaceId: nsrRefValue(topographicPlace.parentTopographicPlaceRef),
  };
}

function buildStopInfrastructureFacts(input: {
  requestedStop: TransitStopAreaSummary;
  canonicalStop: TransitStopAreaSummary;
  parentStop?: TransitStopAreaSummary;
  childStops: TransitStopAreaSummary[];
  platforms: TransitPlatformDetail[];
  fareZones: TransitFareZoneSummary[];
  parking: TransitStopParking[];
  topographicPlace?: TransitTopographicPlaceSummary;
}): TransitStopInfrastructureFact[] {
  const facts: TransitStopInfrastructureFact[] = [];
  if (input.canonicalStop.stopType) {
    facts.push({
      label: "Stop type",
      value: humanizeNsrEnum(input.canonicalStop.stopType) ?? input.canonicalStop.stopType,
    });
  }
  if (input.canonicalStop.weighting) {
    facts.push({
      label: "Weighting",
      value: humanizeNsrEnum(input.canonicalStop.weighting) ?? input.canonicalStop.weighting,
    });
  }
  if (input.canonicalStop.modes.length > 0) {
    facts.push({
      label: "Transport modes",
      value: formatTransportModes(input.canonicalStop.modes),
    });
  }
  if (input.parentStop) {
    facts.push({ label: "Parent station", value: input.parentStop.name });
  }
  if (input.topographicPlace) {
    facts.push({
      label: "Topographic place",
      value: input.topographicPlace.name,
    });
  }
  if (input.childStops.length > 0) {
    facts.push({ label: "Child stop areas", value: String(input.childStops.length) });
  }
  if (input.platforms.length > 0) {
    facts.push({ label: "Platforms", value: String(input.platforms.length) });
  }
  if (input.fareZones.length > 0) {
    facts.push({ label: "Fare zones", value: String(input.fareZones.length) });
  }
  if (input.parking.length > 0) {
    facts.push({ label: "Attached parking", value: String(input.parking.length) });
  }
  if (input.requestedStop.level === "platform") {
    facts.push({ label: "Focused object", value: "Platform" });
  }
  return facts;
}

function deriveStationIntelligence(input: {
  requestedStop: TransitStopAreaSummary;
  canonicalStop: TransitStopAreaSummary;
  parentStop?: TransitStopAreaSummary;
  siblingStops: TransitStopAreaSummary[];
  childStops: TransitStopAreaSummary[];
  platforms: TransitPlatformDetail[];
  parking: TransitStopParking[];
}): TransitStationIntelligence {
  const modeSet = new Set<TransportMode>([
    ...input.requestedStop.modes,
    ...input.canonicalStop.modes,
    ...(input.parentStop?.modes ?? []),
    ...input.siblingStops.flatMap((stop) => stop.modes),
    ...input.childStops.flatMap((stop) => stop.modes),
    ...input.platforms.flatMap((platform) => platform.modes),
  ]);
  const modeCount = modeSet.size;
  const connectedStopAreaCount =
    input.childStops.length > 0
      ? input.childStops.length + 1
      : input.siblingStops.length > 0
        ? input.siblingStops.length + 1
        : 1;
  const platformCount = input.platforms.length;

  let complexity: TransitInterchangeComplexity = "simple_stop";
  if (
    platformCount >= 8 ||
    connectedStopAreaCount >= 4 ||
    (modeCount >= 3 && platformCount >= 5) ||
    (modeCount >= 4 && connectedStopAreaCount >= 3)
  ) {
    complexity = "major_interchange";
  } else if (
    platformCount >= 4 ||
    connectedStopAreaCount >= 3 ||
    (modeCount >= 3 && platformCount >= 3) ||
    (modeCount >= 2 && connectedStopAreaCount >= 2 && platformCount >= 2)
  ) {
    complexity = "regional_hub";
  } else if (
    modeCount >= 2 ||
    connectedStopAreaCount >= 2 ||
    platformCount >= 2 ||
    input.parking.length > 0
  ) {
    complexity = "interchange";
  }

  return {
    complexity,
    modeCount,
    hasParking: input.parking.length > 0,
    hasRealtimeParking: input.parking.some(
      (parking) => parking.hasRealtimeData && typeof parking.freeSpaces === "number",
    ),
  };
}

async function fetchStopPlaceParkings(rawStopId: string): Promise<NsrParking[]> {
  try {
    return await fetchNsrRecord<NsrParking[]>(
      `/stop-places/${encodeURIComponent(rawStopId)}/parkings`,
    );
  } catch {
    return [];
  }
}

async function fetchFareZoneRecord(rawFareZoneId: string): Promise<NsrFareZoneRecord | null> {
  const encoded = encodeURIComponent(rawFareZoneId);
  try {
    if (rawFareZoneId.includes(":FareZone:")) {
      return await fetchNsrRecord<NsrFareZoneRecord>(`/fare-zones/${encoded}`);
    }
    if (rawFareZoneId.includes(":TariffZone:")) {
      return await fetchNsrRecord<NsrFareZoneRecord>(`/tariff-zones/${encoded}`);
    }
  } catch {
    return null;
  }
  return null;
}

function facilitiesFromStopInfrastructure(
  infrastructure: Pick<
    TransitStopInfrastructure,
    "stopId" | "accessibility" | "amenities" | "parking"
  >,
): Facility[] {
  const stopId = infrastructure.stopId;
  const facilities: Facility[] = [];
  for (const item of infrastructure.accessibility) {
    if (!item.available) continue;
    const type =
      item.category === "elevator"
        ? "elevator"
        : item.category === "escalator"
          ? "escalator"
          : item.category === "step_free"
            ? "other"
            : null;
    if (type === null) continue;
    facilities.push({
      id: `${stopId}:accessibility:${item.category}`,
      stopId,
      name: item.label,
      type,
      isAccessible: item.available,
      provider: "entur",
    });
  }
  for (const item of infrastructure.amenities) {
    const type =
      item.category === "bike_storage"
        ? "bike_storage"
        : item.category === "parking"
          ? "parking"
          : "other";
    facilities.push({
      id: `${stopId}:amenity:${item.category}:${item.label}`,
      stopId,
      name: item.label,
      type,
      isAccessible: true,
      provider: "entur",
    });
  }
  for (const item of infrastructure.parking) {
    facilities.push({
      id: item.id,
      stopId,
      name: item.name,
      type: item.kind === "bike_parking" ? "bike_storage" : "parking",
      isAccessible: true,
      provider: "entur",
    });
  }
  return dedupeById(facilities);
}

function facilitiesFromParkings(stopId: string, parkings: NsrParking[]): Facility[] {
  return parkings
    .filter((parking) => isTruthyString(parking.id))
    .map((parking) => {
      const vehicleTypes = new Set(
        (parking.parkingVehicleTypes ?? []).map((value) => value.toUpperCase()),
      );
      const type =
        vehicleTypes.has("PEDAL_CYCLE") || vehicleTypes.has("BICYCLE") ? "bike_storage" : "parking";
      return {
        id: parking.id as string,
        stopId,
        name: nsrTextValue(parking.name) ?? (type === "bike_storage" ? "Bike parking" : "Parking"),
        type,
        isAccessible: true,
        provider: "entur",
      } satisfies Facility;
    });
}

function sortStopAreas(items: TransitStopAreaSummary[]): TransitStopAreaSummary[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function sortPlatforms(items: TransitPlatformDetail[]): TransitPlatformDetail[] {
  return [...items].sort(
    (a, b) =>
      a.parentStopId.localeCompare(b.parentStopId) ||
      (a.publicCode ?? a.privateCode ?? a.name).localeCompare(
        b.publicCode ?? b.privateCode ?? b.name,
        undefined,
        { numeric: true },
      ),
  );
}

function uniqueStopAreas(items: TransitStopAreaSummary[]): TransitStopAreaSummary[] {
  return sortStopAreas(dedupeById(items));
}

function uniqueParking(items: TransitStopParking[]): TransitStopParking[] {
  return dedupeById(items).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function uniqueFareZones(items: TransitFareZoneSummary[]): TransitFareZoneSummary[] {
  return dedupeById(items).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function uniqueFareZoneGeometries(
  items: NonNullable<TransitStopInfrastructureGeometry["fareZones"]>,
): NonNullable<TransitStopInfrastructureGeometry["fareZones"]> {
  const unique = new Map<
    string,
    NonNullable<TransitStopInfrastructureGeometry["fareZones"]>[number]
  >();
  for (const item of items) {
    if (!unique.has(item.fareZoneId)) unique.set(item.fareZoneId, item);
  }
  return Array.from(unique.values()).sort((a, b) => a.fareZoneId.localeCompare(b.fareZoneId));
}

function buildStopInfrastructureGeometry(input: {
  stopArea?: TransitGeoJsonPolygon | TransitGeoJsonMultiPolygon | null;
  fareZoneGeometries?: NonNullable<TransitStopInfrastructureGeometry["fareZones"]>;
}): TransitStopInfrastructureGeometry | undefined {
  const stopArea = input.stopArea ?? undefined;
  const fareZones = input.fareZoneGeometries?.length ? input.fareZoneGeometries : undefined;
  if (!stopArea && !fareZones) return undefined;
  return {
    stopArea,
    fareZones,
  };
}

function collectPlatformsForStopPlaces(stopPlaces: NsrStopPlaceRecord[]): TransitPlatformDetail[] {
  const platforms = stopPlaces.flatMap((stopPlace) => {
    const modes = transportModesFromStopPlace(stopPlace);
    return collectNsrQuays(stopPlace)
      .map((quay) => normalizeNsrPlatformDetail(quay, stopPlace, modes))
      .filter((platform): platform is TransitPlatformDetail => platform !== null);
  });
  return sortPlatforms(mergePlatformDetails(platforms));
}

async function resolveParkingForStopPlaces(
  stopPlaces: NsrStopPlaceRecord[],
): Promise<TransitStopParking[]> {
  const results = await Promise.all(
    stopPlaces
      .map((stopPlace) => stopPlace.id)
      .filter((stopId): stopId is string => isTruthyString(stopId))
      .map((stopId) => fetchStopPlaceParkings(stopId)),
  );
  return uniqueParking(
    results
      .flat()
      .map((parking) => mapNsrParking(parking))
      .filter((parking): parking is TransitStopParking => parking !== null),
  );
}

async function resolveFareZonesForStopPlaces(stopPlaces: NsrStopPlaceRecord[]): Promise<{
  summaries: TransitFareZoneSummary[];
  geometries: NonNullable<TransitStopInfrastructureGeometry["fareZones"]>;
}> {
  const refs = Array.from(
    new Set(stopPlaces.flatMap((stopPlace) => collectNsrTariffZoneRefs(stopPlace))),
  );
  if (refs.length === 0) return { summaries: [], geometries: [] };
  const results = await Promise.all(refs.map((ref) => fetchFareZoneRecord(ref)));
  const summaries = uniqueFareZones(
    results
      .map((record, index) =>
        record
          ? mapNsrFareZone(record, refs[index])
          : mapNsrFareZone({ id: refs[index] }, refs[index]),
      )
      .filter((fareZone): fareZone is TransitFareZoneSummary => fareZone !== null),
  );
  const geometries = uniqueFareZoneGeometries(
    results
      .map((record, index) => {
        const geometry = record ? nsrRecordGeometry(record.polygon, record.multiSurface) : null;
        if (!geometry) return null;
        return {
          fareZoneId: record?.id ?? refs[index],
          geometry,
        };
      })
      .filter(
        (item): item is NonNullable<TransitStopInfrastructureGeometry["fareZones"]>[number] =>
          item !== null,
      ),
  );
  return { summaries, geometries };
}

async function resolveTopographicPlaceSummary(
  stopPlace: NsrStopPlaceRecord | null | undefined,
): Promise<TransitTopographicPlaceSummary | undefined> {
  const rawId = nsrRefValue(stopPlace?.topographicPlaceRef);
  if (!rawId) return undefined;
  try {
    const record = await fetchNsrRecord<NsrTopographicPlaceRecord>(
      `/topographic-places/${encodeURIComponent(rawId)}`,
    );
    return mapNsrTopographicPlace(record) ?? undefined;
  } catch {
    return undefined;
  }
}

function mergeStopInfrastructureItems(stopPlaces: NsrStopPlaceRecord[]): {
  accessibility: TransitAccessibilityItem[];
  amenities: TransitAmenityItem[];
} {
  const accessibility = mergeAccessibilityItems(
    stopPlaces.flatMap((stopPlace) =>
      mapNsrAccessibility(
        withEnturPrefix(stopPlace.id ?? "unknown"),
        collectNsrLimitations(stopPlace.accessibilityAssessment),
      ),
    ),
  );
  const amenities = mergeAmenityItems(
    stopPlaces.flatMap((stopPlace) =>
      mapNsrAmenities(
        withEnturPrefix(stopPlace.id ?? "unknown"),
        collectNsrEquipmentItems(stopPlace.placeEquipments),
      ),
    ),
  );
  return { accessibility, amenities };
}

function buildSiblingStops(
  children: NsrStopPlaceRecord[],
  currentStopId: string,
): TransitStopAreaSummary[] {
  return uniqueStopAreas(
    children
      .filter((child) => child.id !== currentStopId)
      .map((child) =>
        normalizeNsrStopAreaSummary(child, "child_stop", {
          parentStopId: nsrRefValue(child.parentSiteRef)
            ? withEnturPrefix(nsrRefValue(child.parentSiteRef) as string)
            : undefined,
        }),
      )
      .filter((child): child is TransitStopAreaSummary => child !== null),
  );
}

function buildChildStopAreas(
  parentStopId: string,
  children: NsrStopPlaceRecord[],
): TransitStopAreaSummary[] {
  return uniqueStopAreas(
    children
      .map((child) =>
        normalizeNsrStopAreaSummary(child, "child_stop", {
          parentStopId: withEnturPrefix(parentStopId),
        }),
      )
      .filter((child): child is TransitStopAreaSummary => child !== null),
  );
}

export async function isEnturTransitAvailable(): Promise<boolean> {
  try {
    const data = await fetchGraphQl<{ stopPlace?: { id: string } | null }>(
      journeyPlannerEndpoint,
      HEALTHCHECK_QUERY,
      { id: "NSR:StopPlace:337" },
    );
    return Boolean(data.stopPlace?.id);
  } catch {
    return false;
  }
}

export async function searchByName(query: string, limit = 10): Promise<TransitStop[]> {
  try {
    const features = await fetchGeocoderAutocomplete(query, Math.min(limit, 20));
    return features
      .map((feature) => featureToTransitStop(feature))
      .filter((stop): stop is TransitStop => stop !== null)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function getStopsNearby(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  try {
    const data = await fetchGraphQl<{
      nearest?: {
        edges?: Array<{
          node?: {
            place?: EnturStopPlaceSummary & { __typename?: string | null };
          } | null;
        } | null> | null;
      } | null;
    }>(journeyPlannerEndpoint, NEARBY_STOPS_QUERY, {
      latitude: lat,
      longitude: lng,
      maximumDistance: radiusMeters,
      maximumResults: 30,
    });
    return (data.nearest?.edges ?? [])
      .map((edge) => edge?.node?.place)
      .filter((place): place is EnturStopPlaceSummary & { __typename?: string | null } => {
        return place?.__typename === "StopPlace";
      })
      .map((place) => normalizeStopPlace(place))
      .filter((stop): stop is TransitStop => stop !== null);
  } catch {
    return [];
  }
}

export async function getStop(stopId: string): Promise<TransitStop | null> {
  const rawId = stripKnownPrefix(stopId);
  try {
    if (isQuayId(rawId)) {
      const data = await fetchGraphQl<{ quay?: EnturQuay | null }>(
        journeyPlannerEndpoint,
        QUAY_DETAIL_QUERY,
        { id: rawId },
      );
      return normalizeQuay(data.quay);
    }
    const data = await fetchGraphQl<{ stopPlace?: EnturStopPlace | null }>(
      journeyPlannerEndpoint,
      STOP_PLACE_DETAIL_QUERY,
      { id: rawId },
    );
    return normalizeStopPlace(data.stopPlace);
  } catch {
    return null;
  }
}

export async function getStopInfrastructure(
  stopId: string,
): Promise<TransitStopInfrastructure | null> {
  const rawId = stripKnownPrefix(stopId);
  if (!rawId.startsWith(NSR_PREFIX)) return null;

  try {
    if (isQuayId(rawId)) {
      const [quay, owningStop] = await Promise.all([
        fetchNsrRecord<NsrQuayRecord>(`/quays/${encodeURIComponent(rawId)}`),
        fetchNsrRecord<NsrStopPlaceRecord>(`/quays/${encodeURIComponent(rawId)}/stop-place`),
      ]);
      if (!isTruthyString(quay.id) || !isTruthyString(owningStop.id)) return null;

      const parentStationId = nsrRefValue(owningStop.parentSiteRef);
      const [parentStop, siblings] = parentStationId
        ? await Promise.all([
            fetchNsrRecord<NsrStopPlaceRecord>(
              `/stop-places/${encodeURIComponent(parentStationId)}`,
            ),
            fetchNsrRecord<NsrStopPlaceRecord[]>(
              `/stop-places/${encodeURIComponent(parentStationId)}/children`,
            ),
          ])
        : [null, [] as NsrStopPlaceRecord[]];

      const canonicalStop = normalizeNsrStopAreaSummary(owningStop, "child_stop", {
        parentStopId: parentStationId ? withEnturPrefix(parentStationId) : undefined,
      });
      if (!canonicalStop) return null;

      const parentStopSummary =
        parentStop && isTruthyString(parentStop.id)
          ? normalizeNsrStopAreaSummary(parentStop, "parent_stop", {
              modes: Array.from(
                new Set(
                  (siblings.length > 0 ? siblings : [owningStop]).flatMap((stop) =>
                    transportModesFromStopPlace(stop),
                  ),
                ),
              ),
            })
          : null;

      const requestedPlatform = normalizeNsrPlatformDetail(
        quay,
        owningStop,
        transportModesFromStopPlace(owningStop),
      );
      if (!requestedPlatform) return null;

      const platformScopeStops = parentStopSummary ? siblings : [owningStop];
      const platforms = mergePlatformDetails([
        ...collectPlatformsForStopPlaces(platformScopeStops),
        requestedPlatform,
      ]);
      const requestedStop = normalizePlatformSummary(requestedPlatform);
      const stopItems = mergeStopInfrastructureItems([owningStop]);
      const accessibility = mergeAccessibilityItems([
        ...stopItems.accessibility,
        ...mapNsrAccessibility(
          requestedPlatform.id,
          collectNsrLimitations(quay.accessibilityAssessment),
        ),
      ]);
      const amenities = mergeAmenityItems([
        ...stopItems.amenities,
        ...mapNsrAmenities(requestedPlatform.id, collectNsrEquipmentItems(quay.placeEquipments)),
      ]);
      const parkings = await resolveParkingForStopPlaces(
        parentStopSummary && parentStop ? [parentStop, owningStop] : [owningStop],
      );
      const fareZoneResult = await resolveFareZonesForStopPlaces(
        parentStopSummary && parentStop ? [parentStop, owningStop] : [owningStop],
      );
      const topographicPlace = await resolveTopographicPlaceSummary(owningStop);
      const geometry = buildStopInfrastructureGeometry({
        stopArea:
          nsrRecordGeometry(quay.polygon, quay.multiSurface) ??
          nsrRecordGeometry(owningStop.polygon, owningStop.multiSurface),
        fareZoneGeometries: fareZoneResult.geometries,
      });
      const siblingStops = parentStopSummary ? buildSiblingStops(siblings, owningStop.id) : [];
      const stationIntelligence = deriveStationIntelligence({
        requestedStop,
        canonicalStop,
        parentStop: parentStopSummary ?? undefined,
        siblingStops,
        childStops: [],
        platforms,
        parking: parkings,
      });

      return {
        stopId: withEnturPrefix(rawId),
        provider: "entur",
        sourceId: rawId,
        displayName: requestedPlatform.publicCode
          ? `${canonicalStop.name} · Platform ${requestedPlatform.publicCode}`
          : canonicalStop.name,
        focusLevel: "platform",
        requestedStop,
        canonicalStop,
        parentStop: parentStopSummary ?? undefined,
        siblingStops,
        childStops: [],
        platforms: sortPlatforms(platforms),
        accessibility,
        amenities,
        parking: parkings,
        fareZones: fareZoneResult.summaries,
        topographicPlace,
        stationIntelligence,
        geometry,
        facts: buildStopInfrastructureFacts({
          requestedStop,
          canonicalStop,
          parentStop: parentStopSummary ?? undefined,
          childStops: [],
          platforms,
          fareZones: fareZoneResult.summaries,
          parking: parkings,
          topographicPlace,
        }),
      };
    }

    const stopPlace = await fetchNsrRecord<NsrStopPlaceRecord>(
      `/stop-places/${encodeURIComponent(rawId)}`,
    );
    if (!isTruthyString(stopPlace.id)) return null;

    const parentStationId = nsrRefValue(stopPlace.parentSiteRef);
    if (parentStationId) {
      const [parentStop, siblings] = await Promise.all([
        fetchNsrRecord<NsrStopPlaceRecord>(`/stop-places/${encodeURIComponent(parentStationId)}`),
        fetchNsrRecord<NsrStopPlaceRecord[]>(
          `/stop-places/${encodeURIComponent(parentStationId)}/children`,
        ),
      ]);
      const canonicalStop = normalizeNsrStopAreaSummary(stopPlace, "child_stop", {
        parentStopId: withEnturPrefix(parentStationId),
      });
      const parentStopSummary = normalizeNsrStopAreaSummary(parentStop, "parent_stop", {
        modes: Array.from(new Set(siblings.flatMap((stop) => transportModesFromStopPlace(stop)))),
      });
      if (!canonicalStop) return null;
      const requestedStop = canonicalStop;
      const platforms = collectPlatformsForStopPlaces([stopPlace]);
      const { accessibility, amenities } = mergeStopInfrastructureItems([stopPlace]);
      const parkings = await resolveParkingForStopPlaces([stopPlace]);
      const fareZoneResult = await resolveFareZonesForStopPlaces([stopPlace]);
      const topographicPlace = await resolveTopographicPlaceSummary(stopPlace);
      const geometry = buildStopInfrastructureGeometry({
        stopArea: nsrRecordGeometry(stopPlace.polygon, stopPlace.multiSurface),
        fareZoneGeometries: fareZoneResult.geometries,
      });
      const siblingStops = buildSiblingStops(siblings, stopPlace.id);
      const stationIntelligence = deriveStationIntelligence({
        requestedStop,
        canonicalStop,
        parentStop: parentStopSummary ?? undefined,
        siblingStops,
        childStops: [],
        platforms,
        parking: parkings,
      });

      return {
        stopId: withEnturPrefix(rawId),
        provider: "entur",
        sourceId: rawId,
        displayName: canonicalStop.name,
        focusLevel: "child_stop",
        requestedStop,
        canonicalStop,
        parentStop: parentStopSummary ?? undefined,
        siblingStops,
        childStops: [],
        platforms,
        accessibility,
        amenities,
        parking: parkings,
        fareZones: fareZoneResult.summaries,
        topographicPlace,
        stationIntelligence,
        geometry,
        facts: buildStopInfrastructureFacts({
          requestedStop,
          canonicalStop,
          parentStop: parentStopSummary ?? undefined,
          childStops: [],
          platforms,
          fareZones: fareZoneResult.summaries,
          parking: parkings,
          topographicPlace,
        }),
      };
    }

    let children: NsrStopPlaceRecord[] = [];
    try {
      children = await fetchNsrRecord<NsrStopPlaceRecord[]>(
        `/stop-places/${encodeURIComponent(rawId)}/children`,
      );
    } catch {
      children = [];
    }

    const aggregatedModes = children.length
      ? Array.from(new Set(children.flatMap((child) => transportModesFromStopPlace(child))))
      : undefined;
    const canonicalStop = normalizeNsrStopAreaSummary(stopPlace, "parent_stop", {
      modes: aggregatedModes,
    });
    if (!canonicalStop) return null;
    const childStops = isTruthyString(stopPlace.id)
      ? buildChildStopAreas(stopPlace.id, children)
      : [];
    const infrastructureStops = children.length > 0 ? [stopPlace, ...children] : [stopPlace];
    const platforms = collectPlatformsForStopPlaces(children.length > 0 ? children : [stopPlace]);
    const { accessibility, amenities } = mergeStopInfrastructureItems(infrastructureStops);
    const parkings = await resolveParkingForStopPlaces(infrastructureStops);
    const fareZoneResult = await resolveFareZonesForStopPlaces(infrastructureStops);
    const topographicPlace = await resolveTopographicPlaceSummary(stopPlace);
    const geometry = buildStopInfrastructureGeometry({
      stopArea: nsrRecordGeometry(stopPlace.polygon, stopPlace.multiSurface),
      fareZoneGeometries: fareZoneResult.geometries,
    });
    const stationIntelligence = deriveStationIntelligence({
      requestedStop: canonicalStop,
      canonicalStop,
      siblingStops: [],
      childStops,
      platforms,
      parking: parkings,
    });

    return {
      stopId: withEnturPrefix(rawId),
      provider: "entur",
      sourceId: rawId,
      displayName: canonicalStop.name,
      focusLevel: "parent_stop",
      requestedStop: canonicalStop,
      canonicalStop,
      siblingStops: [],
      childStops,
      platforms,
      accessibility,
      amenities,
      parking: parkings,
      fareZones: fareZoneResult.summaries,
      topographicPlace,
      stationIntelligence,
      geometry,
      facts: buildStopInfrastructureFacts({
        requestedStop: canonicalStop,
        canonicalStop,
        childStops,
        platforms,
        fareZones: fareZoneResult.summaries,
        parking: parkings,
        topographicPlace,
      }),
    };
  } catch {
    return null;
  }
}

export async function getStopPlatforms(stopId: string): Promise<TransitStop[]> {
  const rawId = stripKnownPrefix(stopId);
  if (isQuayId(rawId)) return [];
  try {
    const data = await fetchGraphQl<{ stopPlace?: EnturStopPlace | null }>(
      journeyPlannerEndpoint,
      STOP_PLACE_DETAIL_QUERY,
      { id: rawId },
    );
    return (data.stopPlace?.quays ?? [])
      .map((quay) => normalizeQuay(quay))
      .filter((stop): stop is TransitStop => stop !== null);
  } catch {
    return [];
  }
}

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  try {
    const rawId = stripKnownPrefix(stopId);
    const board = await fetchStopBoard(
      rawId,
      "departures",
      minutes * 60,
      Math.min(200, Math.max(20, minutes * 3)),
    );
    return board.estimatedCalls
      .map((call) => normalizeDeparture(call, "departures"))
      .filter((departure): departure is Departure => departure !== null);
  } catch {
    return [];
  }
}

export async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  try {
    const rawId = stripKnownPrefix(stopId);
    const board = await fetchStopBoard(
      rawId,
      "arrivals",
      minutes * 60,
      Math.min(200, Math.max(20, minutes * 3)),
    );
    return board.estimatedCalls
      .map((call) => normalizeDeparture(call, "arrivals"))
      .filter((departure): departure is Departure => departure !== null);
  } catch {
    return [];
  }
}

export async function getStopTimetable(stopId: string, date: string): Promise<Departure[]> {
  try {
    const rawId = stripKnownPrefix(stopId);
    const board = await fetchStopBoard(
      rawId,
      "departures",
      FULL_DAY_SECONDS,
      500,
      `${date}T00:00:00Z`,
    );
    return board.estimatedCalls
      .map((call) => normalizeDeparture(call, "departures"))
      .filter((departure): departure is Departure => departure !== null);
  } catch {
    return [];
  }
}

export async function getRoutesForStop(stopId: string): Promise<TransitRoute[]> {
  const rawId = stripKnownPrefix(stopId);
  try {
    if (isQuayId(rawId)) {
      const data = await fetchGraphQl<{ quay?: { lines?: EnturLine[] | null } | null }>(
        journeyPlannerEndpoint,
        QUAY_ROUTES_QUERY,
        { id: rawId },
      );
      return dedupeById(
        (data.quay?.lines ?? [])
          .map((line) => normalizeLine(line))
          .filter((line): line is TransitRoute => line !== null),
      );
    }

    const data = await fetchGraphQl<{
      stopPlace?: { quays?: Array<{ lines?: EnturLine[] | null } | null> | null } | null;
    }>(journeyPlannerEndpoint, STOP_PLACE_ROUTES_QUERY, { id: rawId });
    const routes = (data.stopPlace?.quays ?? []).flatMap((quay) => quay?.lines ?? []);
    return dedupeById(
      routes
        .map((line) => normalizeLine(line))
        .filter((line): line is TransitRoute => line !== null),
    );
  } catch {
    return [];
  }
}

export async function getRoute(routeId: string): Promise<TransitRoute | null> {
  const rawId = stripKnownPrefix(routeId);
  try {
    const data = await fetchGraphQl<{ line?: EnturLine | null }>(
      journeyPlannerEndpoint,
      LINE_DETAIL_QUERY,
      { id: rawId },
    );
    const line = data.line;
    const normalized = normalizeLine(line);
    if (!normalized) return null;
    return {
      ...normalized,
      geometry: routeGeometryFromPatterns(line?.journeyPatterns),
    };
  } catch {
    return null;
  }
}

export async function getRouteStops(routeId: string, hintStopId?: string): Promise<RouteStop[]> {
  const rawId = stripKnownPrefix(routeId);
  try {
    const data = await fetchGraphQl<{ line?: EnturLine | null }>(
      journeyPlannerEndpoint,
      LINE_DETAIL_QUERY,
      { id: rawId },
    );
    const pattern = chooseBestJourneyPattern(data.line?.journeyPatterns, hintStopId);
    const quays = pattern?.quays ?? [];
    return quays
      .map((quay, sequence): RouteStop | null => {
        const stopPlace = quay.stopPlace;
        const latitude = stopPlace?.latitude ?? quay.latitude;
        const longitude = stopPlace?.longitude ?? quay.longitude;
        const rawStopId = stopPlace?.id ?? quay.id;
        const name = stopPlace?.name ?? quay.name ?? "";
        if (
          !rawStopId ||
          !isTruthyString(name) ||
          typeof latitude !== "number" ||
          typeof longitude !== "number"
        ) {
          return null;
        }
        return {
          id: withEnturPrefix(rawStopId),
          name,
          lat: latitude,
          lng: longitude,
          platformCode: quay.publicCode ?? undefined,
          sequence: sequence + 1,
        };
      })
      .filter((stop): stop is RouteStop => stop !== null);
  } catch {
    return [];
  }
}

export async function planTrip(params: {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  departureTime?: string;
  arrivalTime?: string;
  modes?: string[];
}): Promise<TripPlan | null> {
  const dateTime = params.arrivalTime ?? params.departureTime ?? new Date().toISOString();
  const arriveBy = Boolean(params.arrivalTime);
  try {
    const data = await fetchGraphQl<{ trip?: EnturTrip | null }>(
      journeyPlannerEndpoint,
      TRIP_PLAN_QUERY,
      {
        fromLat: params.from.lat,
        fromLon: params.from.lng,
        toLat: params.to.lat,
        toLon: params.to.lng,
        dateTime,
        arriveBy,
        numTripPatterns: 3,
      },
    );
    return normalizeTripPlan(data.trip);
  } catch {
    return null;
  }
}

export async function getLegGeometry(
  tripId: string,
  fromStopId?: string,
  toStopId?: string,
): Promise<GeoJSONLineString | null> {
  try {
    const { serviceJourneyId, date } = decodeServiceJourneyId(tripId);
    const resolved = await fetchServiceJourneyForDates(serviceJourneyId, date);
    if (!resolved) return null;
    const fullGeometry = decodePoints(
      resolved.journey.pointsOnLink?.points ??
        resolved.journey.journeyPattern?.pointsOnLink?.points,
    );
    if (fullGeometry.length < 2) return null;
    const fromCoord = fromStopId
      ? pointFromStopOrQuay(stripKnownPrefix(fromStopId), resolved.journey.estimatedCalls)
      : undefined;
    const toCoord = toStopId
      ? pointFromStopOrQuay(stripKnownPrefix(toStopId), resolved.journey.estimatedCalls)
      : undefined;
    return sliceGeometry(fullGeometry, fromCoord, toCoord);
  } catch {
    return null;
  }
}

export async function getVehicleJourney(
  tripId: string,
  fallbackIds?: string[],
): Promise<VehicleJourney | null> {
  const candidates = [tripId, ...(fallbackIds ?? [])];
  for (const candidate of candidates) {
    try {
      const { serviceJourneyId, date } = decodeServiceJourneyId(candidate);
      const resolved = await fetchServiceJourneyForDates(serviceJourneyId, date);
      if (!resolved?.journey) continue;
      const line = normalizeLine(resolved.journey.line);
      const stops = (resolved.journey.estimatedCalls ?? [])
        .map((call) => normalizeJourneyStop(call))
        .filter((stop): stop is VehicleJourneyStop => stop !== null);
      if (stops.length === 0) continue;
      const journeySituations = [
        ...(resolved.journey.situations ?? []),
        ...(resolved.journey.estimatedCalls ?? []).flatMap((call) => call.situations ?? []),
      ];
      const occupancy = (resolved.journey.estimatedCalls ?? [])
        .map((call) => toOccupancyLevel(call.occupancyStatus))
        .find((value) => value !== undefined);
      return {
        id: encodeServiceJourneyId(serviceJourneyId, resolved.date),
        name:
          line?.shortName ??
          resolved.journey.publicCode ??
          resolved.journey.line?.name ??
          serviceJourneyId,
        provider: "entur",
        occupancy,
        remarks: situationsToRemarks(journeySituations),
        stops,
      };
    } catch {}
  }
  return null;
}

export async function getVehiclePositions(routeId: string): Promise<VehiclePosition[]> {
  const rawId = stripKnownPrefix(routeId);
  try {
    const data = await fetchGraphQl<{ vehicles?: EnturVehicle[] | null }>(
      vehiclesEndpoint,
      VEHICLES_BY_LINE_QUERY,
      {
        lineRef: rawId,
        maxDataAge: "PT30M",
      },
    );
    return (data.vehicles ?? [])
      .map((vehicle) => normalizeVehiclePosition(vehicle))
      .filter((vehicle): vehicle is VehiclePosition => vehicle !== null);
  } catch {
    return [];
  }
}

export async function getVehicleRadar(bbox: BBox): Promise<VehiclePosition[]> {
  try {
    const data = await fetchGraphQl<{ vehicles?: EnturVehicle[] | null }>(
      vehiclesEndpoint,
      VEHICLES_BY_BBOX_QUERY,
      {
        minLat: bbox[1],
        minLon: bbox[0],
        maxLat: bbox[3],
        maxLon: bbox[2],
        maxDataAge: "PT30M",
      },
    );
    return (data.vehicles ?? [])
      .map((vehicle) => normalizeVehiclePosition(vehicle))
      .filter((vehicle): vehicle is VehiclePosition => vehicle !== null);
  } catch {
    return [];
  }
}

export async function getRouteAlerts(routeId: string): Promise<ServiceAlert[]> {
  const rawId = stripKnownPrefix(routeId);
  try {
    const data = await fetchGraphQl<{ line?: { situations?: EnturSituation[] | null } | null }>(
      journeyPlannerEndpoint,
      LINE_DETAIL_QUERY,
      { id: rawId },
    );
    return mergeAlertArrays(
      (data.line?.situations ?? [])
        .map((situation) => situationToAlert(situation, { routeId: withEnturPrefix(rawId) }))
        .filter((alert): alert is ServiceAlert => alert !== null),
    );
  } catch {
    return [];
  }
}

export async function getStopAlerts(stopId: string): Promise<ServiceAlert[]> {
  const rawId = stripKnownPrefix(stopId);
  try {
    const board = await fetchStopBoard(rawId, "departures", 6 * 60 * 60, 80);
    const alerts = [
      ...(board.situations ?? []),
      ...board.estimatedCalls.flatMap((call) => call.situations ?? []),
    ]
      .map((situation) => situationToAlert(situation, { stopId: withEnturPrefix(rawId) }))
      .filter((alert): alert is ServiceAlert => alert !== null);
    return mergeAlertArrays(alerts);
  } catch {
    return [];
  }
}

export async function getAlerts(bbox: BBox): Promise<ServiceAlert[]> {
  try {
    const data = await fetchGraphQl<{ situations?: EnturSituation[] | null }>(
      journeyPlannerEndpoint,
      NATIONAL_SITUATIONS_QUERY,
    );
    const filtered = (data.situations ?? []).filter((situation) => {
      const stopMatch = (situation.stopPlaces ?? []).some(
        (stopPlace) =>
          stopPlace != null &&
          typeof stopPlace.latitude === "number" &&
          typeof stopPlace.longitude === "number" &&
          isInsideBbox(bbox, stopPlace.longitude, stopPlace.latitude),
      );
      const quayMatch = (situation.quays ?? []).some(
        (quay) =>
          quay != null &&
          typeof quay.longitude === "number" &&
          typeof quay.latitude === "number" &&
          isInsideBbox(bbox, quay.longitude, quay.latitude),
      );
      return stopMatch || quayMatch;
    });
    return mergeAlertArrays(
      filtered
        .map((situation) => situationToAlert(situation))
        .filter((alert): alert is ServiceAlert => alert !== null),
    );
  } catch {
    return [];
  }
}

export async function getFacilities(stopId: string): Promise<Facility[]> {
  const rawId = stripKnownPrefix(stopId);
  if (!rawId.startsWith(NSR_PREFIX)) return [];
  try {
    if (isQuayId(rawId)) {
      const quay = await fetchNsrRecord<NsrQuayRecord>(`/quays/${encodeURIComponent(rawId)}`);
      const infrastructure = {
        stopId: withEnturPrefix(rawId),
        accessibility: mapNsrAccessibility(
          withEnturPrefix(rawId),
          collectNsrLimitations(quay.accessibilityAssessment),
        ),
        amenities: mapNsrAmenities(
          withEnturPrefix(rawId),
          collectNsrEquipmentItems(quay.placeEquipments),
        ),
        parking: [],
      };
      return facilitiesFromStopInfrastructure(infrastructure);
    }

    const stopPlace = await fetchNsrRecord<NsrStopPlaceRecord>(
      `/stop-places/${encodeURIComponent(rawId)}`,
    );
    const parkings = await fetchStopPlaceParkings(rawId);
    const stopIdWithPrefix = withEnturPrefix(rawId);
    const infrastructure = {
      stopId: stopIdWithPrefix,
      accessibility: mapNsrAccessibility(
        stopIdWithPrefix,
        collectNsrLimitations(stopPlace.accessibilityAssessment),
      ),
      amenities: mapNsrAmenities(
        stopIdWithPrefix,
        collectNsrEquipmentItems(stopPlace.placeEquipments),
      ),
      parking: parkings
        .map((parking) => mapNsrParking(parking))
        .filter((parking): parking is TransitStopParking => parking !== null),
    };
    return dedupeById([
      ...facilitiesFromStopInfrastructure(infrastructure),
      ...facilitiesFromParkings(stopIdWithPrefix, parkings),
    ]);
  } catch {
    return [];
  }
}
