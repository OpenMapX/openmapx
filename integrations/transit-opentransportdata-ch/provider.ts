import { createHash } from "node:crypto";
import type { BBox } from "@openmapx/core";
import type {
  Departure,
  FareProduct,
  GeoJSONLineString,
  OccupancyLevel,
  ServiceAlert,
  TransitAccessibilityItem,
  TransitAmenityItem,
  TransitFormationDetail,
  TransitFormationReference,
  TransitInterchangeComplexity,
  TransitPlatformDetail,
  TransitRoute,
  TransitServiceInfo,
  TransitStationIntelligence,
  TransitStop,
  TransitStopAreaSummary,
  TransitStopInfrastructure,
  TransitStopParking,
  TransportMode,
  TripFare,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
} from "@openmapx/mobility-core/transit";
import {
  buildOjpFareRequestXml,
  buildOjpLocationInformationRequestXml,
  buildOjpStopEventRequestXml,
  buildOjpTripInfoRequestXml,
  buildOjpTripRequestXml,
  extractOjpTripRequestTrips,
  type GtfsRtFeedObject,
  gtfsRtTimestampToIso,
  listSiriSituations,
  type OjpCall,
  type OjpDatedTrainNumberRef,
  type OjpFareProduct,
  type OjpFareResult,
  type OjpPlace,
  type OjpService,
  type OjpStopEvent,
  type OjpTripLeg,
  type OjpTripResponse,
  type OjpTripResult,
  parseOjpFareResponse,
  parseOjpLocationInformationResponse,
  parseOjpStopEventResponse,
  parseOjpTripInfoResponse,
  parseOjpTripResponse,
  type SiriSituation,
  type XmlObject,
} from "@openmapx/mobility-formats";
import {
  fetchSwissFormationJourney,
  fetchSwissGtfsRtFeed,
  fetchSwissGtfsSaFeed,
  fetchSwissSiriSxFeed,
  getSwissTransitConfig,
  isSwissTransitConfigured,
  probeSwissOjp,
  requestSwissOjp,
  requestSwissOjpFare,
  type SwissTransitConfig,
  setSwissTransitConfig,
} from "./client.js";
import {
  findSwissNearbyServicePoints,
  loadSwissBusinessOrganisationDatasets,
  loadSwissOccupancyForecastDataset,
  loadSwissStopDatasets,
  resolveSwissStopIdentity,
  type SwissBusinessOrganisation,
  type SwissBusinessOrganisationDatasets,
  type SwissFlatCsvRecord,
  type SwissOccupancyForecastFareClassLevel,
  type SwissOccupancyForecastSection,
  type SwissOccupancyForecastTrain,
  type SwissServicePoint,
  type SwissStopDatasets,
  type SwissTrafficPoint,
  searchSwissServicePoints,
} from "./datasets.js";

const SWITZERLAND_BBOX: BBox = [5.96, 45.82, 10.49, 47.81];
const PROVIDER = "otdch";
const PREFIX = "otdch:";
const SWISS_TIMEZONE = "Europe/Zurich";
const SWISS_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: SWISS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

type SwissMappedAlert = ServiceAlert & {
  rawOperatorRefs: string[];
  rawRouteRefs: string[];
  rawStopRefs: string[];
};

interface SwissFareAssignment {
  effectiveFareLegIndex: number;
  fareTransferIndex: number;
}

interface SwissMappedFareBundle {
  fare: TripFare;
  legAssignments: Map<string, SwissFareAssignment>;
}

interface SwissGtfsTranslatedText {
  translation?: Array<{ text?: string }>;
}

interface SwissGtfsInformedEntity {
  routeId?: string;
  stopId?: string;
}

interface SwissGtfsActivePeriod {
  end?: string;
  start?: string;
}

interface SwissGtfsAlert {
  activePeriod?: SwissGtfsActivePeriod[];
  descriptionText?: SwissGtfsTranslatedText;
  effect?: string;
  headerText?: SwissGtfsTranslatedText;
  informedEntity?: SwissGtfsInformedEntity[];
  severityLevel?: string;
  ttsDescriptionText?: SwissGtfsTranslatedText;
  ttsHeaderText?: SwissGtfsTranslatedText;
}

interface SwissGtfsEntity {
  alert?: SwissGtfsAlert;
  id?: string;
}

type SwissRouteStop = TransitStop & { sequence: number };

interface SwissObservedRouteEntry {
  expiresAt: number;
  hintStopIds: string[];
  operatorRefs: string[];
  route: TransitRoute;
  stops?: SwissRouteStop[];
  tripIds: string[];
}

interface SwissGtfsTripUpdateStopTimeEvent {
  delay?: number | string;
  scheduleRelationship?: string;
  time?: number | string;
}

interface SwissGtfsTripUpdateStopTimeUpdate {
  arrival?: SwissGtfsTripUpdateStopTimeEvent;
  departure?: SwissGtfsTripUpdateStopTimeEvent;
  scheduleRelationship?: string;
  stopId?: string;
  stopSequence?: number | string;
}

interface SwissGtfsTripUpdate {
  stopTimeUpdate?: SwissGtfsTripUpdateStopTimeUpdate[];
  timestamp?: number | string;
  trip?: {
    routeId?: string;
    scheduleRelationship?: string;
    startDate?: string;
    tripId?: string;
  };
}

interface SwissGtfsRepresentativeTrip {
  agency_name: string | null;
  route_color: string | null;
  route_id: string;
  route_long_name: string;
  route_short_name: string;
  route_text_color: string | null;
  route_type: number;
  shape_id: string | null;
  trip_headsign: string | null;
  trip_id: string;
}

interface SwissGtfsTripStop {
  original_stop_id: string | null;
  parent_station: string | null;
  platform_code: string | null;
  stop_id: string;
  stop_lat: number;
  stop_lon: number;
  stop_name: string;
  stop_sequence: number;
}

interface SwissGtfsShapePoint {
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
}

interface SwissGtfsDeps {
  ensureSwissOfficialFeed?: () => Promise<{
    countryCode?: string;
    schemaName: string;
    source?: string;
    status: string;
  } | null>;
  manager: {
    initialized: boolean;
    getFeeds(): Array<{
      countryCode?: string;
      schemaName: string;
      source?: string;
      status: string;
    }>;
  };
  queries: {
    findRepresentativeTrip(
      schema: string,
      options: {
        routeShortName: string;
        headsign?: string;
        operatorName?: string;
        stopRefs?: string[];
        stopNames?: string[];
      },
    ): Promise<SwissGtfsRepresentativeTrip | null>;
    getShapePoints(schema: string, shapeId: string): Promise<SwissGtfsShapePoint[]>;
    getTripStops(schema: string, tripId: string): Promise<SwissGtfsTripStop[]>;
    routeTypeToMode(routeType: number): string;
  };
}

interface SwissFormationStopPoint {
  designationOfficial?: string;
  uic?: string;
}

interface SwissFormationScheduledStop {
  stopPoint?: SwissFormationStopPoint;
  stopTime?: string;
  track?: string;
}

interface SwissFormationStopRecord {
  scheduledStop?: SwissFormationScheduledStop;
  sector?: string;
}

interface SwissFormationJourneyResponse {
  formations?: Array<{
    formationVehicles?: Array<{
      formationVehicleStops?: SwissFormationStopRecord[];
      metaInformation?: {
        id?: string;
        length?: number;
        order?: number;
        vehicleNumber?: string;
        vehicleTypeAbbreviation?: string;
        vehicleTypeDesignation?: string;
      };
      vehicleMetaInformation?: {
        id?: string;
        length?: number;
        order?: number;
        vehicleNumber?: string;
        vehicleTypeAbbreviation?: string;
        vehicleTypeDesignation?: string;
      };
      vehicleProperties?: {
        climated?: boolean;
        closed?: boolean;
        lowFloor?: boolean;
        numberBicycleHooks?: number;
        numberFirstClassSeats?: number;
        numberSecondClassSeats?: number;
        numberWheelchairPlaces?: number;
        toilet?: boolean;
      };
    }>;
    metaInformation?: {
      length?: number;
      numberSeats?: number;
      numberVehicles?: number;
    };
  }>;
  formationsAtScheduledStops?: Array<{
    formationShort?: { formationShortString?: string };
    scheduledStop?: SwissFormationScheduledStop;
  }>;
  journeyMetaInformation?: {
    SJYID?: string;
    operationDate?: string;
  };
  lastUpdate?: string;
  trainMetaInformation?: {
    trainNumber?: string;
  };
}

const SWISS_OBSERVED_ROUTE_TTL_MS = 24 * 60 * 60 * 1000;
const SWISS_OBSERVED_ROUTE_TTL_SECONDS = 24 * 60 * 60;
const observedRoutes = new Map<string, SwissObservedRouteEntry>();
let swissGtfsDeps: SwissGtfsDeps | null = null;
const SWISS_FORMATION_EVU_BY_ORGANISATION_NUMBER: Record<string, string> = {
  "11": "SBBP",
  "29": "MBC",
  "33": "BLSP",
  "44": "TRN",
  "53": "TPF",
  "65": "THURBO",
  "72": "RhB",
  "73": "TRN",
  "82": "SOB",
  "86": "ZB",
  "153": "TRN",
  "792": "TRN",
  "796": "TRN",
};
const SWISS_FORMATION_EVU_BY_ABBREVIATION: Record<string, string> = {
  bls: "BLSP",
  mbc: "MBC",
  oebb: "OeBB",
  rhb: "RhB",
  sbb: "SBBP",
  sob: "SOB",
  tpf: "TPF",
  thurbo: "THURBO",
  trn: "TRN",
  vdbb: "VDBB",
  zb: "ZB",
};

function bboxContains(bbox: BBox, lng: number, lat: number): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function bboxOverlaps(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function providerId(raw: string): string {
  return `${PREFIX}${raw}`;
}

function stripProviderPrefix(id: string): string {
  if (id.startsWith(PREFIX)) return id.slice(PREFIX.length);
  return id;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (["YES", "TRUE", "JA"].includes(normalized)) return true;
  if (["NO", "FALSE", "NEIN"].includes(normalized)) return false;
  return undefined;
}

function normalizeText(value: string | undefined): string {
  return String(value ?? "").trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeSwissLookupKey(value: string | undefined): string | null {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized || null;
}

function extractSwissOrganisationNumber(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (/^\d+$/.test(normalized)) return normalized;
  const exact = normalized.match(/^85:(\d+)(?::\d+)?$/);
  if (exact?.[1]) return exact[1];
  return undefined;
}

function extractSwissSboid(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  const match = normalized.match(/^(?:ch:1:sboid:)?(\d+)$/i);
  return match?.[1] ? `ch:1:sboid:${match[1]}` : undefined;
}

function normalizeSwissOperatingDate(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  if (/^\d{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  return undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function parseNumeric(value: number | string | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function uniqueModes(values: Array<TransportMode | null | undefined>): TransportMode[] {
  const set = new Set<TransportMode>();
  for (const value of values) {
    if (value) set.add(value);
  }
  return [...set];
}

function mapSwissMode(raw: string | undefined): TransportMode | null {
  switch (String(raw ?? "").toLowerCase()) {
    case "rail":
    case "train":
      return "rail";
    case "bus":
      return "bus";
    case "tram":
      return "tram";
    case "metro":
    case "subway":
    case "underground":
      return "subway";
    case "water":
    case "waterborne":
    case "ferry":
    case "ship":
      return "ferry";
    case "funicular":
      return "funicular";
    case "gondola":
      return "gondola";
    case "cableway":
    case "cablecar":
    case "cable_car":
      return "cable_car";
    case "monorail":
      return "monorail";
    case "foot":
    case "walk":
    case "walking":
      return "walking";
    default:
      return null;
  }
}

function mapSwissOccupancy(raw: string | undefined): OccupancyLevel | undefined {
  const value = normalizeText(raw).toLowerCase();
  if (!value) return undefined;
  if (["manyseatsavailable", "seatsavailable", "low", "lowoccupancy", "1", "2"].includes(value)) {
    return "low";
  }
  if (["standingavailable", "limitedstanding", "medium", "mediumoccupancy", "3"].includes(value)) {
    return "medium";
  }
  if (["fewseatsavailable", "standingroomonly", "high", "highoccupancy", "4"].includes(value)) {
    return "high";
  }
  if (["full", "crushedstanding", "overcrowded", "veryhighoccupancy", "5"].includes(value)) {
    return "overcrowded";
  }
  return undefined;
}

function swissDateTimeParts(iso: string | undefined): { date: string; time: string } | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = SWISS_DATE_TIME_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (
    !values.year ||
    !values.month ||
    !values.day ||
    !values.hour ||
    !values.minute ||
    !values.second
  ) {
    return null;
  }
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function swissDayShift(
  iso: string | undefined,
  operatingDayRef: string | undefined,
): number | undefined {
  const parts = swissDateTimeParts(iso);
  if (!parts || !operatingDayRef) return undefined;
  const parseDay = (value: string) => {
    const [year, month, day] = value.split("-").map((segment) => Number.parseInt(segment, 10));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return Date.UTC(year, month - 1, day) / 86_400_000;
  };
  const actual = parseDay(parts.date);
  const scheduled = parseDay(operatingDayRef);
  if (actual == null || scheduled == null) return undefined;
  return actual - scheduled;
}

function mapSwissForecastOccupancyClasses(
  levels: SwissOccupancyForecastFareClassLevel[] | undefined,
): TransitServiceInfo["occupancyClasses"] | undefined {
  if (!levels?.length) return undefined;
  const classes: NonNullable<TransitServiceInfo["occupancyClasses"]> = {};
  for (const level of levels) {
    const mapped = mapSwissOccupancy(level.occupancyLevel);
    if (!mapped) continue;
    if (normalizeText(level.fareClass).toLowerCase() === "firstclass") {
      classes.firstClass = mapped;
      continue;
    }
    if (normalizeText(level.fareClass).toLowerCase() === "secondclass") {
      classes.secondClass = mapped;
    }
  }
  return classes.firstClass || classes.secondClass ? classes : undefined;
}

function pickSwissForecastOccupancy(
  classes: TransitServiceInfo["occupancyClasses"] | undefined,
): OccupancyLevel | undefined {
  if (!classes) return undefined;
  if (classes.secondClass) return classes.secondClass;
  if (classes.firstClass) return classes.firstClass;
  return undefined;
}

function mapOjpFormation(
  refs: OjpDatedTrainNumberRef[] | undefined,
): TransitFormationReference[] | undefined {
  if (!refs?.length) return undefined;
  return refs
    .filter((ref) => ref.trainNumber || ref.operatorRef || ref.operatingDayRef)
    .map((ref) => ({
      operatorRef: ref.operatorRef,
      operatingDayRef: ref.operatingDayRef,
      trainNumber: ref.trainNumber,
    }));
}

function collectServiceOperatorRefs(service: OjpService | undefined): string[] {
  return uniqueStrings([
    service?.operatorRef,
    ...(service?.operatorRefs ?? []),
    ...(service?.datedTrainNumberRefs ?? []).map((ref) => ref.operatorRef),
  ]);
}

function resolveSwissBusinessOrganisation(
  refs: Array<string | undefined>,
  datasets: SwissBusinessOrganisationDatasets,
): SwissBusinessOrganisation | undefined {
  for (const ref of refs) {
    const normalized = normalizeText(ref);
    if (!normalized) continue;

    const participant = datasets.byParticipantRef.get(normalizeSwissLookupKey(normalized) ?? "");
    if (participant) return participant;

    const sboid = extractSwissSboid(normalized);
    if (sboid) {
      const bySboid = datasets.bySboid.get(normalizeSwissLookupKey(sboid) ?? "");
      if (bySboid) return bySboid;
    }

    const organisationNumber = extractSwissOrganisationNumber(normalized);
    if (organisationNumber) {
      const byOrganisation = datasets.byOrganisationNumber.get(
        normalizeSwissLookupKey(organisationNumber) ?? "",
      );
      if (byOrganisation) return byOrganisation;
    }

    const byAbbreviation = datasets.byAbbreviation.get(normalizeSwissLookupKey(normalized) ?? "");
    if (byAbbreviation) return byAbbreviation;

    const abbreviationRoot = normalized.split("-")[0];
    if (abbreviationRoot) {
      const byRoot = datasets.byAbbreviation.get(normalizeSwissLookupKey(abbreviationRoot) ?? "");
      if (byRoot) return byRoot;
    }
  }
  return undefined;
}

function mapSwissOperatorMetadata(
  service: OjpService | undefined,
  datasets: SwissBusinessOrganisationDatasets,
): SwissBusinessOrganisation | undefined {
  return resolveSwissBusinessOrganisation(collectServiceOperatorRefs(service), datasets);
}

function routeShortNameFromService(service: OjpService | undefined): string | undefined {
  return (
    service?.publishedServiceName ||
    service?.publishedLineName ||
    service?.productCategoryShortName ||
    service?.trainNumber
  );
}

function routeIdFromService(service: OjpService | undefined): string | undefined {
  const shortName = routeShortNameFromService(service);
  if (!shortName) return undefined;
  return providerId(service?.lineRef || shortName);
}

function serviceTrainNumber(service: OjpService | undefined): string | undefined {
  return uniqueStrings([
    service?.trainNumber,
    ...(service?.datedTrainNumberRefs ?? []).map((ref) => ref.trainNumber),
  ]).find((value): value is string => Boolean(value));
}

function mapOjpServiceInfo(
  service: OjpService | undefined,
  operatorMetadata?: SwissBusinessOrganisation,
): TransitServiceInfo | undefined {
  if (!service) return undefined;
  return {
    attributes: service.attributeDetails.map((attribute) => ({
      accessFacility: attribute.accessFacility,
      code: attribute.code,
      text: attribute.text,
      userText: attribute.userText,
    })),
    canceled: service.canceled,
    destinationStopPointRef: service.destinationStopPointRef,
    destinationText: service.destinationText,
    deviation: service.deviation,
    directionRef: service.directionRef,
    formation: mapOjpFormation(service.datedTrainNumberRefs),
    journeyRef: service.journeyRef,
    lineRef: service.lineRef,
    modeName: service.modeName,
    modeShortName: service.modeShortName,
    occupancy: mapSwissOccupancy(service.occupancy),
    occupancyRaw: service.occupancy,
    ...(service.occupancy ? { occupancySource: "ojp" } : {}),
    operatingDayRef: service.operatingDayRef,
    operatorAbbreviation: operatorMetadata?.abbreviation,
    operatorName: operatorMetadata?.description,
    operatorOrganisationNumber: operatorMetadata?.organisationNumber,
    operatorParticipantRef: operatorMetadata?.participantRef,
    operatorRef: service.operatorRef,
    operatorRefs: collectServiceOperatorRefs(service),
    originStopPointRef: service.originStopPointRef,
    originText: service.originText,
    productCategoryName: service.productCategoryName,
    productCategoryRef: service.productCategoryRef,
    productCategoryShortName: service.productCategoryShortName,
    ptMode: service.ptMode,
    publishedLineName: service.publishedLineName,
    publishedServiceName: service.publishedServiceName,
    routeDescription: service.routeDescription,
    serviceFeatureRefs: service.serviceFeatureRefs,
    situationIds: service.situationIds,
    submode: service.submode,
    trainNumber: serviceTrainNumber(service),
    undefinedDelay: service.undefinedDelay,
    unplanned: service.unplanned,
    vehicleFeatureRefs: service.vehicleFeatureRefs,
    vehicleRef: service.vehicleRef,
    viaStopPointRefs: service.viaStopPointRefs,
    viaTexts: service.viaTexts,
  };
}

function serviceRemarks(service: OjpService | undefined): Departure["remarks"] {
  if (!service?.attributes.length) return undefined;
  return service.attributes.map((text) => ({ text, type: "info" as const }));
}

function legGeometry(leg: OjpTripLeg): TripLeg["geometry"] {
  if (leg.projectionCoordinates.length >= 2) {
    return {
      type: "LineString",
      coordinates: leg.projectionCoordinates,
    };
  }
  return {
    type: "LineString",
    coordinates: [
      [leg.start.lng, leg.start.lat],
      [leg.end.lng, leg.end.lat],
    ],
  };
}

function mapRequestedIntermodalModes(modes: string[] | undefined): string[] | undefined {
  if (!modes?.length) return undefined;
  const values = new Set<string>();
  for (const mode of modes) {
    switch (normalizeText(mode).toLowerCase()) {
      case "bike":
      case "bicycle":
      case "cycling":
      case "cycle":
        values.add("cycle");
        break;
      case "bicycle_rental":
      case "bike_rental":
        values.add("bicycle_rental");
        break;
      case "escooter":
      case "escooter_rental":
      case "scooter_rental":
        values.add("escooter_rental");
        break;
      case "car":
      case "driving":
      case "self-drive-car":
        values.add("self-drive-car");
        break;
      case "car_sharing":
      case "car-sharing":
        values.add("car_sharing");
        break;
      default:
        break;
    }
  }
  return values.size > 0 ? [...values] : undefined;
}

function servicePointModes(
  servicePoint: SwissServicePoint | undefined,
  fallback: string[] = [],
): TransportMode[] {
  return uniqueModes([
    ...fallback.map(mapSwissMode),
    ...(servicePoint?.meansOfTransport ?? []).map(mapSwissMode),
  ]);
}

function platformCodeFromRef(rawRef: string | undefined): string | undefined {
  if (!rawRef?.startsWith("ch:1:sloid:")) return undefined;
  const parts = rawRef.split(":");
  return parts.length > 4 ? parts.at(-1) || undefined : undefined;
}

function findServicePoint(
  rawRef: string,
  datasets: SwissStopDatasets,
): {
  didok?: string;
  servicePoint?: SwissServicePoint;
  servicePointSloid?: string;
  stopPoint?: SwissTrafficPoint;
} {
  const identity = resolveSwissStopIdentity(rawRef, datasets);
  const servicePoint = identity.servicePointSloid
    ? datasets.servicePointsBySloid.get(identity.servicePointSloid)
    : undefined;
  const stopPoint = identity.stopPointSloid
    ? datasets.trafficPointsBySloid.get(identity.stopPointSloid)
    : undefined;
  return {
    didok: identity.didok,
    servicePoint,
    servicePointSloid: identity.servicePointSloid,
    stopPoint,
  };
}

function buildStopIds(
  rawRef: string,
  identity: { didok?: string; servicePointSloid?: string },
): { primaryScheme?: string; ids?: Record<string, string> } {
  const ids: Record<string, string> = { otdch: rawRef };
  let primaryScheme: string | undefined;
  if (rawRef.startsWith("ch:1:sloid:")) {
    ids.sloid = rawRef;
    if (identity.didok) ids.didok = identity.didok;
    primaryScheme = "sloid";
  } else if (identity.didok) {
    ids.didok = identity.didok;
    if (identity.servicePointSloid) ids.sloid = identity.servicePointSloid;
    primaryScheme = "didok";
  }
  return {
    ids,
    primaryScheme,
  };
}

function mergeTransitRoute(existing: TransitRoute | undefined, next: TransitRoute): TransitRoute {
  return {
    id: next.id,
    shortName: next.shortName || existing?.shortName || next.id,
    longName: next.longName || existing?.longName || next.shortName || next.id,
    mode: next.mode ?? existing?.mode ?? "rail",
    operatorName: next.operatorName || existing?.operatorName || "OpenTransportData Switzerland",
    ...(existing?.color || next.color ? { color: next.color ?? existing?.color } : {}),
    ...(existing?.textColor || next.textColor
      ? { textColor: next.textColor ?? existing?.textColor }
      : {}),
    ...(existing?.geometry || next.geometry
      ? { geometry: next.geometry ?? existing?.geometry }
      : {}),
  };
}

function observedRouteCacheKey(routeId: string): string {
  return `swiss-otdch:route-observed:${stripProviderPrefix(routeId)}`;
}

function pruneObservedRoutes(): void {
  const now = Date.now();
  for (const [routeId, entry] of observedRoutes.entries()) {
    if (entry.expiresAt <= now) {
      observedRoutes.delete(routeId);
    }
  }
}

function serializeObservedRoute(entry: SwissObservedRouteEntry) {
  return {
    hintStopIds: entry.hintStopIds,
    operatorRefs: entry.operatorRefs,
    route: entry.route,
    stops: entry.stops,
    tripIds: entry.tripIds,
  };
}

function buildObservedRouteEntry(
  route: TransitRoute,
  input: {
    hintStopId?: string;
    operatorRefs?: string[];
    stops?: SwissRouteStop[];
    tripId?: string;
  },
  existing?: SwissObservedRouteEntry,
): SwissObservedRouteEntry {
  return {
    expiresAt: Date.now() + SWISS_OBSERVED_ROUTE_TTL_MS,
    hintStopIds: uniqueStrings([...(existing?.hintStopIds ?? []), input.hintStopId]),
    operatorRefs: uniqueStrings([...(existing?.operatorRefs ?? []), ...(input.operatorRefs ?? [])]),
    route: mergeTransitRoute(existing?.route, route),
    stops: input.stops && input.stops.length > 0 ? input.stops : existing?.stops,
    tripIds: uniqueStrings([...(existing?.tripIds ?? []), input.tripId]),
  };
}

async function rememberObservedRoute(
  route: TransitRoute,
  input: {
    hintStopId?: string;
    operatorRefs?: string[];
    stops?: SwissRouteStop[];
    tripId?: string;
  } = {},
): Promise<void> {
  pruneObservedRoutes();
  const entry = buildObservedRouteEntry(route, input, observedRoutes.get(route.id));
  observedRoutes.set(route.id, entry);
  const cache = getSwissTransitConfig().cache;
  if (!cache) return;
  try {
    await cache.set(
      observedRouteCacheKey(route.id),
      serializeObservedRoute(entry),
      SWISS_OBSERVED_ROUTE_TTL_SECONDS,
    );
  } catch {
    // best-effort cache write only
  }
}

async function getObservedRoute(routeId: string): Promise<SwissObservedRouteEntry | null> {
  pruneObservedRoutes();
  const local = observedRoutes.get(routeId);
  if (local) return local;
  const cache = getSwissTransitConfig().cache;
  if (!cache) return null;
  try {
    const cached = await cache.get<{
      hintStopIds?: string[];
      operatorRefs?: string[];
      route?: TransitRoute;
      stops?: SwissRouteStop[];
      tripIds?: string[];
    }>(observedRouteCacheKey(routeId));
    if (!cached?.route) return null;
    const entry: SwissObservedRouteEntry = {
      expiresAt: Date.now() + SWISS_OBSERVED_ROUTE_TTL_MS,
      hintStopIds: uniqueStrings(cached.hintStopIds ?? []),
      operatorRefs: uniqueStrings(cached.operatorRefs ?? []),
      route: cached.route,
      stops: cached.stops?.length ? cached.stops : undefined,
      tripIds: uniqueStrings(cached.tripIds ?? []),
    };
    observedRoutes.set(routeId, entry);
    return entry;
  } catch {
    return null;
  }
}

async function activeSwissGtfsSchemaName(): Promise<string | null> {
  if (!swissGtfsDeps?.manager.initialized) return null;
  const activeFeed = swissGtfsDeps.manager
    .getFeeds()
    .find(
      (feed) =>
        feed.status === "active" &&
        feed.source === "opentransportdata-swiss" &&
        feed.countryCode?.toLowerCase() === "ch",
    );
  return activeFeed?.schemaName ?? null;
}

async function ensureSwissStaticFeed(): Promise<string | null> {
  if (!swissGtfsDeps) return null;
  if (swissGtfsDeps.ensureSwissOfficialFeed) {
    try {
      await swissGtfsDeps.ensureSwissOfficialFeed();
    } catch (error) {
      getSwissTransitConfig().log?.warn?.("Swiss GTFS static feed ensure failed", error);
    }
  }
  return activeSwissGtfsSchemaName();
}

function staticGtfsMode(routeType: number, fallback: TransportMode): TransportMode {
  const raw = swissGtfsDeps?.queries.routeTypeToMode(routeType);
  return mapSwissMode(raw) ?? fallback;
}

function collectSwissStaticStopRefs(
  rawRef: string | undefined,
  datasets: SwissStopDatasets,
): string[] {
  if (!rawRef) return [];
  const identity = resolveSwissStopIdentity(rawRef, datasets);
  return uniqueStrings([
    rawRef,
    identity.didok,
    identity.servicePointSloid,
    identity.stopPointSloid,
  ]);
}

function buildTransitStopFromSwissGtfsStop(
  row: SwissGtfsTripStop,
  datasets: SwissStopDatasets,
  mode: TransportMode,
): SwissRouteStop {
  const rawRef = row.original_stop_id || row.stop_id;
  const identity = resolveSwissStopIdentity(rawRef, datasets);
  const canonicalRawRef = identity.stopPointSloid ?? identity.didok ?? rawRef;
  const ids = buildStopIds(canonicalRawRef, {
    didok: identity.didok,
    servicePointSloid: identity.servicePointSloid,
  });
  return {
    id: providerId(canonicalRawRef),
    ...(ids.primaryScheme ? { primaryScheme: ids.primaryScheme } : {}),
    ...(ids.ids ? { ids: ids.ids } : {}),
    lat: row.stop_lat,
    lng: row.stop_lon,
    modes: [mode],
    name: row.stop_name || canonicalRawRef,
    parentStationId:
      identity.servicePointSloid && canonicalRawRef !== identity.servicePointSloid
        ? providerId(identity.servicePointSloid)
        : undefined,
    platformCode: row.platform_code ?? platformCodeFromRef(rawRef),
    provider: PROVIDER,
    sequence: row.stop_sequence,
  };
}

async function resolveSwissStaticRoutePattern(
  routeId: string,
  hintStopId?: string,
): Promise<{ route: TransitRoute; stops: SwissRouteStop[] } | null> {
  const observed = await getObservedRoute(routeId);
  const route = observed?.route;
  if (!route?.shortName) return null;

  const schema = await ensureSwissStaticFeed();
  if (!schema || !swissGtfsDeps) return null;

  const datasets = await loadSwissStopDatasets();
  const stopRefs = new Set<string>();
  const stopNames = new Set<string>();

  for (const stop of observed?.stops ?? []) {
    for (const ref of collectSwissStaticStopRefs(stripProviderPrefix(stop.id), datasets)) {
      stopRefs.add(ref);
    }
    if (stop.name) stopNames.add(stop.name.toLowerCase());
  }

  for (const stopCandidate of uniqueStrings([hintStopId, ...(observed?.hintStopIds ?? [])])) {
    const rawRef = stripProviderPrefix(stopCandidate);
    for (const ref of collectSwissStaticStopRefs(rawRef, datasets)) {
      stopRefs.add(ref);
    }
    const { servicePoint, stopPoint } = findServicePoint(rawRef, datasets);
    if (servicePoint?.name) stopNames.add(servicePoint.name.toLowerCase());
    if (stopPoint?.designationOfficial) stopNames.add(stopPoint.designationOfficial.toLowerCase());
  }

  const representative = await swissGtfsDeps.queries.findRepresentativeTrip(schema, {
    routeShortName: route.shortName,
    headsign: route.longName,
    operatorName: route.operatorName,
    stopRefs: [...stopRefs],
    stopNames: [...stopNames],
  });
  if (!representative) return null;

  const [stopRows, shapeRows] = await Promise.all([
    swissGtfsDeps.queries.getTripStops(schema, representative.trip_id),
    representative.shape_id
      ? swissGtfsDeps.queries.getShapePoints(schema, representative.shape_id)
      : Promise.resolve([]),
  ]);
  if (!stopRows.length) return null;

  const mode = staticGtfsMode(representative.route_type, route.mode);
  const staticRoute = mergeTransitRoute(route, {
    id: route.id,
    shortName: route.shortName || representative.route_short_name,
    longName:
      representative.trip_headsign ||
      representative.route_long_name ||
      route.longName ||
      route.shortName,
    mode,
    operatorName:
      route.operatorName || representative.agency_name || "OpenTransportData Switzerland",
    ...(representative.route_color ? { color: representative.route_color } : {}),
    ...(representative.route_text_color ? { textColor: representative.route_text_color } : {}),
    ...(shapeRows.length > 1
      ? {
          geometry: {
            type: "LineString" as const,
            coordinates: shapeRows.map((point) => [point.shape_pt_lon, point.shape_pt_lat]),
          },
        }
      : {}),
  });
  const stops = stopRows.map((row) => buildTransitStopFromSwissGtfsStop(row, datasets, mode));
  await rememberObservedRoute(staticRoute, {
    hintStopId,
    operatorRefs: observed?.operatorRefs,
    stops,
    tripId: representative.trip_id,
  });
  return { route: staticRoute, stops };
}

function buildTransitStopFromServicePoint(
  servicePoint: SwissServicePoint,
  rawRef = servicePoint.didok ?? servicePoint.servicePointSloid,
): TransitStop {
  const ids = buildStopIds(rawRef, {
    didok: servicePoint.didok,
    servicePointSloid: servicePoint.servicePointSloid,
  });
  return {
    id: providerId(rawRef),
    ...(ids.primaryScheme ? { primaryScheme: ids.primaryScheme } : {}),
    ...(ids.ids ? { ids: ids.ids } : {}),
    lat: servicePoint.lat,
    lng: servicePoint.lng,
    modes: servicePointModes(servicePoint),
    name: servicePoint.name,
    provider: PROVIDER,
  };
}

function buildTransitStopFromTrafficPoint(
  trafficPoint: SwissTrafficPoint,
  servicePoint: SwissServicePoint,
): TransitStop {
  const ids = buildStopIds(trafficPoint.sloid, {
    didok: servicePoint.didok,
    servicePointSloid: servicePoint.servicePointSloid,
  });
  return {
    id: providerId(trafficPoint.sloid),
    ...(ids.primaryScheme ? { primaryScheme: ids.primaryScheme } : {}),
    ...(ids.ids ? { ids: ids.ids } : {}),
    lat: trafficPoint.lat,
    lng: trafficPoint.lng,
    modes: servicePointModes(servicePoint),
    name: trafficPoint.designation
      ? `${servicePoint.name} ${trafficPoint.designation}`
      : trafficPoint.designationOfficial || servicePoint.name,
    parentStationId: providerId(servicePoint.servicePointSloid),
    platformCode: trafficPoint.designation || platformCodeFromRef(trafficPoint.sloid),
    provider: PROVIDER,
  };
}

function mapOjpPlaceToStop(place: OjpPlace, datasets: SwissStopDatasets): TransitStop {
  const rawRef = place.stopPointRef ?? place.stopPlaceRef ?? place.ref;
  const { didok, servicePoint, servicePointSloid, stopPoint } = findServicePoint(rawRef, datasets);
  const ids = buildStopIds(rawRef, { didok, servicePointSloid });
  return {
    id: providerId(rawRef),
    ...(ids.primaryScheme ? { primaryScheme: ids.primaryScheme } : {}),
    ...(ids.ids ? { ids: ids.ids } : {}),
    lat: place.lat || stopPoint?.lat || servicePoint?.lat || 0,
    lng: place.lng || stopPoint?.lng || servicePoint?.lng || 0,
    modes: servicePointModes(servicePoint, place.modes),
    name: place.name || stopPoint?.designationOfficial || servicePoint?.name || rawRef,
    parentStationId:
      place.placeType === "stop_point" && servicePoint
        ? providerId(servicePoint.servicePointSloid)
        : undefined,
    platformCode: platformCodeFromRef(place.stopPointRef),
    provider: PROVIDER,
  };
}

function dedupePreferredPlaces(places: OjpPlace[], datasets: SwissStopDatasets): OjpPlace[] {
  const byKey = new Map<string, OjpPlace>();
  for (const place of places) {
    if (!["stop_place", "stop_point"].includes(place.placeType)) continue;
    const rawRef = place.stopPointRef ?? place.stopPlaceRef ?? place.ref;
    const key =
      resolveSwissStopIdentity(rawRef, datasets).servicePointSloid ??
      place.stopPlaceRef ??
      place.stopPointRef ??
      place.ref;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, place);
      continue;
    }
    if (existing.placeType !== "stop_place" && place.placeType === "stop_place") {
      byKey.set(key, place);
      continue;
    }
    if ((place.probability ?? 0) > (existing.probability ?? 0)) {
      byKey.set(key, place);
    }
  }
  return [...byKey.values()];
}

async function requestLocationInformationByQuery(
  query: string,
  limit: number,
): Promise<OjpPlace[]> {
  const xml = buildOjpLocationInformationRequestXml({
    includePtModes: true,
    language: getSwissTransitConfig().requestLanguage,
    limit,
    query,
    requestorRef: getSwissTransitConfig().requestorRef,
    types: ["stop"],
  });
  return parseOjpLocationInformationResponse(
    await requestSwissOjp(xml, {
      cacheNamespace: "location-query",
      cacheTtlSeconds: 3600,
    }),
  ).places;
}

async function requestLocationInformationByRef(rawRef: string): Promise<OjpPlace[]> {
  const xml = buildOjpLocationInformationRequestXml({
    includePtModes: true,
    language: getSwissTransitConfig().requestLanguage,
    limit: 20,
    placeRef:
      rawRef.startsWith("ch:1:sloid:") && rawRef.split(":").length > 4
        ? { stopPointRef: rawRef }
        : /^\d+$/.test(rawRef)
          ? { stopPlaceRef: rawRef }
          : rawRef.startsWith("ch:1:sloid:")
            ? { stopPlaceRef: rawRef }
            : { stopPointRef: rawRef },
    requestorRef: getSwissTransitConfig().requestorRef,
    types: ["stop"],
  });
  return parseOjpLocationInformationResponse(
    await requestSwissOjp(xml, {
      cacheNamespace: "location-ref",
      cacheTtlSeconds: 3600,
    }),
  ).places;
}

async function requestNearbyLocations(
  lat: number,
  lng: number,
  radiusMeters: number,
  limit: number,
): Promise<OjpPlace[]> {
  const xml = buildOjpLocationInformationRequestXml({
    geoRestrictionCircleMeters: radiusMeters,
    includePtModes: true,
    language: getSwissTransitConfig().requestLanguage,
    limit,
    placeRef: {
      geoPosition: { latitude: lat, longitude: lng },
    },
    requestorRef: getSwissTransitConfig().requestorRef,
    types: ["stop"],
  });
  return parseOjpLocationInformationResponse(
    await requestSwissOjp(xml, {
      cacheNamespace: "location-nearby",
      cacheTtlSeconds: 3600,
    }),
  ).places;
}

function computeDelaySeconds(
  scheduled: string | undefined,
  expected: string | undefined,
): number | undefined {
  if (!scheduled || !expected) return undefined;
  const delta = Math.round((new Date(expected).getTime() - new Date(scheduled).getTime()) / 1000);
  return Number.isFinite(delta) && delta !== 0 ? delta : undefined;
}

function buildRouteFromService(
  service: OjpService | undefined,
  operatorMetadata?: SwissBusinessOrganisation,
): TransitRoute | null {
  const shortName = routeShortNameFromService(service);
  const mode = mapSwissMode(service?.ptMode ?? service?.productCategoryShortName);
  if (!shortName || !mode) return null;
  const routeId = routeIdFromService(service);
  if (!routeId) return null;
  return {
    id: routeId,
    longName: service?.destinationText || shortName,
    mode,
    operatorName:
      operatorMetadata?.description ||
      operatorMetadata?.abbreviation ||
      service?.operatorRef ||
      "OpenTransportData Switzerland",
    shortName,
  };
}

function buildRouteFromStopEvent(
  stopEvent: OjpStopEvent,
  operatorMetadata?: SwissBusinessOrganisation,
): TransitRoute | null {
  return buildRouteFromService(stopEvent.service, operatorMetadata);
}

function buildDepartureFromStopEvent(
  stopEvent: OjpStopEvent,
  type: "departure" | "arrival",
  route = buildRouteFromStopEvent(stopEvent),
  operatorMetadata?: SwissBusinessOrganisation,
): Departure | null {
  const service = stopEvent.service;
  const serviceInfo = mapOjpServiceInfo(service, operatorMetadata);
  if (!service || !route) return null;
  const call = stopEvent.thisCall;
  if (!call) return null;
  const scheduledAt = type === "departure" ? call.departureTimetabled : call.arrivalTimetabled;
  const expectedAt = type === "departure" ? call.departureEstimated : call.arrivalEstimated;
  if (!scheduledAt) return null;
  const tripId =
    service.operatingDayRef && service.journeyRef
      ? providerId(`${service.operatingDayRef}|${service.journeyRef}`)
      : providerId(service.journeyRef || `${route.id}:${scheduledAt}`);
  return {
    delaySeconds: computeDelaySeconds(scheduledAt, expectedAt),
    expectedAt,
    formation: mapOjpFormation(service.datedTrainNumberRefs),
    headsign: service.destinationText || route.longName || route.shortName,
    occupancy:
      mapSwissOccupancy(service.occupancy) ??
      mapSwissOccupancy(type === "departure" ? call.departureOccupancy : call.arrivalOccupancy),
    platform: call.estimatedQuay || call.plannedQuay,
    remarks: serviceRemarks(service),
    route: {
      id: route.id,
      longName: route.longName,
      mode: route.mode,
      shortName: route.shortName,
    },
    scheduledAt,
    serviceInfo,
    tripId,
  };
}

function scoreSwissOccupancySection(
  section: SwissOccupancyForecastSection,
  options: {
    dayShift?: number;
    stopRefs: Set<string>;
    stopName?: string;
    time?: string;
  },
): number {
  let score = 0;
  if (options.dayShift != null && section.departureDayShift === options.dayShift) score += 8;
  if (section.departureStationId && options.stopRefs.has(section.departureStationId)) score += 10;
  if (
    options.stopName &&
    normalizeText(section.departureStationName).toLowerCase() === options.stopName.toLowerCase()
  ) {
    score += 4;
  }
  if (options.time && section.departureTime === options.time) score += 6;
  return score;
}

function swissOccupancyTrainKeys(serviceInfo: TransitServiceInfo): Set<string> {
  const keys = new Set<string>();
  for (const candidate of uniqueStrings([
    serviceInfo.trainNumber,
    ...(serviceInfo.formation ?? []).map((ref) => ref.trainNumber),
  ])) {
    const normalized = normalizeText(candidate);
    if (normalized) keys.add(normalized);
    const extracted = extractSwissTrainNumber(candidate);
    if (extracted) keys.add(extracted);
  }
  return keys;
}

function swissForecastTrainKeys(train: SwissOccupancyForecastTrain): Set<string> {
  const keys = new Set<string>();
  const normalized = normalizeText(train.trainNumber);
  if (normalized) keys.add(normalized);
  const extracted = extractSwissTrainNumber(train.trainNumber);
  if (extracted) keys.add(extracted);
  return keys;
}

async function resolveSwissOccupancyForecast(
  serviceInfo: TransitServiceInfo | undefined,
  options: {
    scheduledAt?: string;
    stopId?: string;
    stopName?: string;
  } = {},
): Promise<{
  occupancy: OccupancyLevel;
  occupancyClasses?: TransitServiceInfo["occupancyClasses"];
  occupancyRaw: string;
  occupancyUpdatedAt?: string;
  source: string;
} | null> {
  if (!serviceInfo?.operatorOrganisationNumber || !serviceInfo.operatingDayRef) {
    return null;
  }

  const dataset = await loadSwissOccupancyForecastDataset(
    serviceInfo.operatingDayRef,
    serviceInfo.operatorOrganisationNumber,
  ).catch(() => null);
  if (!dataset?.trains?.length) return null;

  const trainKeys = swissOccupancyTrainKeys(serviceInfo);
  const journeyRef = normalizeText(serviceInfo.journeyRef);
  const lineRef = normalizeText(serviceInfo.lineRef);
  if (trainKeys.size === 0 && !journeyRef && !lineRef) {
    return null;
  }

  const trains = dataset.trains.filter((train) => {
    if ([...swissForecastTrainKeys(train)].some((key) => trainKeys.has(key))) {
      return true;
    }
    if (journeyRef && normalizeText(train.journeyRef) === journeyRef) {
      return true;
    }
    if (lineRef && normalizeText(train.lineRef) === lineRef) {
      return true;
    }
    return false;
  });
  if (!trains.length) return null;

  const datasets = options.stopId ? await loadSwissStopDatasets().catch(() => null) : null;
  const stopRefs = new Set<string>(
    options.stopId && datasets
      ? collectSwissStaticStopRefs(stripProviderPrefix(options.stopId), datasets)
      : [],
  );
  const stopName = normalizeText(options.stopName);
  const time = swissDateTimeParts(options.scheduledAt)?.time;
  const dayShift = swissDayShift(options.scheduledAt, serviceInfo.operatingDayRef);

  let bestSection: SwissOccupancyForecastSection | null = null;
  let bestTrainScore = -1;
  let bestSectionScore = -1;

  for (const train of trains) {
    let trainScore = 0;
    if ([...swissForecastTrainKeys(train)].some((key) => trainKeys.has(key))) {
      trainScore += 6;
    }
    if (journeyRef && normalizeText(train.journeyRef) === journeyRef) {
      trainScore += 4;
    }
    if (lineRef && normalizeText(train.lineRef) === lineRef) {
      trainScore += 2;
    }

    const sections = train.sections ?? [];
    if (!sections.length) continue;
    const scoredSections = sections
      .map((section) => ({
        score: scoreSwissOccupancySection(section, {
          dayShift,
          stopName,
          stopRefs,
          time,
        }),
        section,
      }))
      .sort((left, right) => right.score - left.score);
    const bestForTrain = scoredSections[0];
    if (!bestForTrain) continue;
    if (
      trainScore > bestTrainScore ||
      (trainScore === bestTrainScore && bestForTrain.score > bestSectionScore)
    ) {
      bestTrainScore = trainScore;
      bestSectionScore = bestForTrain.score;
      bestSection = bestForTrain.section;
    }
  }

  const levels =
    bestSection?.expectedDepartureOccupancies ?? bestSection?.expectedArrivalOccupancies;
  const classes = mapSwissForecastOccupancyClasses(levels);
  const occupancy = pickSwissForecastOccupancy(classes);
  if (!occupancy) return null;

  return {
    occupancy,
    occupancyClasses: classes,
    occupancyRaw:
      levels?.find((level) => normalizeText(level.fareClass).toLowerCase() === "secondclass")
        ?.occupancyLevel ||
      levels?.[0]?.occupancyLevel ||
      occupancy,
    occupancyUpdatedAt: dataset.lastUpdated,
    source: "opentransportdata.swiss/occupancy-forecast",
  };
}

function applySwissOccupancyForecastToServiceInfo(
  serviceInfo: TransitServiceInfo | undefined,
  forecast: {
    occupancy: OccupancyLevel;
    occupancyClasses?: TransitServiceInfo["occupancyClasses"];
    occupancyRaw: string;
    occupancyUpdatedAt?: string;
    source: string;
  } | null,
): TransitServiceInfo | undefined {
  if (!serviceInfo || !forecast) return serviceInfo;
  return {
    ...serviceInfo,
    occupancy: serviceInfo.occupancy ?? forecast.occupancy,
    occupancyClasses: serviceInfo.occupancyClasses ?? forecast.occupancyClasses,
    occupancyRaw: serviceInfo.occupancyRaw ?? forecast.occupancyRaw,
    occupancySource: serviceInfo.occupancySource ?? forecast.source,
    occupancyUpdatedAt: serviceInfo.occupancyUpdatedAt ?? forecast.occupancyUpdatedAt,
  };
}

async function requestStopEvents(
  rawRef: string,
  minutes: number,
  stopEventType: "departure" | "arrival",
) {
  const xml = buildOjpStopEventRequestXml({
    includeAllRestrictedLines: true,
    includeOnwardCalls: true,
    includePreviousCalls: true,
    language: getSwissTransitConfig().requestLanguage,
    numberOfResults: Math.min(Math.max(minutes, 10), 120),
    requestorRef: getSwissTransitConfig().requestorRef,
    stopEventType,
    stopRef: rawRef,
    useRealtimeData: "full",
    dateTime: new Date().toISOString(),
  });
  return parseOjpStopEventResponse(
    await requestSwissOjp(xml, {
      cacheNamespace: `stop-events:${stopEventType}`,
      cacheTtlSeconds: stopEventType === "departure" ? 30 : 60,
    }),
  );
}

function computeTripDurationSeconds(result: OjpTripResult): number {
  if (result.durationSeconds) return result.durationSeconds;
  if (result.startTime && result.endTime) {
    return Math.max(
      0,
      Math.round(
        (new Date(result.endTime).getTime() - new Date(result.startTime).getTime()) / 1000,
      ),
    );
  }
  return 0;
}

function mapOjpFareProduct(product: OjpFareProduct): FareProduct | null {
  if (product.amount == null || !product.currency) return null;
  return {
    amount: product.amount,
    authorityName: product.authorityName,
    authorityRef: product.authorityRef,
    currency: product.currency,
    id: product.id,
    infoUrls: product.infoUrls,
    name: product.name,
    netAmount: product.netAmount,
    saleUrls: product.saleUrls,
    travelClass: product.travelClass,
    vatRate: product.vatRate,
  };
}

function mapOjpFareBundle(
  fareResult: OjpFareResult | undefined,
  trip: OjpTripResult,
): SwissMappedFareBundle | undefined {
  if (!fareResult?.trips.length) return undefined;

  const tripLegIds = trip.legs.map((leg) => leg.id);
  const legAssignments = new Map<string, SwissFareAssignment>();
  const results: NonNullable<TripFare["results"]> = [];
  for (const [effectiveFareLegIndex, fareTrip] of fareResult.trips.entries()) {
    const products = fareTrip.products
      .map(mapOjpFareProduct)
      .filter((value): value is FareProduct => Boolean(value));
    if (!products.length) continue;

    const startIndex = fareTrip.fromLegId ? tripLegIds.indexOf(fareTrip.fromLegId) : -1;
    const endIndex = fareTrip.toLegId ? tripLegIds.indexOf(fareTrip.toLegId) : startIndex;
    if (startIndex >= 0) {
      const finalIndex = endIndex >= startIndex ? endIndex : startIndex;
      for (let legIndex = startIndex; legIndex <= finalIndex; legIndex += 1) {
        const legId = tripLegIds[legIndex];
        if (!legId) continue;
        legAssignments.set(legId, {
          effectiveFareLegIndex,
          fareTransferIndex: 0,
        });
      }
    }

    results.push({
      fromLegId: fareTrip.fromLegId,
      products,
      toLegId: fareTrip.toLegId,
    });
  }
  if (!results.length) return undefined;

  const transferProducts = results.flatMap((result) => result.products);
  return {
    fare: {
      results,
      source: "ojpfare",
      transfers: [
        {
          legProducts: results.map((result) => [result.products]),
          rule: fareResult.id,
          transferProducts: transferProducts.length ? transferProducts : undefined,
        },
      ],
    },
    legAssignments,
  };
}

async function requestTripFares(
  response: OjpTripResponse,
  rawTrips: XmlObject[],
): Promise<Array<OjpFareResult | undefined>> {
  const config = getSwissTransitConfig();
  return Promise.all(
    response.trips.map(async (trip, index) => {
      const rawTrip = rawTrips[index];
      if (!rawTrip || !trip.legs.some((leg) => leg.kind === "timed")) return undefined;

      try {
        const xml = buildOjpFareRequestXml({
          fareAuthorityFilter: "ch:1:NOVA",
          language: config.requestLanguage,
          requestorRef: config.requestorRef,
          trips: [rawTrip],
        });
        return parseOjpFareResponse(
          await requestSwissOjpFare(xml, {
            cacheNamespace: "trip-fare",
            cacheTtlSeconds: 300,
          }),
        ).fares[0];
      } catch (error) {
        config.log?.warn?.("Swiss OJP fare request failed", trip.id ?? index, error);
        return undefined;
      }
    }),
  );
}

function mapOjpTripLeg(
  leg: OjpTripLeg,
  businessDatasets: SwissBusinessOrganisationDatasets,
  fareAssignment?: SwissFareAssignment,
): TripLeg {
  const routeShortName =
    leg.service?.publishedServiceName ||
    leg.service?.publishedLineName ||
    leg.service?.productCategoryShortName ||
    leg.service?.trainNumber;
  const operatorMetadata = mapSwissOperatorMetadata(leg.service, businessDatasets);
  const serviceInfo = mapOjpServiceInfo(leg.service, operatorMetadata);
  const mode = leg.kind === "timed" ? mapSwissMode(leg.service?.ptMode) || "rail" : "walking";
  const tripId =
    leg.service?.operatingDayRef && leg.service?.journeyRef
      ? providerId(`${leg.service.operatingDayRef}|${leg.service.journeyRef}`)
      : undefined;
  const routeId = routeIdFromService(leg.service);
  return {
    _intermediateStopCount: leg.intermediateCalls.length,
    alightNameSuffix: leg.alightCall?.nameSuffix,
    boardNameSuffix: leg.boardCall?.nameSuffix,
    endTime:
      leg.alightCall?.arrivalEstimated ||
      leg.alightCall?.arrivalTimetabled ||
      leg.boardCall?.departureEstimated ||
      leg.boardCall?.departureTimetabled ||
      new Date().toISOString(),
    formation: mapOjpFormation(leg.service?.datedTrainNumberRefs),
    from: {
      lat: leg.start.lat,
      lng: leg.start.lng,
      name: leg.start.name,
      stopId: leg.start.stopPointRef ? providerId(leg.start.stopPointRef) : undefined,
    },
    geometry: legGeometry(leg),
    intermodal:
      leg.kind === "timed" &&
      !leg.guidanceTexts.length &&
      !leg.feasibility.length &&
      !leg.transferMode &&
      !leg.transferType &&
      leg.lengthMeters == null &&
      leg.walkDurationSeconds == null &&
      leg.bufferTimeSeconds == null &&
      !leg.situationIds.length
        ? undefined
        : {
            attributes: leg.attributeDetails.map((attribute) => ({
              accessFacility: attribute.accessFacility,
              code: attribute.code,
              text: attribute.text,
              userText: attribute.userText,
            })),
            bufferTimeSeconds: leg.bufferTimeSeconds,
            durationSeconds: leg.durationSeconds,
            feasibility: leg.feasibility,
            guidanceTexts: leg.guidanceTexts,
            lengthMeters: leg.lengthMeters,
            personalMode: leg.personalMode,
            situationIds: leg.situationIds,
            timeWindowEnd: leg.timeWindowEnd,
            timeWindowStart: leg.timeWindowStart,
            transferMode: leg.transferMode,
            transferType: leg.transferType,
            walkDurationSeconds: leg.walkDurationSeconds,
          },
    mode,
    effectiveFareLegIndex: fareAssignment?.effectiveFareLegIndex,
    fareTransferIndex: fareAssignment?.fareTransferIndex,
    occupancy:
      serviceInfo?.occupancy ??
      mapSwissOccupancy(leg.boardCall?.departureOccupancy) ??
      mapSwissOccupancy(leg.alightCall?.arrivalOccupancy),
    route:
      routeShortName && leg.service
        ? {
            longName: leg.service.destinationText || routeShortName,
            shortName: routeShortName,
          }
        : undefined,
    routeId,
    serviceInfo,
    startTime:
      leg.boardCall?.departureEstimated ||
      leg.boardCall?.departureTimetabled ||
      leg.alightCall?.arrivalEstimated ||
      leg.alightCall?.arrivalTimetabled ||
      new Date().toISOString(),
    to: {
      lat: leg.end.lat,
      lng: leg.end.lng,
      name: leg.end.name,
      stopId: leg.end.stopPointRef ? providerId(leg.end.stopPointRef) : undefined,
    },
    tripId,
  };
}

function mapTripResponseToPlan(
  response: OjpTripResponse,
  params: { from: { lat: number; lng: number }; to: { lat: number; lng: number } },
  businessDatasets: SwissBusinessOrganisationDatasets,
  fareResults?: Array<OjpFareResult | undefined>,
): TripPlan | null {
  const itineraries: TripItinerary[] = response.trips.map((trip, index) => {
    const fareBundle = mapOjpFareBundle(fareResults?.[index], trip);
    const legs = trip.legs.map((leg) =>
      mapOjpTripLeg(
        leg,
        businessDatasets,
        leg.id ? fareBundle?.legAssignments.get(leg.id) : undefined,
      ),
    );
    return {
      distanceMeters: trip.distanceMeters,
      duration: computeTripDurationSeconds(trip),
      endTime: trip.endTime || legs.at(-1)?.endTime || new Date().toISOString(),
      ...(fareBundle ? { fare: fareBundle.fare } : {}),
      legs,
      startTime: trip.startTime || legs[0]?.startTime || new Date().toISOString(),
      transfers:
        trip.transfers ?? Math.max(0, trip.legs.filter((leg) => leg.kind === "timed").length - 1),
      walkDistance: trip.legs
        .filter((leg) => leg.kind !== "timed")
        .reduce((sum, leg) => sum + (leg.lengthMeters ?? 0), 0),
    };
  });
  if (!itineraries.length) return null;
  return {
    from: {
      lat: params.from.lat,
      lng: params.from.lng,
      name: itineraries[0]?.legs[0]?.from.name || "Origin",
    },
    itineraries,
    provider: PROVIDER,
    to: {
      lat: params.to.lat,
      lng: params.to.lng,
      name: itineraries[0]?.legs.at(-1)?.to.name || "Destination",
    },
  };
}

async function enrichSwissTripPlanOccupancy(plan: TripPlan | null): Promise<TripPlan | null> {
  if (!plan) return null;
  const itineraries = await Promise.all(
    plan.itineraries.map(async (itinerary) => {
      const legs = await Promise.all(
        itinerary.legs.map(async (leg) => {
          if (leg.mode === "walking" || leg.occupancy || !leg.serviceInfo) return leg;
          const forecast = await resolveSwissOccupancyForecast(leg.serviceInfo, {
            scheduledAt: leg.startTime,
            stopId: leg.from.stopId,
            stopName: leg.from.name,
          });
          if (!forecast) return leg;
          return {
            ...leg,
            occupancy: leg.occupancy ?? forecast.occupancy,
            serviceInfo: applySwissOccupancyForecastToServiceInfo(leg.serviceInfo, forecast),
          };
        }),
      );
      return {
        ...itinerary,
        legs,
      };
    }),
  );
  return {
    ...plan,
    itineraries,
  };
}

function coordinatesFromTrackSections(
  sections: Array<{ coordinates: [number, number][] }>,
): [number, number][] {
  const merged: [number, number][] = [];
  for (const section of sections) {
    for (const coordinate of section.coordinates) {
      const last = merged.at(-1);
      if (!last || last[0] !== coordinate[0] || last[1] !== coordinate[1]) {
        merged.push(coordinate);
      }
    }
  }
  return merged;
}

function decodeSwissTripRef(
  tripId: string,
): { journeyRef: string; operatingDayRef: string; rawTripId: string } | null {
  const rawTripId = stripProviderPrefix(tripId);
  const separatorIndex = rawTripId.indexOf("|");
  if (separatorIndex <= 0) return null;
  return {
    journeyRef: rawTripId.slice(separatorIndex + 1),
    operatingDayRef: rawTripId.slice(0, separatorIndex),
    rawTripId,
  };
}

async function requestTripInfoByTripId(
  tripId: string,
  options: {
    includeCalls: boolean;
    includeLinkProjection: boolean;
    includeService: boolean;
    includeTrackSections: boolean;
  },
): Promise<{
  rawTripId: string;
  response: Awaited<ReturnType<typeof parseOjpTripInfoResponse>>;
} | null> {
  const decoded = decodeSwissTripRef(tripId);
  if (!decoded) return null;
  const xml = buildOjpTripInfoRequestXml({
    includeCalls: options.includeCalls,
    includeFormation: "simple",
    includeLinkProjection: options.includeLinkProjection,
    includePosition: true,
    includeService: options.includeService,
    includeSituationsContext: true,
    includeTrackSections: options.includeTrackSections,
    journeyRef: decoded.journeyRef,
    language: getSwissTransitConfig().requestLanguage,
    operatingDayRef: decoded.operatingDayRef,
    requestorRef: getSwissTransitConfig().requestorRef,
    useRealtimeData: "full",
  });
  return {
    rawTripId: decoded.rawTripId,
    response: parseOjpTripInfoResponse(
      await requestSwissOjp(xml, {
        cacheNamespace:
          options.includeCalls || options.includeService ? "trip-info-live" : "trip-info-static",
        cacheTtlSeconds: options.includeCalls || options.includeService ? 30 : 86400,
      }),
    ),
  };
}

function dedupeJourneyCalls(calls: OjpCall[]): OjpCall[] {
  const seen = new Set<string>();
  const deduped: OjpCall[] = [];
  for (const call of calls) {
    const key = [
      call.stopPointRef ?? "",
      call.order ?? "",
      call.arrivalTimetabled ?? "",
      call.departureTimetabled ?? "",
      call.arrivalEstimated ?? "",
      call.departureEstimated ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(call);
  }
  return deduped;
}

function stopEventCalls(stopEvent: OjpStopEvent): OjpCall[] {
  return dedupeJourneyCalls([
    ...stopEvent.previousCalls,
    ...(stopEvent.thisCall ? [stopEvent.thisCall] : []),
    ...stopEvent.onwardCalls,
  ]);
}

function mapJourneyStopFromCall(
  call: OjpCall,
  datasets: SwissStopDatasets,
): VehicleJourney["stops"][number] {
  const rawRef = call.stopPointRef;
  const { servicePoint, stopPoint } = rawRef ? findServicePoint(rawRef, datasets) : {};
  const scheduledArrival = call.arrivalTimetabled;
  const expectedArrival = call.arrivalEstimated;
  const scheduledDeparture = call.departureTimetabled;
  const expectedDeparture = call.departureEstimated;
  return {
    delaySeconds:
      computeDelaySeconds(scheduledDeparture, expectedDeparture) ??
      computeDelaySeconds(scheduledArrival, expectedArrival),
    expectedArrival,
    expectedDeparture,
    lat: call.geoPosition?.latitude ?? stopPoint?.lat ?? servicePoint?.lat ?? 0,
    lng: call.geoPosition?.longitude ?? stopPoint?.lng ?? servicePoint?.lng ?? 0,
    name: call.name || stopPoint?.designationOfficial || servicePoint?.name || rawRef || "Unknown",
    platform: call.estimatedQuay || call.plannedQuay,
    scheduledArrival,
    scheduledDeparture,
    stopId: rawRef ? providerId(rawRef) : providerId(call.name),
  };
}

function mapRouteStopFromCall(
  call: OjpCall,
  datasets: SwissStopDatasets,
  mode: TransportMode,
  sequence: number,
): SwissRouteStop {
  const rawRef = call.stopPointRef ?? `route-stop:${sequence}:${call.name ?? "unknown"}`;
  const { didok, servicePoint, servicePointSloid, stopPoint } = findServicePoint(rawRef, datasets);
  const ids = buildStopIds(rawRef, { didok, servicePointSloid });
  return {
    id: providerId(rawRef),
    ...(ids.primaryScheme ? { primaryScheme: ids.primaryScheme } : {}),
    ...(ids.ids ? { ids: ids.ids } : {}),
    lat: call.geoPosition?.latitude ?? stopPoint?.lat ?? servicePoint?.lat ?? 0,
    lng: call.geoPosition?.longitude ?? stopPoint?.lng ?? servicePoint?.lng ?? 0,
    modes: uniqueModes([mode, ...servicePointModes(servicePoint)]),
    name: call.name || stopPoint?.designationOfficial || servicePoint?.name || rawRef,
    parentStationId: servicePoint ? providerId(servicePoint.servicePointSloid) : undefined,
    platformCode: call.estimatedQuay || call.plannedQuay || platformCodeFromRef(call.stopPointRef),
    provider: PROVIDER,
    sequence,
  };
}

function routeStopsFromJourney(
  journey: VehicleJourney,
  mode: TransportMode | undefined,
): SwissRouteStop[] {
  return journey.stops.map((stop, index) => ({
    id: stop.stopId,
    lat: stop.lat,
    lng: stop.lng,
    modes: mode ? [mode] : [],
    name: stop.name,
    platformCode: stop.platform,
    provider: PROVIDER,
    sequence: index + 1,
  }));
}

function matchesStopRef(
  candidate: string | undefined,
  targetRawRef: string | undefined,
  datasets: SwissStopDatasets,
): boolean {
  if (!candidate || !targetRawRef) return false;
  if (candidate === targetRawRef) return true;
  const candidateIdentity = resolveSwissStopIdentity(candidate, datasets);
  const targetIdentity = resolveSwissStopIdentity(targetRawRef, datasets);
  if (
    candidateIdentity.servicePointSloid &&
    targetIdentity.servicePointSloid &&
    candidateIdentity.servicePointSloid === targetIdentity.servicePointSloid
  ) {
    return true;
  }
  return Boolean(
    candidateIdentity.didok &&
      targetIdentity.didok &&
      candidateIdentity.didok === targetIdentity.didok,
  );
}

function addAccessibilityItem(
  items: TransitAccessibilityItem[],
  seen: Set<string>,
  category: TransitAccessibilityItem["category"],
  label: string,
  available: boolean | undefined,
): void {
  if (available == null) return;
  const key = `${category}:${label}`;
  if (seen.has(key)) return;
  seen.add(key);
  items.push({
    available,
    category,
    id: key,
    label,
  });
}

function buildPlatformAccessibilityLabels(record: SwissFlatCsvRecord | undefined): string[] {
  if (!record) return [];
  const labels: string[] = [];
  if (record.levelAccessWheelchair && record.levelAccessWheelchair !== "NO") {
    labels.push(`Wheelchair: ${record.levelAccessWheelchair}`);
  }
  if (parseBoolean(record.dynamicAudio)) labels.push("Dynamic audio information");
  if (parseBoolean(record.dynamicVisual)) labels.push("Dynamic visual information");
  if (parseBoolean(record.contrastingAreas)) labels.push("Contrasting areas");
  if (parseBoolean(record.tactileSystems)) labels.push("Tactile guidance");
  if (record.vehicleAccess && record.vehicleAccess !== "NO") {
    labels.push(`Vehicle access: ${record.vehicleAccess}`);
  }
  return labels;
}

function buildPlatforms(
  trafficPoints: SwissTrafficPoint[],
  servicePoint: SwissServicePoint,
  datasets: SwissStopDatasets,
): TransitPlatformDetail[] {
  const platformCandidates = trafficPoints.filter(
    (point) => point.trafficPointElementType === "BOARDING_PLATFORM",
  );
  const points = platformCandidates.length > 0 ? platformCandidates : trafficPoints;
  return points.map((trafficPoint) => {
    const accessibility = datasets.platformAccessibilityBySloid.get(trafficPoint.sloid);
    return {
      accessibilityLabels: buildPlatformAccessibilityLabels(accessibility),
      id: providerId(trafficPoint.sloid),
      lat: trafficPoint.lat,
      lng: trafficPoint.lng,
      modes: servicePointModes(servicePoint),
      name: trafficPoint.designation
        ? `${servicePoint.name} platform ${trafficPoint.designation}`
        : trafficPoint.designationOfficial || servicePoint.name,
      parentStopId: providerId(servicePoint.servicePointSloid),
      publicCode: trafficPoint.designation || platformCodeFromRef(trafficPoint.sloid),
    };
  });
}

function buildChildStopAreas(
  trafficPoints: SwissTrafficPoint[],
  servicePoint: SwissServicePoint,
): TransitStopAreaSummary[] {
  const groups = new Map<string, SwissTrafficPoint[]>();
  for (const trafficPoint of trafficPoints) {
    const key = trafficPoint.parentSloid || trafficPoint.sloid;
    const existing = groups.get(key);
    if (existing) {
      existing.push(trafficPoint);
    } else {
      groups.set(key, [trafficPoint]);
    }
  }
  return [...groups.entries()].map(([groupId, members]) => {
    const lat = members.reduce((sum, point) => sum + point.lat, 0) / members.length;
    const lng = members.reduce((sum, point) => sum + point.lng, 0) / members.length;
    const first = members[0];
    const suffix = first.designation || groupId.split(":").at(-1) || "";
    return {
      id: providerId(groupId),
      lat,
      level: "child_stop",
      lng,
      modes: servicePointModes(servicePoint),
      name: suffix ? `${servicePoint.name} ${suffix}` : servicePoint.name,
      parentStopId: providerId(servicePoint.servicePointSloid),
      stopType: first.trafficPointElementType,
    };
  });
}

function deriveStationIntelligence(input: {
  childStops: TransitStopAreaSummary[];
  parentStop?: TransitStopAreaSummary;
  parking: TransitStopParking[];
  platforms: TransitPlatformDetail[];
  siblingStops: TransitStopAreaSummary[];
}): TransitStationIntelligence {
  const modeSet = new Set<TransportMode>([
    ...(input.parentStop?.modes ?? []),
    ...input.childStops.flatMap((stop) => stop.modes),
    ...input.platforms.flatMap((platform) => platform.modes),
    ...input.siblingStops.flatMap((stop) => stop.modes),
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
    hasParking: input.parking.length > 0,
    hasRealtimeParking: input.parking.some(
      (parking) => parking.hasRealtimeData && typeof parking.freeSpaces === "number",
    ),
    modeCount,
  };
}

function buildParking(
  servicePoint: SwissServicePoint,
  records: SwissFlatCsvRecord[],
): TransitStopParking[] {
  return records.map((record) => {
    const capacityMatch = normalizeText(record.additionalInformation).match(/(\d+)\s*\/\s*(\d+)/);
    return {
      capacity: capacityMatch ? Number(capacityMatch[1]) : undefined,
      hasRealtimeData: false,
      id: providerId(record.sloid || `${servicePoint.servicePointSloid}:parking`),
      kind: "parking",
      lat: servicePoint.lat,
      lng: servicePoint.lng,
      name: record.designation || "Parking",
      vehicleTypes: ["car"],
    };
  });
}

function buildStopInfrastructureFacts(
  servicePoint: SwissServicePoint,
  stopPointRecord: SwissFlatCsvRecord | undefined,
  contactPoints: SwissFlatCsvRecord[],
  referencePoints: SwissFlatCsvRecord[],
): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  if (servicePoint.businessOrganisationDescription || servicePoint.abbreviation) {
    facts.push({
      label: "Operator",
      value: servicePoint.businessOrganisationDescription || servicePoint.abbreviation || "",
    });
  }
  if (servicePoint.didok) {
    facts.push({ label: "DIDOK", value: servicePoint.didok });
  }
  facts.push({ label: "SLOID", value: servicePoint.servicePointSloid });
  if (servicePoint.localityName || servicePoint.municipalityName) {
    facts.push({
      label: "Location",
      value: [servicePoint.localityName, servicePoint.municipalityName].filter(Boolean).join(", "),
    });
  }
  if (stopPointRecord?.assistanceAvailability) {
    facts.push({
      label: "Assistance",
      value: stopPointRecord.assistanceAvailability,
    });
  }
  if (stopPointRecord?.alternativeTransport) {
    facts.push({
      label: "Alternative transport",
      value: stopPointRecord.alternativeTransport,
    });
  }
  if (stopPointRecord?.url) {
    facts.push({ label: "Information", value: stopPointRecord.url });
  }
  if (contactPoints.length > 0) {
    facts.push({ label: "Contact points", value: String(contactPoints.length) });
  }
  if (referencePoints.length > 0) {
    facts.push({ label: "Reference points", value: String(referencePoints.length) });
  }
  return facts;
}

function buildAccessibility(
  stopPointRecord: SwissFlatCsvRecord | undefined,
  platforms: TransitPlatformDetail[],
  relations: SwissFlatCsvRecord[],
  contactPoints: SwissFlatCsvRecord[],
  toilets: SwissFlatCsvRecord[],
): TransitAccessibilityItem[] {
  const items: TransitAccessibilityItem[] = [];
  const seen = new Set<string>();
  addAccessibilityItem(
    items,
    seen,
    "audible",
    "Dynamic audio information",
    parseBoolean(stopPointRecord?.dynamicAudioSystem) ??
      platforms.some((platform) =>
        platform.accessibilityLabels?.includes("Dynamic audio information"),
      ),
  );
  addAccessibilityItem(
    items,
    seen,
    "visual",
    "Dynamic visual information",
    parseBoolean(stopPointRecord?.dynamicOpticSystem) ??
      parseBoolean(stopPointRecord?.visualInfo) ??
      platforms.some((platform) =>
        platform.accessibilityLabels?.includes("Dynamic visual information"),
      ),
  );
  addAccessibilityItem(
    items,
    seen,
    "wheelchair",
    "Wheelchair ticket machine",
    parseBoolean(stopPointRecord?.wheelchairTicketMachine),
  );
  addAccessibilityItem(
    items,
    seen,
    "wheelchair",
    "Step-free access",
    relations.some((relation) => relation.stepFreeAccess === "YES"),
  );
  addAccessibilityItem(
    items,
    seen,
    "audible",
    "Induction loop",
    contactPoints.some((record) => parseBoolean(record.inductionLoop) === true),
  );
  addAccessibilityItem(
    items,
    seen,
    "wheelchair",
    "Wheelchair-accessible toilet",
    toilets.some((record) => parseBoolean(record.wheelchairToilet) === true),
  );
  addAccessibilityItem(
    items,
    seen,
    "other",
    "Interoperable assistance",
    parseBoolean(stopPointRecord?.interoperable),
  );
  return items;
}

function buildAmenities(
  stopPointRecord: SwissFlatCsvRecord | undefined,
  contactPoints: SwissFlatCsvRecord[],
  toilets: SwissFlatCsvRecord[],
  parking: TransitStopParking[],
): TransitAmenityItem[] {
  const amenities: TransitAmenityItem[] = [];
  if (toilets.length > 0) {
    amenities.push({
      category: "toilets",
      count: toilets.length,
      id: "toilets",
      label: "Toilets",
    });
  }
  if (
    parseBoolean(stopPointRecord?.ticketMachine) ||
    parseBoolean(stopPointRecord?.audioTicketMachine) ||
    parseBoolean(stopPointRecord?.wheelchairTicketMachine)
  ) {
    amenities.push({
      category: "ticketing",
      id: "ticketing",
      label: "Ticket machines",
    });
  }
  if (contactPoints.length > 0) {
    amenities.push({
      category: "other",
      count: contactPoints.length,
      id: "contact-points",
      label: "Information desks",
    });
  }
  if (parking.length > 0) {
    amenities.push({
      category: "parking",
      count: parking.length,
      id: "parking",
      label: "Parking",
    });
  }
  return amenities;
}

function translatedText(
  value: { translation?: Array<{ text?: string }> } | undefined,
): string | undefined {
  return value?.translation?.find((entry) => entry.text)?.text;
}

function pickSiriText(
  values: Array<{ language?: string; value: string }> | undefined,
  preferredLanguage = getSwissTransitConfig().requestLanguage,
): string | undefined {
  if (!values?.length) return undefined;
  const normalized = normalizeText(preferredLanguage).toLowerCase();
  if (normalized) {
    const exact = values.find((value) => value.language?.toLowerCase() === normalized);
    if (exact) return exact.value;
    const base = normalized.split("-")[0];
    const partial = values.find((value) => {
      const language = value.language?.toLowerCase();
      return language === base || language?.startsWith(`${base}-`);
    });
    if (partial) return partial.value;
  }
  return values[0]?.value;
}

function mapGtfsAlertSeverity(alert: {
  effect?: string;
  severityLevel?: string;
}): ServiceAlert["severity"] {
  const severity = String(alert.severityLevel ?? "").toUpperCase();
  const effect = String(alert.effect ?? "").toUpperCase();
  if (severity === "SEVERE" || severity === "UNKNOWN_SEVERITY") return "severe";
  if (effect === "NO_SERVICE" || effect === "STOP_MOVED" || effect === "SIGNIFICANT_DELAYS") {
    return "critical";
  }
  if (effect === "DETOUR" || effect === "REDUCED_SERVICE") return "severe";
  if (severity === "WARNING") return "warning";
  return "info";
}

function mapSiriAlertSeverity(situation: SiriSituation): ServiceAlert["severity"] {
  const severity = normalizeText(situation.severity).toLowerCase();
  const consequenceEffects = situation.consequences
    .map((consequence) => normalizeText(consequence.effect).toLowerCase())
    .filter(Boolean);
  const consequenceSeverities = situation.consequences
    .map((consequence) => normalizeText(consequence.severity).toLowerCase())
    .filter(Boolean);
  if (
    severity.includes("critical") ||
    consequenceSeverities.some((value) => value.includes("critical")) ||
    consequenceEffects.some((value) =>
      ["no_service", "noservice", "stopmoved", "stop_moved", "stationclosed"].includes(value),
    )
  ) {
    return "critical";
  }
  if (
    severity.includes("severe") ||
    consequenceSeverities.some((value) => value.includes("severe")) ||
    consequenceEffects.some((value) =>
      ["significantdelays", "detour", "reducedservice", "lineclosed"].includes(value),
    )
  ) {
    return "severe";
  }
  if (
    severity.includes("warning") ||
    consequenceSeverities.some((value) => value.includes("warning"))
  ) {
    return "warning";
  }
  return "info";
}

function hashSwissAlert(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function mapAffectedSwissStopIds(rawStopRefs: string[], datasets: SwissStopDatasets): string[] {
  const affectedStopIds = new Set<string>();
  for (const rawStopRef of rawStopRefs) {
    affectedStopIds.add(providerId(rawStopRef));
    const identity = resolveSwissStopIdentity(rawStopRef, datasets);
    if (identity.didok) affectedStopIds.add(providerId(identity.didok));
    if (identity.servicePointSloid) affectedStopIds.add(providerId(identity.servicePointSloid));
  }
  return [...affectedStopIds];
}

function mapGtfsAlert(
  entity: SwissGtfsEntity,
  datasets: SwissStopDatasets,
): SwissMappedAlert | null {
  const alert = entity.alert;
  if (!alert) return null;
  const informed = alert.informedEntity ?? [];
  const rawStopRefs = Array.from(
    new Set(
      informed.map((entry) => entry.stopId).filter((value): value is string => Boolean(value)),
    ),
  );
  const rawRouteRefs = Array.from(
    new Set(
      informed.map((entry) => entry.routeId).filter((value): value is string => Boolean(value)),
    ),
  );
  const activePeriods: ServiceAlert["activePeriods"] = (alert.activePeriod ?? [])
    .map((period) => ({
      end: gtfsRtTimestampToIso(period.end),
      start: gtfsRtTimestampToIso(period.start) || new Date().toISOString(),
    }))
    .filter((period) => Boolean(period.start));
  return {
    activePeriods,
    affectedRouteIds: rawRouteRefs.map((routeId) => providerId(`gtfs-route:${routeId}`)),
    affectedStopIds: mapAffectedSwissStopIds(rawStopRefs, datasets),
    description: translatedText(alert.descriptionText) || translatedText(alert.ttsDescriptionText),
    effect: alert.effect,
    id: providerId(`alert:${entity.id ?? hashSwissAlert(alert)}`),
    providers: [PROVIDER],
    rawOperatorRefs: [],
    rawRouteRefs,
    rawStopRefs,
    severity: mapGtfsAlertSeverity(alert),
    title:
      translatedText(alert.headerText) ||
      translatedText(alert.ttsHeaderText) ||
      translatedText(alert.descriptionText) ||
      "Service alert",
  } satisfies SwissMappedAlert;
}

function mapSiriSituation(situation: SiriSituation, datasets: SwissStopDatasets): SwissMappedAlert {
  const rawStopRefs = uniqueStrings([...situation.stopPointRefs, ...situation.stopPlaceRefs]);
  const rawRouteRefs = uniqueStrings([...situation.lineRefs, ...situation.routeRefs]);
  const descriptions = uniqueStrings([
    pickSiriText(situation.descriptions),
    ...situation.consequences.map((consequence) => consequence.advice),
  ]);
  const activePeriods = uniqueStrings([
    ...situation.validityPeriods.map((period) => period.startTime),
    ...situation.publicationWindows.map((period) => period.startTime),
  ]).map((start) => {
    const validity =
      situation.validityPeriods.find((period) => period.startTime === start) ??
      situation.publicationWindows.find((period) => period.startTime === start);
    return {
      end: validity?.endTime,
      start,
    };
  });
  const title = pickSiriText(situation.summaries) || descriptions[0] || "Service alert";
  return {
    activePeriods: activePeriods.length
      ? activePeriods
      : [{ start: situation.creationTime || new Date().toISOString() }],
    affectedRouteIds: rawRouteRefs.map((ref) => providerId(ref)),
    affectedStopIds: mapAffectedSwissStopIds(rawStopRefs, datasets),
    description: descriptions[0],
    effect:
      situation.consequences.find((consequence) => consequence.effect)?.effect ||
      situation.reportType,
    id: providerId(
      `siri-alert:${
        situation.id ||
        situation.situationNumber ||
        hashSwissAlert({
          rawRouteRefs,
          rawStopRefs,
          title,
        })
      }`,
    ),
    providers: [PROVIDER],
    rawOperatorRefs: uniqueStrings(situation.operatorRefs),
    rawRouteRefs,
    rawStopRefs,
    severity: mapSiriAlertSeverity(situation),
    title,
  };
}

function dedupeSwissMappedAlerts(alerts: SwissMappedAlert[]): SwissMappedAlert[] {
  const merged = new Map<string, SwissMappedAlert>();
  for (const alert of alerts) {
    const existing = merged.get(alert.id);
    if (!existing) {
      merged.set(alert.id, alert);
      continue;
    }
    merged.set(alert.id, {
      ...existing,
      activePeriods: [...existing.activePeriods, ...alert.activePeriods],
      affectedRouteIds: uniqueStrings([...existing.affectedRouteIds, ...alert.affectedRouteIds]),
      affectedStopIds: uniqueStrings([...existing.affectedStopIds, ...alert.affectedStopIds]),
      description: existing.description || alert.description,
      effect: existing.effect || alert.effect,
      rawOperatorRefs: uniqueStrings([...existing.rawOperatorRefs, ...alert.rawOperatorRefs]),
      rawRouteRefs: uniqueStrings([...existing.rawRouteRefs, ...alert.rawRouteRefs]),
      rawStopRefs: uniqueStrings([...existing.rawStopRefs, ...alert.rawStopRefs]),
      title: existing.title || alert.title,
    });
  }
  return [...merged.values()];
}

async function loadGtfsMappedAlerts(datasets: SwissStopDatasets): Promise<SwissMappedAlert[]> {
  try {
    const feed = await fetchSwissGtfsSaFeed();
    const entities = (feed.entity ?? []) as SwissGtfsEntity[];
    return entities
      .map((entity) => mapGtfsAlert(entity, datasets))
      .filter((alert): alert is SwissMappedAlert => alert !== null);
  } catch (error) {
    getSwissTransitConfig().log?.warn?.("Swiss GTFS-SA alert feed failed", error);
    return [];
  }
}

async function loadSiriMappedAlerts(datasets: SwissStopDatasets): Promise<SwissMappedAlert[]> {
  const feeds = await Promise.all([
    fetchSwissSiriSxFeed("complete")
      .then((xml) => listSiriSituations(xml))
      .catch((error) => {
        getSwissTransitConfig().log?.warn?.("Swiss SIRI-SX feed failed", error);
        return [] as SiriSituation[];
      }),
    fetchSwissSiriSxFeed("unplanned")
      .then((xml) => listSiriSituations(xml))
      .catch((error) => {
        getSwissTransitConfig().log?.warn?.("Swiss SIRI-SX unplanned feed failed", error);
        return [] as SiriSituation[];
      }),
  ]);
  return feeds.flat().map((situation) => mapSiriSituation(situation, datasets));
}

async function loadMappedAlerts(): Promise<SwissMappedAlert[]> {
  const datasets = await loadSwissStopDatasets();
  return dedupeSwissMappedAlerts([
    ...(await loadGtfsMappedAlerts(datasets)),
    ...(await loadSiriMappedAlerts(datasets)),
  ]);
}

function alertMatchesStop(
  alert: SwissMappedAlert,
  rawStopRef: string,
  datasets: SwissStopDatasets,
): boolean {
  return alert.rawStopRefs.some((candidate) => matchesStopRef(candidate, rawStopRef, datasets));
}

function alertCoordinates(
  alert: SwissMappedAlert,
  datasets: SwissStopDatasets,
): Array<[number, number]> {
  const coordinates: Array<[number, number]> = [];
  for (const rawStopRef of alert.rawStopRefs) {
    const { servicePoint, stopPoint } = findServicePoint(rawStopRef, datasets);
    if (stopPoint) {
      coordinates.push([stopPoint.lng, stopPoint.lat]);
      continue;
    }
    if (servicePoint) {
      coordinates.push([servicePoint.lng, servicePoint.lat]);
    }
  }
  return coordinates;
}

function normalizeSwissRouteAlertKey(value: string | undefined): string | null {
  const normalized = normalizeText(value)
    .replace(/^gtfs-route:/, "")
    .replace(/^otdch:/, "");
  if (!normalized) return null;
  return normalized.toLowerCase().replace(/[^a-z0-9:|_-]+/g, "");
}

function alertMatchesRoute(
  alert: SwissMappedAlert,
  routeId: string,
  observed: SwissObservedRouteEntry | null,
): boolean {
  const routeKeys = new Set(
    [
      normalizeSwissRouteAlertKey(stripProviderPrefix(routeId)),
      normalizeSwissRouteAlertKey(observed?.route.shortName),
      normalizeSwissRouteAlertKey(observed?.route.longName),
    ].filter((value): value is string => Boolean(value)),
  );
  const directMatch = alert.rawRouteRefs.some((ref) =>
    routeKeys.has(normalizeSwissRouteAlertKey(ref) ?? ""),
  );
  if (directMatch) return true;

  if (!observed?.operatorRefs.length || !alert.rawOperatorRefs.length) return false;
  const observedOperatorKeys = new Set(
    observed.operatorRefs
      .map((value) => normalizeSwissLookupKey(value))
      .filter((value): value is string => Boolean(value)),
  );
  const operatorMatch = alert.rawOperatorRefs.some((ref) =>
    observedOperatorKeys.has(normalizeSwissLookupKey(ref) ?? ""),
  );
  if (!operatorMatch) return false;
  return alert.rawRouteRefs.length === 0 || routeKeys.size === 0;
}

function stopMatchKeys(rawRef: string | undefined, datasets: SwissStopDatasets): string[] {
  const normalized = normalizeText(rawRef);
  if (!normalized) return [];
  const keys = new Set<string>([normalized]);
  const identity = resolveSwissStopIdentity(normalized, datasets);
  if (identity.didok) keys.add(identity.didok);
  if (identity.servicePointSloid) keys.add(identity.servicePointSloid);
  if (/^\d+:[^:]+/.test(normalized)) {
    keys.add(normalized.split(":")[0] || normalized);
  }
  return [...keys];
}

function scheduleRelationshipIsCanceled(value: string | undefined): boolean {
  const normalized = normalizeText(value).toUpperCase();
  return normalized === "CANCELED" || normalized === "SKIPPED";
}

function deriveGtfsExpectedTime(
  event: SwissGtfsTripUpdateStopTimeEvent | undefined,
  scheduledAt: string,
): string | undefined {
  const absolute = gtfsRtTimestampToIso(event?.time);
  if (absolute) return absolute;
  const delaySeconds = parseNumeric(event?.delay);
  if (delaySeconds == null) return undefined;
  return new Date(new Date(scheduledAt).getTime() + delaySeconds * 1000).toISOString();
}

function applyGtfsTripUpdateOverlay(
  departure: Departure,
  boardStopRef: string,
  kind: "departure" | "arrival",
  feed: GtfsRtFeedObject,
  datasets: SwissStopDatasets,
): Departure {
  const scheduledAt = departure.scheduledAt;
  const scheduledDate = normalizeSwissOperatingDate(scheduledAt.slice(0, 10));
  const boardKeys = new Set(stopMatchKeys(boardStopRef, datasets));
  const entities = (feed.entity ?? []) as Array<{ tripUpdate?: SwissGtfsTripUpdate }>;
  let bestMatch: {
    canceled: boolean;
    delaySeconds?: number;
    expectedAt?: string;
    score: number;
  } | null = null;

  for (const entity of entities) {
    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate?.stopTimeUpdate?.length) continue;
    const tripDate = normalizeSwissOperatingDate(tripUpdate.trip?.startDate);
    if (tripDate && scheduledDate && tripDate !== scheduledDate) continue;

    for (const update of tripUpdate.stopTimeUpdate) {
      const updateKeys = stopMatchKeys(update.stopId, datasets);
      if (!updateKeys.some((key) => boardKeys.has(key))) continue;
      const event =
        kind === "departure"
          ? (update.departure ?? update.arrival)
          : (update.arrival ?? update.departure);
      if (!event && !scheduleRelationshipIsCanceled(update.scheduleRelationship)) continue;
      const expectedAt = event ? deriveGtfsExpectedTime(event, scheduledAt) : undefined;
      const canceled =
        scheduleRelationshipIsCanceled(update.scheduleRelationship) ||
        scheduleRelationshipIsCanceled(event?.scheduleRelationship) ||
        scheduleRelationshipIsCanceled(tripUpdate.trip?.scheduleRelationship);
      const delaySeconds =
        event?.delay != null
          ? parseNumeric(event.delay)
          : computeDelaySeconds(scheduledAt, expectedAt);
      const diffMs = expectedAt
        ? Math.abs(new Date(expectedAt).getTime() - new Date(scheduledAt).getTime())
        : canceled
          ? 0
          : Number.POSITIVE_INFINITY;
      if (diffMs > 20 * 60 * 1000 && !canceled) continue;
      if (!bestMatch || diffMs < bestMatch.score) {
        bestMatch = {
          canceled,
          ...(delaySeconds != null ? { delaySeconds } : {}),
          ...(expectedAt ? { expectedAt } : {}),
          score: diffMs,
        };
      }
    }
  }

  if (!bestMatch) return departure;
  return {
    ...departure,
    canceled: departure.canceled || bestMatch.canceled,
    delaySeconds:
      departure.delaySeconds == null && bestMatch.delaySeconds != null
        ? bestMatch.delaySeconds
        : departure.delaySeconds,
    expectedAt: departure.expectedAt || bestMatch.expectedAt,
    serviceInfo: departure.serviceInfo
      ? {
          ...departure.serviceInfo,
          canceled: departure.serviceInfo.canceled || bestMatch.canceled,
        }
      : departure.serviceInfo,
  };
}

function extractSwissTrainNumber(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  if (/^\d+$/.test(normalized)) return normalized;
  const matches = [...normalized.matchAll(/(\d{1,6})/g)];
  return matches.at(-1)?.[1];
}

function resolveSwissFormationEvu(
  operatorMetadata: SwissBusinessOrganisation | undefined,
  operatorRefs: string[],
): string | undefined {
  const organisationNumber =
    operatorMetadata?.organisationNumber ??
    operatorRefs.map((ref) => extractSwissOrganisationNumber(ref)).find(Boolean);
  if (organisationNumber) {
    const byOrganisation = SWISS_FORMATION_EVU_BY_ORGANISATION_NUMBER[organisationNumber];
    if (byOrganisation) return byOrganisation;
  }

  const abbreviations = uniqueStrings([operatorMetadata?.abbreviation, ...operatorRefs]);
  for (const abbreviation of abbreviations) {
    const normalized = normalizeSwissLookupKey(abbreviation);
    if (!normalized) continue;
    const direct = SWISS_FORMATION_EVU_BY_ABBREVIATION[normalized];
    if (direct) return direct;
    const root = SWISS_FORMATION_EVU_BY_ABBREVIATION[normalized.split("-")[0] || normalized];
    if (root) return root;
  }
  return undefined;
}

function buildSwissFormationRequest(
  service: OjpService | undefined,
  operatorMetadata: SwissBusinessOrganisation | undefined,
): { evu: string; operationDate: string; trainNumber: string } | null {
  if (!service) return null;
  const operatorRefs = collectServiceOperatorRefs(service);
  const evu = resolveSwissFormationEvu(operatorMetadata, operatorRefs);
  const operationDate = normalizeSwissOperatingDate(
    service.operatingDayRef ?? service.datedTrainNumberRefs?.[0]?.operatingDayRef,
  );
  const trainNumber = uniqueStrings([
    service.trainNumber,
    ...(service.datedTrainNumberRefs ?? []).map((ref) => ref.trainNumber),
    service.publishedServiceName,
    service.publishedLineName,
  ])
    .map((value) => extractSwissTrainNumber(value))
    .find((value): value is string => Boolean(value));
  if (!evu || !operationDate || !trainNumber) return null;
  return { evu, operationDate, trainNumber };
}

function mapSwissFormationStopId(
  stopPoint: SwissFormationStopPoint | undefined,
  datasets: SwissStopDatasets,
): string | undefined {
  const rawRef = normalizeText(stopPoint?.uic);
  if (!rawRef) return undefined;
  const identity = resolveSwissStopIdentity(rawRef, datasets);
  return providerId(identity.didok || identity.servicePointSloid || rawRef);
}

function mapSwissFormationDetails(
  journey: SwissFormationJourneyResponse,
  datasets: SwissStopDatasets,
  evu: string,
): TransitFormationDetail | undefined {
  const formations = journey.formations ?? [];
  const stops = (journey.formationsAtScheduledStops ?? []).map((entry) => ({
    platform: entry.scheduledStop?.track,
    scheduledAt: entry.scheduledStop?.stopTime,
    shortFormation: entry.formationShort?.formationShortString,
    stopId: mapSwissFormationStopId(entry.scheduledStop?.stopPoint, datasets),
    stopName: entry.scheduledStop?.stopPoint?.designationOfficial,
  }));
  const vehicles = formations.flatMap((formation) =>
    (formation.formationVehicles ?? []).map((vehicle) => {
      const meta = vehicle.vehicleMetaInformation ?? vehicle.metaInformation;
      const stop = firstDefined(
        ...(vehicle.formationVehicleStops ?? []).map((entry) => entry.sector),
      );
      return {
        bikeSpaces: vehicle.vehicleProperties?.numberBicycleHooks,
        closed: vehicle.vehicleProperties?.closed,
        hasAirConditioning: vehicle.vehicleProperties?.climated,
        hasLowFloorAccess: vehicle.vehicleProperties?.lowFloor,
        hasToilet: vehicle.vehicleProperties?.toilet,
        id: meta?.id,
        lengthMeters: meta?.length,
        order: meta?.order,
        sector: stop,
        seatsFirstClass: vehicle.vehicleProperties?.numberFirstClassSeats,
        seatsSecondClass: vehicle.vehicleProperties?.numberSecondClassSeats,
        typeCode: meta?.vehicleTypeAbbreviation,
        typeName: meta?.vehicleTypeDesignation,
        wheelchairSpaces: vehicle.vehicleProperties?.numberWheelchairPlaces,
      };
    }),
  );
  const shortFormation = stops.find((stop) => stop.shortFormation)?.shortFormation;
  const totalSeats = formations.reduce(
    (sum, formation) => sum + (formation.metaInformation?.numberSeats ?? 0),
    0,
  );
  const vehicleCount = formations.reduce(
    (sum, formation) => sum + (formation.metaInformation?.numberVehicles ?? 0),
    0,
  );
  const lengthMeters = formations.reduce(
    (sum, formation) => sum + (formation.metaInformation?.length ?? 0),
    0,
  );
  if (!stops.length && !vehicles.length && !vehicleCount && !lengthMeters && !totalSeats) {
    return undefined;
  }
  return {
    lastUpdate: journey.lastUpdate,
    ...(lengthMeters > 0 ? { lengthMeters } : {}),
    operatorCode: evu,
    operationDate: journey.journeyMetaInformation?.operationDate,
    ...(totalSeats > 0 ? { seats: totalSeats } : {}),
    ...(shortFormation ? { shortFormation } : {}),
    source: "opentransportdata.swiss/formation",
    ...(stops.length ? { stops } : {}),
    trainNumber: journey.trainMetaInformation?.trainNumber,
    ...(vehicleCount > 0 ? { vehicleCount } : {}),
    ...(vehicles.length ? { vehicles } : {}),
  };
}

export function setOpenTransportDataChConfig(config: SwissTransitConfig): void {
  observedRoutes.clear();
  setSwissTransitConfig(config);
}

export function setSwissGtfsDeps(deps: SwissGtfsDeps | null): void {
  swissGtfsDeps = deps;
}

export async function isOpenTransportDataChAvailable(): Promise<boolean> {
  return probeSwissOjp();
}

export async function searchByName(query: string, limit: number): Promise<TransitStop[]> {
  const datasets = await loadSwissStopDatasets();
  if (isSwissTransitConfigured()) {
    try {
      return dedupePreferredPlaces(
        await requestLocationInformationByQuery(query, limit * 3),
        datasets,
      )
        .slice(0, limit)
        .map((place) => mapOjpPlaceToStop(place, datasets));
    } catch {
      // fall back to the static master-data snapshot
    }
  }
  return (await searchSwissServicePoints(query, limit)).map((servicePoint) =>
    buildTransitStopFromServicePoint(servicePoint),
  );
}

export async function getStopsNearby(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  const datasets = await loadSwissStopDatasets();
  if (isSwissTransitConfigured()) {
    try {
      return dedupePreferredPlaces(
        await requestNearbyLocations(lat, lng, Math.min(radiusMeters, 5_000), 80),
        datasets,
      ).map((place) => mapOjpPlaceToStop(place, datasets));
    } catch {
      // fall back to the static snapshot
    }
  }
  return (await findSwissNearbyServicePoints(lat, lng, radiusMeters)).map((servicePoint) =>
    buildTransitStopFromServicePoint(servicePoint),
  );
}

export async function getStop(stopId: string): Promise<TransitStop | null> {
  const datasets = await loadSwissStopDatasets();
  const rawRef = stripProviderPrefix(stopId);
  if (isSwissTransitConfigured()) {
    try {
      const places = await requestLocationInformationByRef(rawRef);
      const exact = places.find((place) => {
        const placeRaw = place.stopPointRef ?? place.stopPlaceRef ?? place.ref;
        return matchesStopRef(placeRaw, rawRef, datasets);
      });
      if (exact) return mapOjpPlaceToStop(exact, datasets);
    } catch {
      // fall back to master data
    }
  }

  const { servicePoint, stopPoint } = findServicePoint(rawRef, datasets);
  if (stopPoint && servicePoint) {
    return buildTransitStopFromTrafficPoint(stopPoint, servicePoint);
  }
  if (servicePoint) {
    return buildTransitStopFromServicePoint(servicePoint, rawRef);
  }
  return null;
}

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  const rawRef = stripProviderPrefix(stopId);
  const cutoff = Date.now() + minutes * 60_000;
  const [response, datasets, businessDatasets, gtfsRtFeed] = await Promise.all([
    requestStopEvents(rawRef, minutes, "departure"),
    loadSwissStopDatasets(),
    loadSwissBusinessOrganisationDatasets(),
    fetchSwissGtfsRtFeed().catch(() => null),
  ]);
  const departures: Departure[] = [];
  for (const stopEvent of response.stopEvents) {
    const operatorMetadata = mapSwissOperatorMetadata(stopEvent.service, businessDatasets);
    const route = buildRouteFromStopEvent(stopEvent, operatorMetadata);
    let departure = buildDepartureFromStopEvent(stopEvent, "departure", route, operatorMetadata);
    if (!departure) continue;
    if (gtfsRtFeed) {
      departure = applyGtfsTripUpdateOverlay(departure, rawRef, "departure", gtfsRtFeed, datasets);
    }
    if (!departure.occupancy && !departure.serviceInfo?.occupancy) {
      const occupancyForecast = await resolveSwissOccupancyForecast(departure.serviceInfo, {
        scheduledAt: departure.scheduledAt,
        stopId,
        stopName: stopEvent.thisCall?.name,
      });
      if (occupancyForecast) {
        departure = {
          ...departure,
          occupancy: departure.occupancy ?? occupancyForecast.occupancy,
          serviceInfo: applySwissOccupancyForecastToServiceInfo(
            departure.serviceInfo,
            occupancyForecast,
          ),
        };
      }
    }
    if (new Date(departure.scheduledAt).getTime() > cutoff) continue;
    departures.push(departure);
    if (route) {
      await rememberObservedRoute(route, {
        hintStopId: stopId,
        operatorRefs: collectServiceOperatorRefs(stopEvent.service),
        tripId: departure.tripId,
      });
    }
  }
  return departures;
}

export async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  const rawRef = stripProviderPrefix(stopId);
  const cutoff = Date.now() + minutes * 60_000;
  const [response, datasets, businessDatasets, gtfsRtFeed] = await Promise.all([
    requestStopEvents(rawRef, minutes, "arrival"),
    loadSwissStopDatasets(),
    loadSwissBusinessOrganisationDatasets(),
    fetchSwissGtfsRtFeed().catch(() => null),
  ]);
  const arrivals: Departure[] = [];
  for (const stopEvent of response.stopEvents) {
    const operatorMetadata = mapSwissOperatorMetadata(stopEvent.service, businessDatasets);
    const route = buildRouteFromStopEvent(stopEvent, operatorMetadata);
    let arrival = buildDepartureFromStopEvent(stopEvent, "arrival", route, operatorMetadata);
    if (!arrival) continue;
    if (gtfsRtFeed) {
      arrival = applyGtfsTripUpdateOverlay(arrival, rawRef, "arrival", gtfsRtFeed, datasets);
    }
    if (!arrival.occupancy && !arrival.serviceInfo?.occupancy) {
      const occupancyForecast = await resolveSwissOccupancyForecast(arrival.serviceInfo, {
        scheduledAt: arrival.scheduledAt,
        stopId,
        stopName: stopEvent.thisCall?.name,
      });
      if (occupancyForecast) {
        arrival = {
          ...arrival,
          occupancy: arrival.occupancy ?? occupancyForecast.occupancy,
          serviceInfo: applySwissOccupancyForecastToServiceInfo(
            arrival.serviceInfo,
            occupancyForecast,
          ),
        };
      }
    }
    if (new Date(arrival.scheduledAt).getTime() > cutoff) continue;
    arrivals.push(arrival);
    if (route) {
      await rememberObservedRoute(route, {
        hintStopId: stopId,
        operatorRefs: collectServiceOperatorRefs(stopEvent.service),
        tripId: arrival.tripId,
      });
    }
  }
  return arrivals;
}

export async function getRoutesForStop(stopId: string): Promise<TransitRoute[]> {
  const [datasets, businessDatasets] = await Promise.all([
    loadSwissStopDatasets(),
    loadSwissBusinessOrganisationDatasets(),
  ]);
  const rawRef = stripProviderPrefix(stopId);
  const response = await requestStopEvents(rawRef, 120, "departure");
  const routes = new Map<string, TransitRoute>();
  for (const stopEvent of response.stopEvents) {
    const operatorMetadata = mapSwissOperatorMetadata(stopEvent.service, businessDatasets);
    const route = buildRouteFromStopEvent(stopEvent, operatorMetadata);
    const departure = buildDepartureFromStopEvent(stopEvent, "departure", route, operatorMetadata);
    if (!route) continue;
    routes.set(route.id, mergeTransitRoute(routes.get(route.id), route));
    const stops = stopEventCalls(stopEvent).map((call, index) =>
      mapRouteStopFromCall(call, datasets, route.mode, index + 1),
    );
    await rememberObservedRoute(route, {
      hintStopId: stopId,
      operatorRefs: collectServiceOperatorRefs(stopEvent.service),
      ...(stops.length > 0 ? { stops } : {}),
      tripId: departure?.tripId,
    });
  }
  return [...routes.values()];
}

export async function getRoute(routeId: string): Promise<TransitRoute | null> {
  const staticRoute = await resolveSwissStaticRoutePattern(routeId).catch(() => null);
  if (staticRoute?.route) return staticRoute.route;
  return (await getObservedRoute(routeId))?.route ?? null;
}

export async function getRouteStops(
  routeId: string,
  hintStopId?: string,
): Promise<Array<TransitStop & { sequence: number }>> {
  const staticRoute = await resolveSwissStaticRoutePattern(routeId, hintStopId).catch(() => null);
  if (staticRoute?.stops.length) return staticRoute.stops;

  const observed = await getObservedRoute(routeId);
  if (observed?.stops?.length) return observed.stops;

  const routeMode = observed?.route.mode;
  const tripCandidates = uniqueStrings(observed?.tripIds ?? []);
  for (const tripId of tripCandidates) {
    const journey = await getVehicleJourney(tripId);
    if (!journey) continue;
    const stops = routeStopsFromJourney(journey, routeMode);
    if (stops.length > 0) {
      const rememberedRoute = observed?.route ?? {
        id: routeId,
        shortName: stripProviderPrefix(routeId),
        longName: stripProviderPrefix(routeId),
        mode: routeMode ?? "rail",
        operatorName: "OpenTransportData Switzerland",
      };
      await rememberObservedRoute(rememberedRoute, {
        hintStopId,
        operatorRefs: observed?.operatorRefs,
        stops,
        tripId,
      });
      return stops;
    }
  }

  const stopCandidates = uniqueStrings([hintStopId, ...(observed?.hintStopIds ?? [])]);
  for (const stopCandidate of stopCandidates) {
    const rawRef = stripProviderPrefix(stopCandidate);
    const response = await requestStopEvents(rawRef, 120, "departure").catch(() => null);
    const matching = response?.stopEvents.find((stopEvent) => {
      const route = buildRouteFromStopEvent(stopEvent);
      return route?.id === routeId;
    });
    if (!matching) continue;

    const matchedRoute = buildRouteFromStopEvent(matching);
    if (matchedRoute) {
      await rememberObservedRoute(matchedRoute, {
        hintStopId: stopCandidate,
        operatorRefs: collectServiceOperatorRefs(matching.service),
      });
      const resolvedStatic = await resolveSwissStaticRoutePattern(routeId, stopCandidate).catch(
        () => null,
      );
      if (resolvedStatic?.stops.length) return resolvedStatic.stops;
    }

    const departure = buildDepartureFromStopEvent(matching, "departure", matchedRoute);
    if (!departure?.tripId) continue;

    const journey = await getVehicleJourney(departure.tripId);
    if (!journey) continue;
    const latestObserved = await getObservedRoute(routeId);
    if (latestObserved?.stops?.length) return latestObserved.stops;

    const stops = routeStopsFromJourney(journey, routeMode);
    if (stops.length > 0 && latestObserved?.route) {
      await rememberObservedRoute(latestObserved.route, {
        hintStopId: stopCandidate,
        operatorRefs: latestObserved.operatorRefs,
        stops,
        tripId: departure.tripId,
      });
    }
    return stops;
  }

  return [];
}

export async function planTrip(params: {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  departureTime?: string;
  arrivalTime?: string;
  modes?: string[];
}): Promise<TripPlan | null> {
  const businessDatasets = await loadSwissBusinessOrganisationDatasets();
  const itModesToCover = mapRequestedIntermodalModes(params.modes);
  const xml = buildOjpTripRequestXml({
    arrivalTime: params.arrivalTime,
    departureTime: params.departureTime,
    destination: {
      geoPosition: { latitude: params.to.lat, longitude: params.to.lng },
    },
    includeAccessibility: true,
    includeFormation: "simple",
    includeIntermediateStops: true,
    includeLegProjection: true,
    includeSituationsContext: true,
    includeTrackSections: true,
    includeTurnDescription: true,
    itModesToCover,
    language: getSwissTransitConfig().requestLanguage,
    numberOfResults: 5,
    origin: {
      geoPosition: { latitude: params.from.lat, longitude: params.from.lng },
    },
    requestorRef: getSwissTransitConfig().requestorRef,
    useRealtimeData: "full",
  });
  const tripXml = await requestSwissOjp(xml, {
    cacheNamespace: "trip-plan",
    cacheTtlSeconds: 300,
  });
  const tripResponse = parseOjpTripResponse(tripXml);
  const fareResults = await requestTripFares(tripResponse, extractOjpTripRequestTrips(tripXml));
  for (const trip of tripResponse.trips) {
    for (const leg of trip.legs) {
      if (leg.kind !== "timed") continue;
      const operatorMetadata = mapSwissOperatorMetadata(leg.service, businessDatasets);
      const route = buildRouteFromService(leg.service, operatorMetadata);
      const tripId =
        leg.service?.operatingDayRef && leg.service?.journeyRef
          ? providerId(`${leg.service.operatingDayRef}|${leg.service.journeyRef}`)
          : undefined;
      if (!route) continue;
      await rememberObservedRoute(route, {
        hintStopId: leg.boardCall?.stopPointRef
          ? providerId(leg.boardCall.stopPointRef)
          : undefined,
        operatorRefs: collectServiceOperatorRefs(leg.service),
        tripId,
      });
    }
  }
  return enrichSwissTripPlanOccupancy(
    mapTripResponseToPlan(tripResponse, params, businessDatasets, fareResults),
  );
}

export async function getLegGeometry(
  tripId: string,
  fromStopId?: string,
  toStopId?: string,
): Promise<GeoJSONLineString | null> {
  const tripInfoResult = await requestTripInfoByTripId(tripId, {
    includeCalls: false,
    includeLinkProjection: true,
    includeService: false,
    includeTrackSections: true,
  });
  const tripInfo = tripInfoResult?.response.tripInfo;
  if (!tripInfo?.trackSections.length) return null;
  const datasets = await loadSwissStopDatasets();
  const rawFrom = fromStopId ? stripProviderPrefix(fromStopId) : undefined;
  const rawTo = toStopId ? stripProviderPrefix(toStopId) : undefined;

  let collecting = !rawFrom;
  const selectedSections = [];
  for (const section of tripInfo.trackSections) {
    if (!collecting && matchesStopRef(section.startStopPointRef, rawFrom, datasets)) {
      collecting = true;
    }
    if (collecting) {
      selectedSections.push(section);
    }
    if (collecting && rawTo && matchesStopRef(section.endStopPointRef, rawTo, datasets)) {
      break;
    }
  }

  const coordinates = coordinatesFromTrackSections(
    selectedSections.length ? selectedSections : tripInfo.trackSections,
  );
  if (!coordinates.length) return null;
  return {
    coordinates,
    type: "LineString",
  };
}

export async function getVehicleJourney(
  tripId: string,
  fallbackIds: string[] = [],
): Promise<VehicleJourney | null> {
  const candidates = [tripId, ...fallbackIds].filter(
    (value, index, values) => values.indexOf(value) === index,
  );
  const [datasets, businessDatasets] = await Promise.all([
    loadSwissStopDatasets(),
    loadSwissBusinessOrganisationDatasets(),
  ]);

  for (const candidate of candidates) {
    const result = await requestTripInfoByTripId(candidate, {
      includeCalls: true,
      includeLinkProjection: false,
      includeService: true,
      includeTrackSections: false,
    }).catch(() => null);
    const tripInfo = result?.response.tripInfo;
    if (!tripInfo) continue;

    const calls = dedupeJourneyCalls([...tripInfo.previousCalls, ...tripInfo.onwardCalls]);
    const operatorMetadata = mapSwissOperatorMetadata(tripInfo.service, businessDatasets);
    const serviceInfo = mapOjpServiceInfo(tripInfo.service, operatorMetadata);
    const route = buildRouteFromService(tripInfo.service, operatorMetadata);
    if (route) {
      await rememberObservedRoute(route, {
        operatorRefs: collectServiceOperatorRefs(tripInfo.service),
        stops: calls.map((call, index) =>
          mapRouteStopFromCall(call, datasets, route.mode, index + 1),
        ),
        tripId: candidate,
      });
    }
    let formationDetails: TransitFormationDetail | undefined;
    const formationRequest = buildSwissFormationRequest(tripInfo.service, operatorMetadata);
    if (
      formationRequest &&
      (route?.mode === "rail" || Boolean(tripInfo.service?.datedTrainNumberRefs?.length))
    ) {
      const formationJourney = await fetchSwissFormationJourney<SwissFormationJourneyResponse>(
        formationRequest,
      ).catch((error) => {
        getSwissTransitConfig().log?.warn?.(
          "Swiss formation lookup failed",
          formationRequest,
          error,
        );
        return null;
      });
      if (formationJourney) {
        formationDetails = mapSwissFormationDetails(
          formationJourney,
          datasets,
          formationRequest.evu,
        );
      }
    }
    const occupancyForecast =
      serviceInfo?.occupancy == null
        ? await resolveSwissOccupancyForecast(serviceInfo, {
            scheduledAt: calls[0]?.departureTimetabled ?? calls[0]?.arrivalTimetabled,
            stopId: calls[0]?.stopPointRef ? providerId(calls[0].stopPointRef) : undefined,
            stopName: calls[0]?.name,
          })
        : null;
    const resolvedServiceInfo = applySwissOccupancyForecastToServiceInfo(
      serviceInfo,
      occupancyForecast,
    );
    return {
      formation: mapOjpFormation(tripInfo.service?.datedTrainNumberRefs),
      ...(formationDetails ? { formationDetails } : {}),
      id: candidate,
      name:
        tripInfo.service?.publishedServiceName ||
        tripInfo.service?.publishedLineName ||
        tripInfo.service?.trainNumber ||
        candidate,
      occupancy:
        resolvedServiceInfo?.occupancy ??
        calls
          .map(
            (call) =>
              mapSwissOccupancy(call.departureOccupancy) ??
              mapSwissOccupancy(call.arrivalOccupancy),
          )
          .find((value): value is OccupancyLevel => value !== undefined),
      provider: PROVIDER,
      remarks: serviceRemarks(tripInfo.service),
      serviceInfo: resolvedServiceInfo,
      stops: calls.map((call) => mapJourneyStopFromCall(call, datasets)),
    };
  }

  return null;
}

export async function getStopPlatforms(stopId: string): Promise<TransitStop[]> {
  const datasets = await loadSwissStopDatasets();
  const rawRef = stripProviderPrefix(stopId);
  const { servicePoint, servicePointSloid } = findServicePoint(rawRef, datasets);
  if (!servicePoint || !servicePointSloid) return [];
  return (datasets.trafficPointsByServicePoint.get(servicePointSloid) ?? [])
    .filter((trafficPoint) =>
      ["BOARDING_PLATFORM", "BOARDING_AREA"].includes(trafficPoint.trafficPointElementType ?? ""),
    )
    .map((trafficPoint) => buildTransitStopFromTrafficPoint(trafficPoint, servicePoint));
}

export async function getStopInfrastructure(
  stopId: string,
): Promise<TransitStopInfrastructure | null> {
  const datasets = await loadSwissStopDatasets();
  const rawRef = stripProviderPrefix(stopId);
  const { servicePoint, servicePointSloid, stopPoint } = findServicePoint(rawRef, datasets);
  if (!servicePoint || !servicePointSloid) return null;

  const trafficPoints = datasets.trafficPointsByServicePoint.get(servicePointSloid) ?? [];
  const childStops = buildChildStopAreas(trafficPoints, servicePoint);
  const platforms = buildPlatforms(trafficPoints, servicePoint, datasets);
  const parking = buildParking(
    servicePoint,
    datasets.parkingLotsByServicePoint.get(servicePointSloid) ?? [],
  );
  const stopPointRecord = (datasets.stopPointAccessibilityByServicePoint.get(servicePointSloid) ??
    [])[0];
  const contactPoints = datasets.contactPointsByServicePoint.get(servicePointSloid) ?? [];
  const referencePoints = datasets.referencePointsByServicePoint.get(servicePointSloid) ?? [];
  const toilets = datasets.toiletsByServicePoint.get(servicePointSloid) ?? [];
  const relations = datasets.relationsByServicePoint.get(servicePointSloid) ?? [];

  const parentStopSummary: TransitStopAreaSummary = {
    id: providerId(servicePoint.servicePointSloid),
    lat: servicePoint.lat,
    level: "parent_stop",
    lng: servicePoint.lng,
    modes: servicePointModes(servicePoint),
    name: servicePoint.name,
    stopType: servicePoint.stopPointType,
  };

  const requestedStop: TransitStopAreaSummary = stopPoint
    ? {
        id: providerId(stopPoint.sloid),
        lat: stopPoint.lat,
        level: "platform",
        lng: stopPoint.lng,
        modes: servicePointModes(servicePoint),
        name: stopPoint.designation
          ? `${servicePoint.name} platform ${stopPoint.designation}`
          : stopPoint.designationOfficial || servicePoint.name,
        parentStopId: parentStopSummary.id,
        stopType: stopPoint.trafficPointElementType,
      }
    : {
        id: providerId(rawRef),
        lat: servicePoint.lat,
        level: "parent_stop",
        lng: servicePoint.lng,
        modes: servicePointModes(servicePoint),
        name: servicePoint.name,
        stopType: servicePoint.stopPointType,
      };

  const siblingStops = stopPoint
    ? childStops.filter((childStop) => childStop.parentStopId === parentStopSummary.id)
    : [];

  return {
    accessibility: buildAccessibility(
      stopPointRecord,
      platforms,
      relations,
      contactPoints,
      toilets,
    ),
    amenities: buildAmenities(stopPointRecord, contactPoints, toilets, parking),
    canonicalStop: parentStopSummary,
    childStops,
    displayName: requestedStop.name,
    facts: buildStopInfrastructureFacts(
      servicePoint,
      stopPointRecord,
      contactPoints,
      referencePoints,
    ),
    fareZones: [],
    focusLevel: requestedStop.level,
    parking,
    ...(stopPoint ? { parentStop: parentStopSummary } : {}),
    platforms,
    provider: PROVIDER,
    requestedStop,
    siblingStops,
    sourceId: servicePoint.servicePointSloid,
    stationIntelligence: deriveStationIntelligence({
      childStops,
      parentStop: parentStopSummary,
      parking,
      platforms,
      siblingStops,
    }),
    stopId,
    topographicPlace:
      servicePoint.localityName || servicePoint.municipalityName
        ? {
            id: `ch-locality:${servicePoint.localityName || servicePoint.municipalityName}`,
            name: servicePoint.localityName || servicePoint.municipalityName || "",
            placeType: "locality",
          }
        : undefined,
  };
}

export async function getAlerts(bbox: BBox): Promise<ServiceAlert[]> {
  if (!bboxOverlaps(bbox, SWITZERLAND_BBOX)) return [];
  const datasets = await loadSwissStopDatasets();
  return (await loadMappedAlerts())
    .filter((alert) => {
      const coordinates = alertCoordinates(alert, datasets);
      return coordinates.some(([lng, lat]) => bboxContains(bbox, lng, lat));
    })
    .map(
      ({
        rawOperatorRefs: _rawOperatorRefs,
        rawRouteRefs: _rawRouteRefs,
        rawStopRefs: _rawStopRefs,
        ...alert
      }) => alert,
    );
}

export async function getStopAlerts(stopId: string): Promise<ServiceAlert[]> {
  const datasets = await loadSwissStopDatasets();
  const rawRef = stripProviderPrefix(stopId);
  return (await loadMappedAlerts())
    .filter((alert) => alertMatchesStop(alert, rawRef, datasets))
    .map(
      ({
        rawOperatorRefs: _rawOperatorRefs,
        rawRouteRefs: _rawRouteRefs,
        rawStopRefs: _rawStopRefs,
        ...alert
      }) => alert,
    );
}

export async function getRouteAlerts(routeId: string): Promise<ServiceAlert[]> {
  const observed = await getObservedRoute(routeId);
  return (await loadMappedAlerts())
    .filter((alert) => alertMatchesRoute(alert, routeId, observed))
    .map(
      ({
        rawOperatorRefs: _rawOperatorRefs,
        rawRouteRefs: _rawRouteRefs,
        rawStopRefs: _rawStopRefs,
        ...alert
      }) => alert,
    );
}
