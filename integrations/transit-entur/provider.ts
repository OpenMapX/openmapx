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
import { deriveStationIntelligence } from "@openmapx/mobility-core/station-intelligence";
import type {
  AlertSeverity,
  Departure,
  Facility,
  GeoJSONLineString,
  OccupancyLevel,
  RouteStop,
  ServiceAlert,
  TransitFareZoneSummary,
  TransitRoute,
  TransitStop,
  TransitStopInfrastructure,
  TransitStopInfrastructureGeometry,
  TransitStopParking,
  TransitTopographicPlaceSummary,
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
import {
  collectStopModes,
  dedupeById,
  ENTUR_PREFIX,
  isTruthyString,
  toTransportMode,
  withEnturPrefix,
} from "./common.js";
import {
  buildChildStopAreas,
  buildSiblingStops,
  buildStopInfrastructureFacts,
  buildStopInfrastructureGeometry,
  collectNsrEquipmentItems,
  collectNsrLimitations,
  collectNsrTariffZoneRefs,
  collectPlatformsForStopPlaces,
  facilitiesFromParkings,
  facilitiesFromStopInfrastructure,
  mapNsrAccessibility,
  mapNsrAmenities,
  mapNsrFareZone,
  mapNsrParking,
  mapNsrTopographicPlace,
  mergeAccessibilityItems,
  mergeAmenityItems,
  mergePlatformDetails,
  mergeStopInfrastructureItems,
  type NsrFareZoneRecord,
  type NsrParking,
  type NsrQuayRecord,
  type NsrStopPlaceRecord,
  type NsrTopographicPlaceRecord,
  normalizeNsrPlatformDetail,
  normalizeNsrStopAreaSummary,
  normalizePlatformSummary,
  nsrRecordGeometry,
  nsrRefValue,
  sortPlatforms,
  transportModesFromStopPlace,
  uniqueFareZoneGeometries,
  uniqueFareZones,
  uniqueParking,
} from "./nsr-mapping.js";

type EnturMultiModal = "parent" | "child" | "all";
type BoardMode = "departures" | "arrivals" | "both";

const NSR_PREFIX = "NSR:";
const FULL_DAY_SECONDS = 24 * 60 * 60;
const DAY_TOKEN_SEPARATOR = "|";

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

export function normalizeColor(color: string | null | undefined): string | undefined {
  if (!isTruthyString(color)) return undefined;
  return color.replace(/^#/, "");
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
  const [only] = coordinates;
  if (!only) return undefined;
  if (coordinates.length === 1) {
    return { type: "LineString", coordinates: only };
  }
  return { type: "MultiLineString", coordinates };
}

function findNearestCoordinateIndex(
  coordinates: [number, number][],
  target: [number, number],
): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, [lng, lat]] of coordinates.entries()) {
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
    mode: toTransportMode(line.transportMode) ?? "other",
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
    mode: leg.ride ? (toTransportMode(leg.mode) ?? "other") : "walking",
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
    const firstLeg = legs[0];
    const lastLeg = legs.at(-1);
    if (!firstLeg || !lastLeg) continue;
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
      startTime: pattern.expectedStartTime ?? firstLeg.startTime,
      endTime: pattern.expectedEndTime ?? lastLeg.endTime,
      transfers: Math.max(0, legs.filter((leg) => leg.route !== undefined).length - 1),
      walkDistance,
      co2Grams: typeof pattern.emission?.co2 === "number" ? pattern.emission.co2 : undefined,
      legs,
    });
  }
  // The plan's ends come from Entur's places, else from the first itinerary's legs.
  const firstLeg = itineraries[0]?.legs[0];
  const lastLeg = itineraries[0]?.legs.at(-1);
  if (!firstLeg || !lastLeg) return null;
  return {
    from: {
      name: trip?.fromPlace?.name ?? firstLeg.from.name ?? "",
      lat: trip?.fromPlace?.latitude ?? firstLeg.from.lat,
      lng: trip?.fromPlace?.longitude ?? firstLeg.from.lng,
    },
    to: {
      name: trip?.toPlace?.name ?? lastLeg.to.name ?? "",
      lat: trip?.toPlace?.latitude ?? lastLeg.to.lat,
      lng: trip?.toPlace?.longitude ?? lastLeg.to.lng,
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
      const [data, vehicles] = await Promise.all([
        fetchGraphQl("journeyPlanner", HealthCheckDocument, { id: "NSR:StopPlace:337" }),
        fetchGraphQl("vehicles", VehicleHealthCheckDocument, {}),
        fetchNsrRecord("/stop-places/NSR:StopPlace:337"),
      ]);
      return Boolean(data.stopPlace?.id && vehicles.__typename);
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
