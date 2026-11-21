import { createHash } from "node:crypto";
import { type BBox, itemAt } from "@openmapx/core";
import {
  type CacheClient,
  captureCacheWriter,
  captureTransitContributors,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorsForRecords, snapshotContributors } from "@openmapx/mobility-core/contributors";
import { deriveStationIntelligence } from "@openmapx/mobility-core/station-intelligence";
import type {
  Departure,
  GeoJSONLineString,
  OccupancyLevel,
  ServiceAlert,
  TransitAccessibilityItem,
  TransitAmenityItem,
  TransitFormationDetail,
  TransitPlatformDetail,
  TransitRoute,
  TransitStop,
  TransitStopAreaSummary,
  TransitStopInfrastructure,
  TransitStopParking,
  TripPlan,
  VehicleJourney,
} from "@openmapx/mobility-core/transit";
import { transitDataContributors } from "@openmapx/mobility-core/transit-contributors";
import {
  buildOjpLocationInformationRequestXml,
  buildOjpStopEventRequestXml,
  buildOjpTripInfoRequestXml,
  buildOjpTripRequestXml,
  extractOjpTripRequestTrips,
  type GtfsRtFeedObject,
  gtfsRtTimestampToIso,
  type OjpPlace,
  parseOjpLocationInformationResponse,
  parseOjpStopEventResponse,
  parseOjpTripInfoResponse,
  parseOjpTripResponse,
} from "@openmapx/mobility-formats";
import {
  alertCoordinates,
  alertMatchesRoute,
  alertMatchesStop,
  loadMappedAlerts,
} from "./alerts.js";
import type { SwissTransitClient } from "./client.js";
import {
  computeDelaySeconds,
  mapSwissOccupancy,
  nestedFieldContributors,
  normalizeSwissOperatingDate,
  normalizeText,
  PROVIDER,
  providerId,
  retainedFieldContributors,
  type SwissObservedRouteEntry,
  type SwissProviderRuntime,
  type SwissProviderState,
  type SwissRouteStop,
  stripProviderPrefix,
  swissContributors,
  uniqueStrings,
} from "./common.js";
import type {
  SwissDatasets,
  SwissFlatCsvRecord,
  SwissServicePoint,
  SwissStopDatasets,
  SwissTrafficPoint,
} from "./datasets.js";
import { requestTripFares } from "./fares.js";
import {
  buildSwissFormationRequest,
  mapSwissFormationDetails,
  type SwissFormationJourneyResponse,
} from "./formation.js";
import {
  applySwissOccupancyForecast,
  applySwissOccupancyForecastToServiceInfo,
  enrichSwissTripPlanOccupancy,
  resolveSwissOccupancyForecast,
} from "./occupancy.js";
import {
  buildDepartureFromStopEvent,
  buildRouteFromService,
  buildRouteFromStopEvent,
  collectServiceOperatorRefs,
  coordinatesFromTrackSections,
  dedupeJourneyCalls,
  mapJourneyStopFromCall,
  mapOjpFormation,
  mapOjpServiceInfo,
  mapRequestedIntermodalModes,
  mapRouteStopFromCall,
  mapSwissOperatorMetadata,
  mapTripResponseToPlan,
  routeStopsFromJourney,
  serviceRemarks,
  stopEventCalls,
} from "./ojp-map.js";
import {
  buildTransitStopFromServicePoint,
  buildTransitStopFromTrafficPoint,
  dedupePreferredPlaces,
  findServicePoint,
  mapOjpPlaceToStop,
  matchesStopRef,
  platformCodeFromRef,
  servicePointModes,
  stopMatchKeys,
} from "./stop-identity.js";

const SWITZERLAND_BBOX: BBox = [5.96, 45.82, 10.49, 47.81];
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

const SWISS_OBSERVED_ROUTE_TTL_MS = 24 * 60 * 60 * 1000;

function bboxContains(bbox: BBox, lng: number, lat: number): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function bboxOverlaps(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (["YES", "TRUE", "JA"].includes(normalized)) return true;
  if (["NO", "FALSE", "NEIN"].includes(normalized)) return false;
  return undefined;
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

function mergeTransitRoute(existing: TransitRoute | undefined, next: TransitRoute): TransitRoute {
  const retainedExisting =
    existing &&
    ((!next.shortName && existing.shortName) ||
      (!next.longName && existing.longName) ||
      (!next.operatorName && existing.operatorName) ||
      (!next.color && existing.color) ||
      (!next.textColor && existing.textColor) ||
      (!next.geometry && existing.geometry));
  return {
    contributors: snapshotContributors(
      next.contributors ?? [],
      retainedExisting ? (existing.contributors ?? []) : [],
    ),
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

function pruneObservedRoutes(runtime: SwissProviderRuntime): void {
  const now = Date.now();
  for (const [routeId, entry] of runtime.state.observedRoutes.entries()) {
    if (entry.expiresAt <= now) {
      runtime.state.observedRoutes.delete(routeId);
    }
  }
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

function observationIsCurrent(runtime: SwissProviderRuntime): boolean {
  return (
    runtime.state.available && !runtime.state.disposed && runtime.epoch === runtime.state.epoch
  );
}

function observationCacheKey(runtime: SwissProviderRuntime, routeId: string): string {
  return `swiss-otdch:v2:observed:${runtime.cacheIdentity}:${stripProviderPrefix(routeId)}`;
}

function retainObservedRoute(runtime: SwissProviderRuntime, entry: SwissObservedRouteEntry): void {
  runtime.state.observedRoutes.delete(entry.route.id);
  runtime.state.observedRoutes.set(entry.route.id, entry);
  if (runtime.state.observedRoutes.size > 5_000) {
    const oldest = runtime.state.observedRoutes.keys().next();
    if (!oldest.done) runtime.state.observedRoutes.delete(oldest.value);
  }
}

async function rememberObservedRoute(
  runtime: SwissProviderRuntime,
  route: TransitRoute,
  input: {
    hintStopId?: string;
    operatorRefs?: string[];
    stops?: SwissRouteStop[];
    tripId?: string;
  } = {},
): Promise<void> {
  if (!observationIsCurrent(runtime)) return;
  const existing = await getObservedRoute(runtime, route.id);
  if (!observationIsCurrent(runtime)) return;
  // Another observation may have completed while the shared read was pending.
  // Re-read and merge synchronously with publication to avoid losing its hints.
  const current = runtime.state.observedRoutes.get(route.id);
  const entry = buildObservedRouteEntry(route, input, current ?? existing ?? undefined);
  retainObservedRoute(runtime, entry);
  // The writer was captured before this operation's upstream acquisition.
  // A direct cache.set here would capture the epoch too late.
  await runtime.writer
    ?.set(
      observationCacheKey(runtime, route.id),
      entry,
      Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000)),
    )
    .catch(() => {});
}

async function getObservedRoute(
  runtime: SwissProviderRuntime,
  routeId: string,
): Promise<SwissObservedRouteEntry | null> {
  if (!observationIsCurrent(runtime)) return null;
  pruneObservedRoutes(runtime);
  const local = runtime.state.observedRoutes.get(routeId);
  if (local) return local;
  if (!runtime.cache) return null;
  try {
    const cached = await runtime.cache?.get<SwissObservedRouteEntry>(
      observationCacheKey(runtime, routeId),
    );
    if (!observationIsCurrent(runtime)) return null;
    pruneObservedRoutes(runtime);
    const current = runtime.state.observedRoutes.get(routeId);
    if (current) return current;
    if (!cached?.route || !Number.isFinite(cached.expiresAt) || cached.expiresAt <= Date.now())
      return null;
    retainObservedRoute(runtime, cached);
    return cached;
  } catch {
    return null;
  }
}

async function requestLocationInformationByQuery(
  runtime: SwissProviderRuntime,
  query: string,
  limit: number,
): Promise<OjpPlace[]> {
  const xml = buildOjpLocationInformationRequestXml({
    includePtModes: true,
    language: runtime.client.config.requestLanguage,
    limit,
    query,
    requestorRef: runtime.client.config.requestorRef,
    types: ["stop"],
  });
  return parseOjpLocationInformationResponse(
    await runtime.client.requestSwissOjp(xml, {
      cacheNamespace: "location-query",
      cacheTtlSeconds: 3600,
    }),
  ).places;
}

async function requestLocationInformationByRef(
  runtime: SwissProviderRuntime,
  rawRef: string,
): Promise<OjpPlace[]> {
  const xml = buildOjpLocationInformationRequestXml({
    includePtModes: true,
    language: runtime.client.config.requestLanguage,
    limit: 20,
    placeRef:
      rawRef.startsWith("ch:1:sloid:") && rawRef.split(":").length > 4
        ? { stopPointRef: rawRef }
        : /^\d+$/.test(rawRef)
          ? { stopPlaceRef: rawRef }
          : rawRef.startsWith("ch:1:sloid:")
            ? { stopPlaceRef: rawRef }
            : { stopPointRef: rawRef },
    requestorRef: runtime.client.config.requestorRef,
    types: ["stop"],
  });
  return parseOjpLocationInformationResponse(
    await runtime.client.requestSwissOjp(xml, {
      cacheNamespace: "location-ref",
      cacheTtlSeconds: 3600,
    }),
  ).places;
}

async function requestNearbyLocations(
  runtime: SwissProviderRuntime,
  lat: number,
  lng: number,
  radiusMeters: number,
  limit: number,
): Promise<OjpPlace[]> {
  const xml = buildOjpLocationInformationRequestXml({
    geoRestrictionCircleMeters: radiusMeters,
    includePtModes: true,
    language: runtime.client.config.requestLanguage,
    limit,
    placeRef: {
      geoPosition: { latitude: lat, longitude: lng },
    },
    requestorRef: runtime.client.config.requestorRef,
    types: ["stop"],
  });
  return parseOjpLocationInformationResponse(
    await runtime.client.requestSwissOjp(xml, {
      cacheNamespace: "location-nearby",
      cacheTtlSeconds: 3600,
    }),
  ).places;
}

async function requestStopEvents(
  runtime: SwissProviderRuntime,
  rawRef: string,
  minutes: number,
  stopEventType: "departure" | "arrival",
) {
  const xml = buildOjpStopEventRequestXml({
    includeAllRestrictedLines: true,
    includeOnwardCalls: true,
    includePreviousCalls: true,
    language: runtime.client.config.requestLanguage,
    numberOfResults: Math.min(Math.max(minutes, 10), 120),
    requestorRef: runtime.client.config.requestorRef,
    stopEventType,
    stopRef: rawRef,
    useRealtimeData: "full",
    dateTime: new Date().toISOString(),
  });
  return parseOjpStopEventResponse(
    await runtime.client.requestSwissOjp(xml, {
      cacheNamespace: `stop-events:${stopEventType}`,
      cacheTtlSeconds: stopEventType === "departure" ? 30 : 60,
    }),
  );
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
  runtime: SwissProviderRuntime,
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
    language: runtime.client.config.requestLanguage,
    operatingDayRef: decoded.operatingDayRef,
    requestorRef: runtime.client.config.requestorRef,
    useRealtimeData: "full",
  });
  return {
    rawTripId: decoded.rawTripId,
    response: parseOjpTripInfoResponse(
      await runtime.client.requestSwissOjp(xml, {
        cacheNamespace:
          options.includeCalls || options.includeService ? "trip-info-live" : "trip-info-static",
        cacheTtlSeconds: options.includeCalls || options.includeService ? 30 : 86400,
      }),
    ),
  };
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
    // A group exists only once a point was added to it.
    const first = itemAt(members, 0, "traffic point group member");
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
  runtime: SwissProviderRuntime,
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
  const applied =
    (!departure.canceled && bestMatch.canceled) ||
    (departure.delaySeconds == null && bestMatch.delaySeconds != null) ||
    (!departure.expectedAt && Boolean(bestMatch.expectedAt)) ||
    (departure.serviceInfo && !departure.serviceInfo.canceled && bestMatch.canceled);
  if (!applied) return departure;
  const realtime = swissContributors(runtime, "gtfs-rt");
  const fieldContributors = retainedFieldContributors(departure);
  if (!departure.canceled && bestMatch.canceled) fieldContributors.canceled = realtime;
  if (departure.delaySeconds == null && bestMatch.delaySeconds != null)
    fieldContributors.delaySeconds = realtime;
  if (!departure.expectedAt && bestMatch.expectedAt) fieldContributors.expectedAt = realtime;
  const serviceInfo =
    departure.serviceInfo && !departure.serviceInfo.canceled && bestMatch.canceled
      ? {
          ...departure.serviceInfo,
          canceled: true,
          contributors: snapshotContributors(departure.serviceInfo.contributors ?? [], realtime),
          fieldContributors: {
            ...retainedFieldContributors(departure.serviceInfo),
            canceled: realtime,
          },
        }
      : departure.serviceInfo;
  if (serviceInfo && serviceInfo !== departure.serviceInfo)
    Object.assign(fieldContributors, nestedFieldContributors(serviceInfo, "serviceInfo"));
  return {
    ...departure,
    contributors: snapshotContributors(departure.contributors ?? [], realtime),
    fieldContributors,
    canceled: departure.canceled || bestMatch.canceled,
    delaySeconds:
      departure.delaySeconds == null && bestMatch.delaySeconds != null
        ? bestMatch.delaySeconds
        : departure.delaySeconds,
    expectedAt: departure.expectedAt || bestMatch.expectedAt,
    serviceInfo,
  };
}

async function isOpenTransportDataChAvailable(runtime: SwissProviderRuntime): Promise<boolean> {
  return runtime.client.probeSwissOjp();
}

async function searchByName(
  runtime: SwissProviderRuntime,
  query: string,
  limit: number,
): Promise<TransitStop[]> {
  const datasets = await runtime.datasets.loadSwissStopDatasets();
  if (runtime.client.isSwissTransitConfigured()) {
    try {
      return dedupePreferredPlaces(
        await requestLocationInformationByQuery(runtime, query, limit * 3),
        datasets,
      )
        .slice(0, limit)
        .map((place) => mapOjpPlaceToStop(runtime, place, datasets));
    } catch {
      // fall back to the static master-data snapshot
    }
  }
  return (await runtime.datasets.searchSwissServicePoints(query, limit)).map((servicePoint) =>
    buildTransitStopFromServicePoint(runtime, servicePoint),
  );
}

async function getStopsNearby(
  runtime: SwissProviderRuntime,
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  const datasets = await runtime.datasets.loadSwissStopDatasets();
  if (runtime.client.isSwissTransitConfigured()) {
    try {
      return dedupePreferredPlaces(
        await requestNearbyLocations(runtime, lat, lng, Math.min(radiusMeters, 5_000), 80),
        datasets,
      ).map((place) => mapOjpPlaceToStop(runtime, place, datasets));
    } catch {
      // fall back to the static snapshot
    }
  }
  return (await runtime.datasets.findSwissNearbyServicePoints(lat, lng, radiusMeters)).map(
    (servicePoint) => buildTransitStopFromServicePoint(runtime, servicePoint),
  );
}

async function getStop(runtime: SwissProviderRuntime, stopId: string): Promise<TransitStop | null> {
  const datasets = await runtime.datasets.loadSwissStopDatasets();
  const rawRef = stripProviderPrefix(stopId);
  if (runtime.client.isSwissTransitConfigured()) {
    try {
      const places = await requestLocationInformationByRef(runtime, rawRef);
      const exact = places.find((place) => {
        const placeRaw = place.stopPointRef ?? place.stopPlaceRef ?? place.ref;
        return matchesStopRef(placeRaw, rawRef, datasets);
      });
      if (exact) return mapOjpPlaceToStop(runtime, exact, datasets);
    } catch {
      // fall back to master data
    }
  }

  const { servicePoint, stopPoint } = findServicePoint(rawRef, datasets);
  if (stopPoint && servicePoint) {
    return buildTransitStopFromTrafficPoint(runtime, stopPoint, servicePoint);
  }
  if (servicePoint) {
    return buildTransitStopFromServicePoint(runtime, servicePoint, rawRef);
  }
  return null;
}

async function getDepartures(
  runtime: SwissProviderRuntime,
  stopId: string,
  minutes: number,
): Promise<Departure[]> {
  const rawRef = stripProviderPrefix(stopId);
  const cutoff = Date.now() + minutes * 60_000;
  const [response, datasets, businessDatasets, gtfsRtFeed] = await Promise.all([
    requestStopEvents(runtime, rawRef, minutes, "departure"),
    runtime.datasets.loadSwissStopDatasets(),
    runtime.datasets.loadSwissBusinessOrganisationDatasets(),
    runtime.client.fetchSwissGtfsRtFeed().catch(() => null),
  ]);
  const departures: Departure[] = [];
  for (const stopEvent of response.stopEvents) {
    const operatorMetadata = mapSwissOperatorMetadata(stopEvent.service, businessDatasets);
    const route = buildRouteFromStopEvent(runtime, stopEvent, operatorMetadata);
    let departure = buildDepartureFromStopEvent(
      runtime,
      stopEvent,
      "departure",
      route,
      operatorMetadata,
    );
    if (!departure) continue;
    if (gtfsRtFeed) {
      departure = applyGtfsTripUpdateOverlay(
        runtime,
        departure,
        rawRef,
        "departure",
        gtfsRtFeed,
        datasets,
      );
    }
    if (!departure.occupancy && !departure.serviceInfo?.occupancy) {
      const occupancyForecast = await resolveSwissOccupancyForecast(
        runtime,
        departure.serviceInfo,
        {
          scheduledAt: departure.scheduledAt,
          stopId,
          stopName: stopEvent.thisCall?.name,
        },
      );
      if (occupancyForecast) {
        departure = applySwissOccupancyForecast(departure, occupancyForecast);
      }
    }
    if (new Date(departure.scheduledAt).getTime() > cutoff) continue;
    departures.push(departure);
    if (route) {
      await rememberObservedRoute(runtime, route, {
        hintStopId: stopId,
        operatorRefs: collectServiceOperatorRefs(stopEvent.service),
        tripId: departure.tripId,
      });
    }
  }
  return departures;
}

async function getArrivals(
  runtime: SwissProviderRuntime,
  stopId: string,
  minutes: number,
): Promise<Departure[]> {
  const rawRef = stripProviderPrefix(stopId);
  const cutoff = Date.now() + minutes * 60_000;
  const [response, datasets, businessDatasets, gtfsRtFeed] = await Promise.all([
    requestStopEvents(runtime, rawRef, minutes, "arrival"),
    runtime.datasets.loadSwissStopDatasets(),
    runtime.datasets.loadSwissBusinessOrganisationDatasets(),
    runtime.client.fetchSwissGtfsRtFeed().catch(() => null),
  ]);
  const arrivals: Departure[] = [];
  for (const stopEvent of response.stopEvents) {
    const operatorMetadata = mapSwissOperatorMetadata(stopEvent.service, businessDatasets);
    const route = buildRouteFromStopEvent(runtime, stopEvent, operatorMetadata);
    let arrival = buildDepartureFromStopEvent(
      runtime,
      stopEvent,
      "arrival",
      route,
      operatorMetadata,
    );
    if (!arrival) continue;
    if (gtfsRtFeed) {
      arrival = applyGtfsTripUpdateOverlay(
        runtime,
        arrival,
        rawRef,
        "arrival",
        gtfsRtFeed,
        datasets,
      );
    }
    if (!arrival.occupancy && !arrival.serviceInfo?.occupancy) {
      const occupancyForecast = await resolveSwissOccupancyForecast(runtime, arrival.serviceInfo, {
        scheduledAt: arrival.scheduledAt,
        stopId,
        stopName: stopEvent.thisCall?.name,
      });
      if (occupancyForecast) {
        arrival = applySwissOccupancyForecast(arrival, occupancyForecast);
      }
    }
    if (new Date(arrival.scheduledAt).getTime() > cutoff) continue;
    arrivals.push(arrival);
    if (route) {
      await rememberObservedRoute(runtime, route, {
        hintStopId: stopId,
        operatorRefs: collectServiceOperatorRefs(stopEvent.service),
        tripId: arrival.tripId,
      });
    }
  }
  return arrivals;
}

async function getRoutesForStop(
  runtime: SwissProviderRuntime,
  stopId: string,
): Promise<TransitRoute[]> {
  const [datasets, businessDatasets] = await Promise.all([
    runtime.datasets.loadSwissStopDatasets(),
    runtime.datasets.loadSwissBusinessOrganisationDatasets(),
  ]);
  const rawRef = stripProviderPrefix(stopId);
  const response = await requestStopEvents(runtime, rawRef, 120, "departure");
  const routes = new Map<string, TransitRoute>();
  for (const stopEvent of response.stopEvents) {
    const operatorMetadata = mapSwissOperatorMetadata(stopEvent.service, businessDatasets);
    const route = buildRouteFromStopEvent(runtime, stopEvent, operatorMetadata);
    const departure = buildDepartureFromStopEvent(
      runtime,
      stopEvent,
      "departure",
      route,
      operatorMetadata,
    );
    if (!route) continue;
    routes.set(route.id, mergeTransitRoute(routes.get(route.id), route));
    const stops = stopEventCalls(stopEvent).map((call, index) =>
      mapRouteStopFromCall(runtime, call, datasets, route.mode, index + 1),
    );
    await rememberObservedRoute(runtime, route, {
      hintStopId: stopId,
      operatorRefs: collectServiceOperatorRefs(stopEvent.service),
      ...(stops.length > 0 ? { stops } : {}),
      tripId: departure?.tripId,
    });
  }
  return [...routes.values()];
}

async function getRoute(
  runtime: SwissProviderRuntime,
  routeId: string,
): Promise<TransitRoute | null> {
  return (await getObservedRoute(runtime, routeId))?.route ?? null;
}

async function getRouteStops(
  runtime: SwissProviderRuntime,
  routeId: string,
  hintStopId?: string,
): Promise<SwissRouteStop[]> {
  const observed = await getObservedRoute(runtime, routeId);
  if (observed?.stops?.length) return observed.stops;

  const routeMode = observed?.route.mode;
  const tripCandidates = uniqueStrings(observed?.tripIds ?? []);
  for (const tripId of tripCandidates) {
    const journey = await getVehicleJourney(runtime, tripId);
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
      await rememberObservedRoute(runtime, rememberedRoute, {
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
    const response = await requestStopEvents(runtime, rawRef, 120, "departure").catch(() => null);
    const matching = response?.stopEvents.find((stopEvent) => {
      const route = buildRouteFromStopEvent(runtime, stopEvent);
      return route?.id === routeId;
    });
    if (!matching) continue;

    const matchedRoute = buildRouteFromStopEvent(runtime, matching);
    if (matchedRoute) {
      await rememberObservedRoute(runtime, matchedRoute, {
        hintStopId: stopCandidate,
        operatorRefs: collectServiceOperatorRefs(matching.service),
      });
    }

    const departure = buildDepartureFromStopEvent(runtime, matching, "departure", matchedRoute);
    if (!departure?.tripId) continue;

    const journey = await getVehicleJourney(runtime, departure.tripId);
    if (!journey) continue;
    const latestObserved = await getObservedRoute(runtime, routeId);
    if (latestObserved?.stops?.length) return latestObserved.stops;

    const stops = routeStopsFromJourney(journey, routeMode);
    if (stops.length > 0 && latestObserved?.route) {
      await rememberObservedRoute(runtime, latestObserved.route, {
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

async function planTrip(
  runtime: SwissProviderRuntime,
  params: {
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    departureTime?: string;
    arrivalTime?: string;
    modes?: string[];
  },
): Promise<TripPlan | null> {
  const businessDatasets = await runtime.datasets.loadSwissBusinessOrganisationDatasets();
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
    language: runtime.client.config.requestLanguage,
    numberOfResults: 5,
    origin: {
      geoPosition: { latitude: params.from.lat, longitude: params.from.lng },
    },
    requestorRef: runtime.client.config.requestorRef,
    useRealtimeData: "full",
  });
  const tripXml = await runtime.client.requestSwissOjp(xml, {
    cacheNamespace: "trip-plan",
    cacheTtlSeconds: 300,
  });
  const tripResponse = parseOjpTripResponse(tripXml);
  const fareResults = await requestTripFares(
    runtime,
    tripResponse,
    extractOjpTripRequestTrips(tripXml),
  );
  for (const trip of tripResponse.trips) {
    for (const leg of trip.legs) {
      if (leg.kind !== "timed") continue;
      const operatorMetadata = mapSwissOperatorMetadata(leg.service, businessDatasets);
      const route = buildRouteFromService(runtime, leg.service, operatorMetadata);
      const tripId =
        leg.service?.operatingDayRef && leg.service?.journeyRef
          ? providerId(`${leg.service.operatingDayRef}|${leg.service.journeyRef}`)
          : undefined;
      if (!route) continue;
      await rememberObservedRoute(runtime, route, {
        hintStopId: leg.boardCall?.stopPointRef
          ? providerId(leg.boardCall.stopPointRef)
          : undefined,
        operatorRefs: collectServiceOperatorRefs(leg.service),
        tripId,
      });
    }
  }
  return enrichSwissTripPlanOccupancy(
    runtime,
    mapTripResponseToPlan(runtime, tripResponse, params, businessDatasets, fareResults),
  );
}

async function getLegGeometry(
  runtime: SwissProviderRuntime,
  tripId: string,
  fromStopId?: string,
  toStopId?: string,
): Promise<GeoJSONLineString | null> {
  const tripInfoResult = await requestTripInfoByTripId(runtime, tripId, {
    includeCalls: false,
    includeLinkProjection: true,
    includeService: false,
    includeTrackSections: true,
  });
  const tripInfo = tripInfoResult?.response.tripInfo;
  if (!tripInfo?.trackSections.length) return null;
  const datasets = await runtime.datasets.loadSwissStopDatasets();
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
    contributors: swissContributors(runtime, "ojp", "ojp-geometry-osm"),
    coordinates,
    type: "LineString",
  };
}

async function getVehicleJourney(
  runtime: SwissProviderRuntime,
  tripId: string,
  fallbackIds: string[] = [],
): Promise<VehicleJourney | null> {
  const candidates = [tripId, ...fallbackIds].filter(
    (value, index, values) => values.indexOf(value) === index,
  );
  const [datasets, businessDatasets] = await Promise.all([
    runtime.datasets.loadSwissStopDatasets(),
    runtime.datasets.loadSwissBusinessOrganisationDatasets(),
  ]);

  for (const candidate of candidates) {
    const result = await requestTripInfoByTripId(runtime, candidate, {
      includeCalls: true,
      includeLinkProjection: false,
      includeService: true,
      includeTrackSections: false,
    }).catch(() => null);
    const tripInfo = result?.response.tripInfo;
    if (!tripInfo) continue;

    const calls = dedupeJourneyCalls([...tripInfo.previousCalls, ...tripInfo.onwardCalls]);
    const operatorMetadata = mapSwissOperatorMetadata(tripInfo.service, businessDatasets);
    const serviceInfo = mapOjpServiceInfo(runtime, tripInfo.service, operatorMetadata);
    const route = buildRouteFromService(runtime, tripInfo.service, operatorMetadata);
    if (route) {
      await rememberObservedRoute(runtime, route, {
        operatorRefs: collectServiceOperatorRefs(tripInfo.service),
        stops: calls.map((call, index) =>
          mapRouteStopFromCall(runtime, call, datasets, route.mode, index + 1),
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
      const formationJourney = await runtime.client
        .fetchSwissFormationJourney<SwissFormationJourneyResponse>(formationRequest)
        .catch((error) => {
          runtime.client.config.log?.warn?.(
            "Swiss formation lookup failed",
            formationRequest,
            error,
          );
          return null;
        });
      if (formationJourney) {
        formationDetails = mapSwissFormationDetails(
          runtime,
          formationJourney,
          datasets,
          formationRequest.evu,
        );
      }
    }
    const occupancyForecast =
      serviceInfo?.occupancy == null
        ? await resolveSwissOccupancyForecast(runtime, serviceInfo, {
            scheduledAt: calls[0]?.departureTimetabled ?? calls[0]?.arrivalTimetabled,
            stopId: calls[0]?.stopPointRef ? providerId(calls[0].stopPointRef) : undefined,
            stopName: calls[0]?.name,
          })
        : null;
    const resolvedServiceInfo = applySwissOccupancyForecastToServiceInfo(
      serviceInfo,
      occupancyForecast,
    );
    const stops = calls.map((call) => mapJourneyStopFromCall(runtime, call, datasets));
    return {
      contributors: snapshotContributors(
        swissContributors(runtime, "ojp"),
        resolvedServiceInfo?.contributors ?? [],
        contributorsForRecords(stops),
        formationDetails?.contributors ?? [],
      ),
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
      remarks: serviceRemarks(runtime, tripInfo.service),
      serviceInfo: resolvedServiceInfo,
      stops,
    };
  }

  return null;
}

async function getStopPlatforms(
  runtime: SwissProviderRuntime,
  stopId: string,
): Promise<TransitStop[]> {
  const datasets = await runtime.datasets.loadSwissStopDatasets();
  const rawRef = stripProviderPrefix(stopId);
  const { servicePoint, servicePointSloid } = findServicePoint(rawRef, datasets);
  if (!servicePoint || !servicePointSloid) return [];
  return (datasets.trafficPointsByServicePoint.get(servicePointSloid) ?? [])
    .filter((trafficPoint) =>
      ["BOARDING_PLATFORM", "BOARDING_AREA"].includes(trafficPoint.trafficPointElementType ?? ""),
    )
    .map((trafficPoint) => buildTransitStopFromTrafficPoint(runtime, trafficPoint, servicePoint));
}

async function getStopInfrastructure(
  runtime: SwissProviderRuntime,
  stopId: string,
): Promise<TransitStopInfrastructure | null> {
  const datasets = await runtime.datasets.loadSwissStopDatasets();
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

  return captureTransitContributors(
    {
      contributors: swissContributors(runtime, "master-data"),
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
    },
    swissContributors(runtime, "master-data"),
  );
}

async function getAlerts(runtime: SwissProviderRuntime, bbox: BBox): Promise<ServiceAlert[]> {
  if (!bboxOverlaps(bbox, SWITZERLAND_BBOX)) return [];
  const datasets = await runtime.datasets.loadSwissStopDatasets();
  return (await loadMappedAlerts(runtime))
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

async function getStopAlerts(
  runtime: SwissProviderRuntime,
  stopId: string,
): Promise<ServiceAlert[]> {
  const datasets = await runtime.datasets.loadSwissStopDatasets();
  const rawRef = stripProviderPrefix(stopId);
  return (await loadMappedAlerts(runtime))
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

async function getRouteAlerts(
  runtime: SwissProviderRuntime,
  routeId: string,
): Promise<ServiceAlert[]> {
  const observed = await getObservedRoute(runtime, routeId);
  return (await loadMappedAlerts(runtime))
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

export function createOpenTransportDataChProvider(options: {
  client: SwissTransitClient;
  datasets: SwissDatasets;
  cache?: CacheClient;
  contributors: Readonly<Record<string, readonly Attribution[]>>;
  isSourceAllowed?: (sourceId: string) => Promise<boolean>;
}) {
  const state: SwissProviderState = {
    observedRoutes: new Map(),
    epoch: 0,
    available: true,
    disposed: false,
  };
  const contributors = Object.fromEntries(
    Object.entries(options.contributors).map(([id, receipts]) => [
      id,
      snapshotContributors(receipts),
    ]),
  );
  const cacheIdentity = createHash("sha256")
    .update(JSON.stringify({ client: options.client.cacheIdentity, contributors }))
    .digest("hex");
  const unsubscribe = options.cache?.onInvalidate?.(({ available }) => {
    state.epoch++;
    state.available = available;
    state.observedRoutes.clear();
  });
  const bind =
    <Args extends unknown[], Result>(
      operation: (runtime: SwissProviderRuntime, ...args: Args) => Promise<Result>,
    ) =>
    async (...args: Args): Promise<Result> => {
      if (state.disposed) throw new Error("Swiss provider retired");
      const epoch = state.epoch;
      const writer = options.cache ? await captureCacheWriter(options.cache) : undefined;
      if (state.disposed) throw new Error("Swiss provider retired");
      const result = await operation(
        {
          cache: options.cache,
          writer,
          cacheIdentity,
          client: options.client,
          datasets: options.datasets,
          contributors,
          state,
          epoch,
        },
        ...args,
      );
      if (state.disposed) throw new Error("Swiss provider retired");
      if (options.isSourceAllowed) {
        for (const receipt of transitDataContributors(result)) {
          if (receipt.sourceId && !(await options.isSourceAllowed(receipt.sourceId))) {
            throw new Error("Swiss result source disabled by policy");
          }
        }
      }
      if (state.disposed) throw new Error("Swiss provider retired");
      return result;
    };
  return {
    isOpenTransportDataChAvailable: bind(isOpenTransportDataChAvailable),
    searchByName: bind(searchByName),
    getStopsNearby: bind(getStopsNearby),
    getStop: bind(getStop),
    getDepartures: bind(getDepartures),
    getArrivals: bind(getArrivals),
    getRoutesForStop: bind(getRoutesForStop),
    getRoute: bind(getRoute),
    getRouteStops: bind(getRouteStops),
    planTrip: bind(planTrip),
    getLegGeometry: bind(getLegGeometry),
    getVehicleJourney: bind(getVehicleJourney),
    getStopPlatforms: bind(getStopPlatforms),
    getStopInfrastructure: bind(getStopInfrastructure),
    getAlerts: bind(getAlerts),
    getStopAlerts: bind(getStopAlerts),
    getRouteAlerts: bind(getRouteAlerts),
    async dispose() {
      if (state.disposed) return;
      state.disposed = true;
      state.epoch++;
      state.observedRoutes.clear();
      unsubscribe?.();
    },
  };
}

export type OpenTransportDataChProvider = ReturnType<typeof createOpenTransportDataChProvider>;
