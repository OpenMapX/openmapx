import type { DocumentTypeDecoration } from "@graphql-typed-document-node/core";
import type { BBox } from "@openmapx/core";
import { decodePolyline } from "@openmapx/core";
import {
  createEnturGeocoder,
  createEnturGeocoderSources,
  type EnturClient,
  type EnturFamily,
  type EnturGeocoderFeature,
  type EnturGeocoderSources,
  EnturRequestError,
  geocoderFeatureCoordinates,
  geocoderFeatureIdentity,
  geocoderFeatureModes,
  isEnturRequestError,
  normalizeEnturGeocoderCountry,
} from "@openmapx/entur-client";
import type {
  AlertSeverity,
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
} from "@openmapx/mobility-core/transit";
import {
  type BoardCallFieldsFragment,
  type TransportMode as EnturTransportMode,
  HealthCheckDocument,
  type JourneyCallFieldsFragment,
  type JourneyPatternFieldsFragment,
  LineDetailDocument,
  type LineFieldsFragment,
  NationalSituationsDocument,
  NearbyStopsDocument,
  PlanTripDocument,
  type PlanTripQuery,
  QuayBoardDocument,
  QuayDetailDocument,
  type QuayFieldsFragment,
  QuayRoutesDocument,
  ServiceJourneyDocument,
  type ServiceJourneyQuery,
  type SituationFieldsFragment,
  StopPlaceBoardDocument,
  StopPlaceDetailDocument,
  type StopPlaceFieldsFragment,
  StopPlaceRoutesDocument,
  type TripLegFieldsFragment,
} from "@openmapx/mobility-formats/entur/journey-planner.generated.js";
import { affectedLineIds, affectedStops } from "@openmapx/mobility-formats/entur/situations.js";
import {
  type VehicleFieldsFragment,
  VehicleHealthCheckDocument,
  VehiclesByBoundingBoxDocument,
  VehiclesByLineDocument,
} from "@openmapx/mobility-formats/entur/vehicles.generated.js";

type EnturMultiModal = "parent" | "child" | "all";
type BoardMode = "departures" | "arrivals" | "both";

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

const ENTUR_PREFIX = "entur:";
const NSR_PREFIX = "NSR:";
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

function withEnturPrefix(rawId: string): string {
  return `${ENTUR_PREFIX}${rawId}`;
}

export function stripKnownPrefix(id: string): string {
  if (id.startsWith(ENTUR_PREFIX)) return id.slice(ENTUR_PREFIX.length);
  if (id.startsWith("nsr:")) return `${NSR_PREFIX}${id.slice(4)}`;
  return id;
}

export function buildStopIdentity(
  rawId: string,
): Pick<TransitStop, "primaryScheme" | "ids" | "codes"> {
  const ids: Record<string, string> = { entur: rawId };
  let primaryScheme = "entur";
  if (rawId.startsWith(NSR_PREFIX)) {
    ids.nsr = rawId.slice(NSR_PREFIX.length);
    primaryScheme = "nsr";
  }
  return {
    primaryScheme,
    ids,
    ...(rawId.startsWith(NSR_PREFIX)
      ? { codes: [{ value: rawId, namespace: "nsr" as const }] }
      : {}),
  };
}

export function encodeServiceJourneyId(serviceJourneyId: string, date?: string): string {
  return withEnturPrefix(
    date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? `${date}${DAY_TOKEN_SEPARATOR}${serviceJourneyId}`
      : serviceJourneyId,
  );
}

export function decodeServiceJourneyId(token: string): { serviceJourneyId: string; date?: string } {
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

export function isQuayId(rawId: string): boolean {
  return rawId.includes(":Quay:");
}

export function isTruthyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function toTransportMode(mode: string | null | undefined): TransportMode {
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

export function collectStopModes(
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

export function toOccupancyLevel(raw: string | null | undefined): OccupancyLevel | undefined {
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

export function toAlertSeverity(raw: string | null | undefined): AlertSeverity {
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

export function pickLocalizedText(
  values: SituationFieldsFragment["summary"][number][] | null | undefined,
): string | undefined {
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

export function nsrTextValue(value: NsrTextValue | null | undefined): string | undefined {
  return isTruthyString(value?.value) ? value.value : undefined;
}

export function normalizeColor(color: string | null | undefined): string | undefined {
  if (!isTruthyString(color)) return undefined;
  return color.replace(/^#/, "");
}

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export function datePartFromIso(value: string | null | undefined): string | undefined {
  if (!isTruthyString(value)) return undefined;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

export function shiftDate(date: string, days: number): string {
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

export function calculateDelaySeconds(
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
  patterns: Array<JourneyPatternFieldsFragment | null> | null | undefined,
): TransitRoute["geometry"] | undefined {
  const coordinates = (patterns ?? [])
    .map((pattern) => decodePoints(pattern?.pointsOnLink?.points))
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
  estimatedCalls: JourneyCallFieldsFragment[] | null | undefined,
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

export function normalizeLine(line: LineFieldsFragment | null | undefined): TransitRoute | null {
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

export function normalizeStopPlace(
  stopPlace: StopPlaceFieldsFragment | null | undefined,
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

function normalizeQuay(quay: QuayFieldsFragment | null | undefined): TransitStop | null {
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

function featureToTransitStop(feature: EnturGeocoderFeature): TransitStop | null {
  const { nativeId: rawId, primaryScheme, ids } = geocoderFeatureIdentity(feature);
  const coordinates = geocoderFeatureCoordinates(feature);
  if (feature.properties.layer !== "stopPlace" || !rawId.startsWith(NSR_PREFIX) || !coordinates)
    return null;
  const [lng, lat] = coordinates;
  return {
    id: withEnturPrefix(rawId),
    primaryScheme,
    ids,
    codes: [{ value: rawId, namespace: "nsr" }],
    name: feature.properties.names.default,
    lat,
    lng,
    modes: geocoderFeatureModes(feature),
    provider: "entur",
  };
}

function normalizeDeparture(
  call: BoardCallFieldsFragment,
  boardMode: Exclude<BoardMode, "both">,
): Departure | null {
  const line = normalizeLine(call.serviceJourney?.line);
  if (!line) return null;
  const scheduledAt = boardMode === "departures" ? call.aimedDepartureTime : call.aimedArrivalTime;
  const expectedAt =
    boardMode === "departures" ? call.expectedDepartureTime : call.expectedArrivalTime;
  if (!isTruthyString(scheduledAt)) return null;
  const date = call.date;
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
  situation: SituationFieldsFragment,
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
  for (const id of affectedLineIds(situation)) affectedRouteIds.add(withEnturPrefix(id));
  for (const stop of affectedStops(situation)) affectedStopIds.add(withEnturPrefix(stop.id));
  const activePeriods = situation.validityPeriods.map((period) => ({
    start: period.startTime ?? undefined,
    end: period.endTime ?? undefined,
  }));
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
  situations: SituationFieldsFragment[] | null | undefined,
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

function normalizeTripLeg(leg: TripLegFieldsFragment): TripLeg | null {
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

function normalizeTripPlan(trip: PlanTripQuery["trip"] | null | undefined): TripPlan | null {
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

function normalizeVehiclePosition(vehicle: VehicleFieldsFragment | null): VehiclePosition | null {
  if (
    !vehicle?.location ||
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

function normalizeJourneyStop(call: JourneyCallFieldsFragment): VehicleJourneyStop | null {
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
  patterns: Array<JourneyPatternFieldsFragment | null> | null | undefined,
  hintStopId?: string,
): JourneyPatternFieldsFragment | null {
  const rawHint = hintStopId ? stripKnownPrefix(hintStopId) : undefined;
  let best: JourneyPatternFieldsFragment | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const pattern of patterns ?? []) {
    if (!pattern) continue;
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

function nsrArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value.filter((item): item is T => item != null);
  return value != null ? [value] : [];
}

export function nsrRefValue(value: NsrRef | null | undefined): string | undefined {
  if (isTruthyString(value?.ref)) return value.ref;
  if (isTruthyString(value?.value?.ref)) return value.value.ref;
  return undefined;
}

export function nsrPrivateCodeValue(value: NsrPrivateCode | null | undefined): string | undefined {
  return isTruthyString(value?.value) ? value.value : undefined;
}

function nsrPointLocation(point: NsrPoint | null | undefined): { lat: number; lng: number } | null {
  const latitude = point?.location?.latitude;
  const longitude = point?.location?.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  return { lat: latitude, lng: longitude };
}

export function ensureClosedRing(coordinates: [number, number][]): [number, number][] {
  if (coordinates.length === 0) return coordinates;
  const [firstLng, firstLat] = coordinates[0];
  const [lastLng, lastLat] = coordinates[coordinates.length - 1];
  if (firstLng === lastLng && firstLat === lastLat) return coordinates;
  return [...coordinates, [firstLng, firstLat]];
}

export function nsrCoordinatesFromPosList(
  value: number[] | null | undefined,
): [number, number][] | null {
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

export function humanizeNsrEnum(value: string | null | undefined): string | undefined {
  if (!isTruthyString(value)) return undefined;
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatTransportModes(modes: TransportMode[]): string {
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

export function parkingKindFromVehicleTypes(
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

/**
 * Map a MOTIS transitModes allow-list to Entur (Transmodel) transportMode enum
 * values for the JourneyPlanner v3 `modes` filter. Returns undefined — "all
 * modes" — when no modes are given or none map.
 */
const MOTIS_MODE_TO_ENTUR: Record<string, EnturTransportMode> = {
  HIGHSPEED_RAIL: "rail",
  LONG_DISTANCE: "rail",
  NIGHT_RAIL: "rail",
  REGIONAL_FAST_RAIL: "rail",
  REGIONAL_RAIL: "rail",
  SUBURBAN: "rail",
  SUBWAY: "metro",
  TRAM: "tram",
  BUS: "bus",
  COACH: "coach",
  FERRY: "water",
  FUNICULAR: "funicular",
  AERIAL_LIFT: "cableway",
};

export function motisModesToEntur(
  modes?: string[],
): Array<{ transportMode: EnturTransportMode }> | undefined {
  if (!modes || modes.length === 0) return undefined;
  const set = new Set<EnturTransportMode>();
  for (const mode of modes) {
    const mapped = MOTIS_MODE_TO_ENTUR[mode];
    if (mapped) set.add(mapped);
  }
  if (set.size === 0) return undefined;
  return [...set].map((transportMode) => ({ transportMode }));
}

/** Each registered generation owns its immutable acquisition client and lifetime. */
export function createEnturTransitProvider(
  client: EnturClient,
  signal: AbortSignal,
  options: {
    boundaryCountry?: string;
    multiModal?: EnturMultiModal;
    geocoderSources?: EnturGeocoderSources;
  } = {},
) {
  const generationSignal = signal;
  const boundaryCountry = normalizeEnturGeocoderCountry(options.boundaryCountry);
  const geocoderSources =
    options.geocoderSources ??
    createEnturGeocoderSources({
      contributors: client.contributors,
      isSourceAllowed: async () => {
        throw new EnturRequestError("policy");
      },
    });
  const geocoder = createEnturGeocoder(client, { policy: geocoderSources, timeoutMs: 8000 });
  const multiModal = options.multiModal ?? "parent";
  if (!["parent", "child", "all"].includes(multiModal))
    throw new TypeError("Invalid Entur multimodal filter");
  async function fetchGraphQl<TResult, TVariables>(
    family: "journeyPlanner" | "vehicles",
    document: DocumentTypeDecoration<TResult, TVariables> & { toString(): string },
    variables: NoInfer<TVariables>,
    callerSignal?: AbortSignal,
  ): Promise<TResult> {
    return client.graphQl(
      family,
      document,
      variables,
      callerSignal ? AbortSignal.any([signal, callerSignal]) : signal,
    );
  }

  async function fetchGeocoderAutocomplete(
    text: string,
    limit: number,
    callerSignal?: AbortSignal,
  ): Promise<EnturGeocoderFeature[]> {
    const result = await geocoder.autocomplete(
      {
        q: text,
        limit,
        layers: ["stopPlace"],
        sources: ["nsr"],
        ...(boundaryCountry ? { countries: [boundaryCountry] } : {}),
        multimodal: multiModal,
      },
      callerSignal ? AbortSignal.any([generationSignal, callerSignal]) : generationSignal,
    );
    return result.features;
  }

  async function fetchNsrRecord<T>(path: string): Promise<T> {
    return client.getJson<T>("nsr", path, signal);
  }

  async function fetchStopBoard(
    rawId: string,
    boardMode: Exclude<BoardMode, "both">,
    timeRangeSeconds: number,
    numberOfDepartures: number,
    startTime?: string,
  ): Promise<{ situations: SituationFieldsFragment[]; estimatedCalls: BoardCallFieldsFragment[] }> {
    if (isQuayId(rawId)) {
      const data = await fetchGraphQl("journeyPlanner", QuayBoardDocument, {
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
    const data = await fetchGraphQl("journeyPlanner", StopPlaceBoardDocument, {
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
  ): Promise<{ journey: NonNullable<ServiceJourneyQuery["serviceJourney"]>; date: string } | null> {
    for (const date of dateCandidates(preferredDate)) {
      const data = await fetchGraphQl("journeyPlanner", ServiceJourneyDocument, {
        id: serviceJourneyId,
        date,
      });
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

  async function fetchStopPlaceParkings(rawStopId: string): Promise<NsrParking[]> {
    try {
      return await fetchNsrRecord<NsrParking[]>(
        `/stop-places/${encodeURIComponent(rawStopId)}/parkings`,
      );
    } catch (error) {
      if (!isEnturRequestError(error) || error.kind !== "http" || error.status !== 404) throw error;
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
    } catch (error) {
      if (!isEnturRequestError(error) || error.kind !== "http" || error.status !== 404) throw error;
      return null;
    }
    return null;
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
    } catch (error) {
      if (!isEnturRequestError(error) || error.kind !== "http" || error.status !== 404) throw error;
      return undefined;
    }
  }

  async function isEnturTransitAvailable(): Promise<boolean> {
    try {
      const [data] = await Promise.all([
        fetchGraphQl("journeyPlanner", HealthCheckDocument, { id: "NSR:StopPlace:337" }),
        fetchGraphQl("vehicles", VehicleHealthCheckDocument, {}),
        fetchNsrRecord("/stop-places/NSR:StopPlace:337"),
      ]);
      return Boolean(data.stopPlace?.id);
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
    }
  }

  async function searchByName(
    query: string,
    limit = 10,
    signal?: AbortSignal,
  ): Promise<TransitStop[]> {
    const features = await fetchGeocoderAutocomplete(query, Math.min(limit, 20), signal);
    return features
      .map((feature): TransitStop | null => {
        const stop = featureToTransitStop(feature);
        return stop ? { ...stop, contributors: geocoderSources.contributorsFor(feature) } : null;
      })
      .filter((stop): stop is TransitStop => stop !== null)
      .slice(0, limit);
  }

  async function getStopsNearby(
    lat: number,
    lng: number,
    radiusMeters: number,
  ): Promise<TransitStop[]> {
    const data = await fetchGraphQl("journeyPlanner", NearbyStopsDocument, {
      latitude: lat,
      longitude: lng,
      maximumDistance: radiusMeters,
      maximumResults: 30,
    });
    return (data.nearest?.edges ?? [])
      .map((edge) => edge?.node?.place)
      .filter((place) => place?.__typename === "StopPlace")
      .map((place) => normalizeStopPlace(place))
      .filter((stop): stop is TransitStop => stop !== null);
  }

  async function getStop(stopId: string): Promise<TransitStop | null> {
    const rawId = stripKnownPrefix(stopId);

    if (isQuayId(rawId)) {
      const data = await fetchGraphQl("journeyPlanner", QuayDetailDocument, { id: rawId });
      return normalizeQuay(data.quay);
    }
    const data = await fetchGraphQl("journeyPlanner", StopPlaceDetailDocument, { id: rawId });
    return normalizeStopPlace(data.stopPlace);
  }

  async function getStopInfrastructure(stopId: string): Promise<TransitStopInfrastructure | null> {
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
      } catch (error) {
        if (!isEnturRequestError(error) || error.kind !== "http" || error.status !== 404)
          throw error;
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
    } catch (error) {
      if (!isEnturRequestError(error) || error.kind !== "http" || error.status !== 404) throw error;
      return null;
    }
  }

  async function getStopPlatforms(stopId: string): Promise<TransitStop[]> {
    const rawId = stripKnownPrefix(stopId);
    if (isQuayId(rawId)) return [];

    const data = await fetchGraphQl("journeyPlanner", StopPlaceDetailDocument, { id: rawId });
    return (data.stopPlace?.quays ?? [])
      .map((quay) => normalizeQuay(quay))
      .filter((stop): stop is TransitStop => stop !== null);
  }

  async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
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
  }

  async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
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
  }

  async function getStopTimetable(stopId: string, date: string): Promise<Departure[]> {
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
  }

  async function getRoutesForStop(stopId: string): Promise<TransitRoute[]> {
    const rawId = stripKnownPrefix(stopId);

    if (isQuayId(rawId)) {
      const data = await fetchGraphQl("journeyPlanner", QuayRoutesDocument, { id: rawId });
      return dedupeById(
        (data.quay?.lines ?? [])
          .map((line) => normalizeLine(line))
          .filter((line): line is TransitRoute => line !== null),
      );
    }

    const data = await fetchGraphQl("journeyPlanner", StopPlaceRoutesDocument, { id: rawId });
    const routes = (data.stopPlace?.quays ?? []).flatMap((quay) => quay?.lines ?? []);
    return dedupeById(
      routes
        .map((line) => normalizeLine(line))
        .filter((line): line is TransitRoute => line !== null),
    );
  }

  async function getRoute(routeId: string): Promise<TransitRoute | null> {
    const rawId = stripKnownPrefix(routeId);

    const data = await fetchGraphQl("journeyPlanner", LineDetailDocument, { id: rawId });
    const line = data.line;
    const normalized = normalizeLine(line);
    if (!normalized) return null;
    return {
      ...normalized,
      geometry: routeGeometryFromPatterns(line?.journeyPatterns),
    };
  }

  async function getRouteStops(routeId: string, hintStopId?: string): Promise<RouteStop[]> {
    const rawId = stripKnownPrefix(routeId);

    const data = await fetchGraphQl("journeyPlanner", LineDetailDocument, { id: rawId });
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
  }

  async function planTrip(params: {
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    departureTime?: string;
    arrivalTime?: string;
    modes?: string[];
    numItineraries?: number;
  }): Promise<TripPlan | null> {
    const dateTime = params.arrivalTime ?? params.departureTime ?? new Date().toISOString();
    const arriveBy = Boolean(params.arrivalTime);
    const transportModes = motisModesToEntur(params.modes);

    const data = await fetchGraphQl("journeyPlanner", PlanTripDocument, {
      fromLat: params.from.lat,
      fromLon: params.from.lng,
      toLat: params.to.lat,
      toLon: params.to.lng,
      dateTime,
      arriveBy,
      numTripPatterns: params.numItineraries ?? 3,
      ...(transportModes ? { modes: { transportModes } } : {}),
    });
    return normalizeTripPlan(data.trip);
  }

  async function getLegGeometry(
    tripId: string,
    fromStopId?: string,
    toStopId?: string,
  ): Promise<GeoJSONLineString | null> {
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
  }

  async function getVehicleJourney(
    tripId: string,
    fallbackIds?: string[],
  ): Promise<VehicleJourney | null> {
    const candidates = [tripId, ...(fallbackIds ?? [])];
    for (const candidate of candidates) {
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
    }
    return null;
  }

  async function getVehiclePositions(routeId: string): Promise<VehiclePosition[]> {
    const rawId = stripKnownPrefix(routeId);

    const data = await fetchGraphQl("vehicles", VehiclesByLineDocument, {
      lineRef: rawId,
      maxDataAge: "PT30M",
    });
    return (data.vehicles ?? [])
      .map((vehicle) => normalizeVehiclePosition(vehicle))
      .filter((vehicle): vehicle is VehiclePosition => vehicle !== null);
  }

  async function getVehicleRadar(bbox: BBox): Promise<VehiclePosition[]> {
    const data = await fetchGraphQl("vehicles", VehiclesByBoundingBoxDocument, {
      minLat: bbox[1],
      minLon: bbox[0],
      maxLat: bbox[3],
      maxLon: bbox[2],
      maxDataAge: "PT30M",
    });
    return (data.vehicles ?? [])
      .map((vehicle) => normalizeVehiclePosition(vehicle))
      .filter((vehicle): vehicle is VehiclePosition => vehicle !== null);
  }

  async function getRouteAlerts(routeId: string): Promise<ServiceAlert[]> {
    const rawId = stripKnownPrefix(routeId);

    const data = await fetchGraphQl("journeyPlanner", LineDetailDocument, { id: rawId });
    return mergeAlertArrays(
      (data.line?.situations ?? [])
        .map((situation) => situationToAlert(situation, { routeId: withEnturPrefix(rawId) }))
        .filter((alert): alert is ServiceAlert => alert !== null),
    );
  }

  async function getStopAlerts(stopId: string): Promise<ServiceAlert[]> {
    const rawId = stripKnownPrefix(stopId);

    const board = await fetchStopBoard(rawId, "departures", 6 * 60 * 60, 80);
    const alerts = [
      ...(board.situations ?? []),
      ...board.estimatedCalls.flatMap((call) => call.situations ?? []),
    ]
      .map((situation) => situationToAlert(situation, { stopId: withEnturPrefix(rawId) }))
      .filter((alert): alert is ServiceAlert => alert !== null);
    return mergeAlertArrays(alerts);
  }

  async function getAlerts(bbox: BBox): Promise<ServiceAlert[]> {
    const data = await fetchGraphQl("journeyPlanner", NationalSituationsDocument, {});
    const filtered = (data.situations ?? []).filter((situation) =>
      affectedStops(situation).some(
        (stop) =>
          typeof stop.latitude === "number" &&
          typeof stop.longitude === "number" &&
          isInsideBbox(bbox, stop.longitude, stop.latitude),
      ),
    );
    return mergeAlertArrays(
      filtered
        .map((situation) => situationToAlert(situation))
        .filter((alert): alert is ServiceAlert => alert !== null),
    );
  }

  async function getFacilities(stopId: string): Promise<Facility[]> {
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
    } catch (error) {
      if (!isEnturRequestError(error) || error.kind !== "http" || error.status !== 404) throw error;
      return [];
    }
  }
  function owned<Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
    family?: EnturFamily,
    callerSignal?: (args: Args) => AbortSignal | undefined,
  ) {
    return async (...args: Args): Promise<Result> => {
      const caller = callerSignal?.(args);
      const lifetime = caller ? AbortSignal.any([signal, caller]) : signal;
      const assertActive = () => {
        if (lifetime.aborted)
          throw new EnturRequestError("abort", undefined, { cause: lifetime.reason });
      };
      assertActive();
      const result = await operation(...args);
      if (family) await client.assertSourceAllowed(family, lifetime);
      assertActive();
      return result;
    };
  }
  return Object.freeze({
    isEnturTransitAvailable: owned(isEnturTransitAvailable),
    searchByName: owned(searchByName, undefined, (args) => args[2]),
    getStopsNearby: owned(getStopsNearby, "journeyPlanner"),
    getStop: owned(getStop, "journeyPlanner"),
    getStopInfrastructure: owned(getStopInfrastructure, "nsr"),
    getStopPlatforms: owned(getStopPlatforms, "journeyPlanner"),
    getDepartures: owned(getDepartures, "journeyPlanner"),
    getArrivals: owned(getArrivals, "journeyPlanner"),
    getStopTimetable: owned(getStopTimetable, "journeyPlanner"),
    getRoutesForStop: owned(getRoutesForStop, "journeyPlanner"),
    getRoute: owned(getRoute, "journeyPlanner"),
    getRouteStops: owned(getRouteStops, "journeyPlanner"),
    planTrip: owned(planTrip, "journeyPlanner"),
    getLegGeometry: owned(getLegGeometry, "journeyPlanner"),
    getVehicleJourney: owned(getVehicleJourney, "journeyPlanner"),
    getVehiclePositions: owned(getVehiclePositions, "vehicles"),
    getVehicleRadar: owned(getVehicleRadar, "vehicles"),
    getRouteAlerts: owned(getRouteAlerts, "journeyPlanner"),
    getStopAlerts: owned(getStopAlerts, "journeyPlanner"),
    getAlerts: owned(getAlerts, "journeyPlanner"),
    getFacilities: owned(getFacilities, "nsr"),
  });
}
