import { latLngOrNull } from "@openmapx/core/coordinates";
import {
  contributorsForFields,
  contributorsForRecords,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type {
  Departure,
  TransitFormationReference,
  TransitRoute,
  TransitServiceInfo,
  TransportMode,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
} from "@openmapx/mobility-core/transit";
import type {
  OjpCall,
  OjpDatedTrainNumberRef,
  OjpFareResult,
  OjpService,
  OjpStopEvent,
  OjpTripLeg,
  OjpTripResponse,
  OjpTripResult,
} from "@openmapx/mobility-formats";
import {
  computeDelaySeconds,
  extractSwissOrganisationNumber,
  mapSwissMode,
  mapSwissOccupancy,
  normalizeSwissLookupKey,
  normalizeText,
  PROVIDER,
  providerId,
  type SwissProviderRuntime,
  type SwissRouteStop,
  swissContributors,
  uniqueModes,
  uniqueStrings,
} from "./common.js";
import type {
  SwissBusinessOrganisation,
  SwissBusinessOrganisationDatasets,
  SwissStopDatasets,
} from "./datasets.js";
import { mapOjpFareBundle, type SwissFareAssignment } from "./fares.js";
import {
  buildStopIds,
  findServicePoint,
  platformCodeFromRef,
  servicePointModes,
} from "./stop-identity.js";

function extractSwissSboid(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  const match = normalized.match(/^(?:ch:1:sboid:)?(\d+)$/i);
  return match?.[1] ? `ch:1:sboid:${match[1]}` : undefined;
}

export function mapOjpFormation(
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

export function collectServiceOperatorRefs(service: OjpService | undefined): string[] {
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

export function mapSwissOperatorMetadata(
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

export function mapOjpServiceInfo(
  runtime: SwissProviderRuntime,
  service: OjpService | undefined,
  operatorMetadata?: SwissBusinessOrganisation,
): TransitServiceInfo | undefined {
  if (!service) return undefined;
  return {
    contributors: snapshotContributors(
      swissContributors(runtime, "ojp"),
      contributorsForFields(operatorMetadata?.fieldContributors, [
        "abbreviation",
        "description",
        "organisationNumber",
        "participantRef",
      ]),
    ),
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

export function serviceRemarks(
  runtime: SwissProviderRuntime,
  service: OjpService | undefined,
): Departure["remarks"] {
  if (!service?.attributes.length) return undefined;
  return service.attributes.map((text) => ({
    contributors: swissContributors(runtime, "ojp"),
    text,
    type: "info" as const,
  }));
}

function legGeometry(runtime: SwissProviderRuntime, leg: OjpTripLeg): TripLeg["geometry"] {
  if (leg.projectionCoordinates.length >= 2) {
    return {
      contributors: swissContributors(runtime, "ojp", "ojp-geometry-osm"),
      type: "LineString",
      coordinates: leg.projectionCoordinates,
    };
  }
  return {
    contributors: swissContributors(runtime, "ojp"),
    type: "LineString",
    coordinates: [
      [leg.start.lng, leg.start.lat],
      [leg.end.lng, leg.end.lat],
    ],
  };
}

export function mapRequestedIntermodalModes(modes: string[] | undefined): string[] | undefined {
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

export function buildRouteFromService(
  runtime: SwissProviderRuntime,
  service: OjpService | undefined,
  operatorMetadata?: SwissBusinessOrganisation,
): TransitRoute | null {
  const shortName = routeShortNameFromService(service);
  const mode = mapSwissMode(service?.ptMode ?? service?.productCategoryShortName);
  if (!shortName || !mode) return null;
  const routeId = routeIdFromService(service);
  if (!routeId) return null;
  return {
    contributors: snapshotContributors(
      swissContributors(runtime, "ojp"),
      contributorsForFields(
        operatorMetadata?.fieldContributors,
        operatorMetadata?.description
          ? ["description"]
          : operatorMetadata?.abbreviation
            ? ["abbreviation"]
            : [],
      ),
    ),
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

export function buildRouteFromStopEvent(
  runtime: SwissProviderRuntime,
  stopEvent: OjpStopEvent,
  operatorMetadata?: SwissBusinessOrganisation,
): TransitRoute | null {
  return buildRouteFromService(runtime, stopEvent.service, operatorMetadata);
}

export function buildDepartureFromStopEvent(
  runtime: SwissProviderRuntime,
  stopEvent: OjpStopEvent,
  type: "departure" | "arrival",
  route = buildRouteFromStopEvent(runtime, stopEvent),
  operatorMetadata?: SwissBusinessOrganisation,
): Departure | null {
  const service = stopEvent.service;
  const serviceInfo = mapOjpServiceInfo(runtime, service, operatorMetadata);
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
  const departure: Departure = {
    contributors: snapshotContributors(
      swissContributors(runtime, "ojp"),
      route.contributors ?? [],
      serviceInfo?.contributors ?? [],
    ),
    delaySeconds: computeDelaySeconds(scheduledAt, expectedAt),
    expectedAt,
    formation: mapOjpFormation(service.datedTrainNumberRefs),
    headsign: service.destinationText || route.longName || route.shortName,
    occupancy:
      mapSwissOccupancy(service.occupancy) ??
      mapSwissOccupancy(type === "departure" ? call.departureOccupancy : call.arrivalOccupancy),
    platform: call.estimatedQuay || call.plannedQuay,
    remarks: serviceRemarks(runtime, service),
    route: {
      contributors: swissContributors(runtime, "ojp"),
      id: route.id,
      longName: route.longName,
      mode: route.mode,
      shortName: route.shortName,
    },
    scheduledAt,
    serviceInfo,
    tripId,
  };
  return {
    ...departure,
    fieldContributors: {
      ...Object.fromEntries(
        Object.keys(departure)
          .filter((field) => field !== "contributors")
          .map((field) => [field, swissContributors(runtime, "ojp")]),
      ),
      route: snapshotContributors(departure.route.contributors ?? []),
      serviceInfo: snapshotContributors(serviceInfo?.contributors ?? []),
    },
  };
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

function mapOjpTripLeg(
  runtime: SwissProviderRuntime,
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
  const serviceInfo = mapOjpServiceInfo(runtime, leg.service, operatorMetadata);
  const mode = leg.kind === "timed" ? mapSwissMode(leg.service?.ptMode) || "rail" : "walking";
  const tripId =
    leg.service?.operatingDayRef && leg.service?.journeyRef
      ? providerId(`${leg.service.operatingDayRef}|${leg.service.journeyRef}`)
      : undefined;
  const routeId = routeIdFromService(leg.service);
  return {
    fieldContributors: {
      mode: swissContributors(runtime, "ojp"),
      route: swissContributors(runtime, "ojp"),
      from: swissContributors(runtime, "ojp"),
      to: swissContributors(runtime, "ojp"),
      geometry: swissContributors(
        runtime,
        "ojp",
        ...(leg.projectionCoordinates.length >= 2 ? ["ojp-geometry-osm"] : []),
      ),
      serviceInfo: serviceInfo?.contributors ?? [],
      ...(fareAssignment
        ? {
            fareTransferIndex: swissContributors(runtime, "ojp-fare"),
            effectiveFareLegIndex: swissContributors(runtime, "ojp-fare"),
          }
        : {}),
    },
    contributors: snapshotContributors(
      swissContributors(
        runtime,
        "ojp",
        ...(leg.projectionCoordinates.length >= 2 ? ["ojp-geometry-osm"] : []),
      ),
      serviceInfo?.contributors ?? [],
      fareAssignment ? swissContributors(runtime, "ojp-fare") : [],
    ),
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
    geometry: legGeometry(runtime, leg),
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

export function mapTripResponseToPlan(
  runtime: SwissProviderRuntime,
  response: OjpTripResponse,
  params: { from: { lat: number; lng: number }; to: { lat: number; lng: number } },
  businessDatasets: SwissBusinessOrganisationDatasets,
  fareResults?: Array<OjpFareResult | undefined>,
): TripPlan | null {
  const itineraries: TripItinerary[] = response.trips.map((trip, index) => {
    const fareBundle = mapOjpFareBundle(runtime, fareResults?.[index], trip);
    const legs = trip.legs.map((leg) =>
      mapOjpTripLeg(
        runtime,
        leg,
        businessDatasets,
        leg.id ? fareBundle?.legAssignments.get(leg.id) : undefined,
      ),
    );
    return {
      contributors: snapshotContributors(
        contributorsForRecords(legs),
        fareBundle?.fare.contributors ?? [],
      ),
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
    contributors: contributorsForRecords(itineraries),
    provider: PROVIDER,
    to: {
      lat: params.to.lat,
      lng: params.to.lng,
      name: itineraries[0]?.legs.at(-1)?.to.name || "Destination",
    },
  };
}

export function coordinatesFromTrackSections(
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

export function dedupeJourneyCalls(calls: OjpCall[]): OjpCall[] {
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

export function stopEventCalls(stopEvent: OjpStopEvent): OjpCall[] {
  return dedupeJourneyCalls([
    ...stopEvent.previousCalls,
    ...(stopEvent.thisCall ? [stopEvent.thisCall] : []),
    ...stopEvent.onwardCalls,
  ]);
}

/**
 * A call's position: OJP's own, else the stop point's, else the service
 * point's. Null when none of them is placed.
 */
function callPosition(
  call: OjpCall,
  ...fallbacks: Array<{ lat?: number | null; lng?: number | null } | undefined>
): { lat: number; lng: number } | null {
  const candidates = [
    { lat: call.geoPosition?.latitude, lng: call.geoPosition?.longitude },
    ...fallbacks,
  ];
  for (const candidate of candidates) {
    const position = latLngOrNull(candidate?.lat, candidate?.lng);
    if (position) return position;
  }
  return null;
}

/** A journey stop; one OJP and master data cannot place keeps its place without coordinates. */
export function mapJourneyStopFromCall(
  runtime: SwissProviderRuntime,
  call: OjpCall,
  datasets: SwissStopDatasets,
): VehicleJourney["stops"][number] {
  const rawRef = call.stopPointRef;
  const { servicePoint, stopPoint } = rawRef ? findServicePoint(rawRef, datasets) : {};
  const position = callPosition(call, stopPoint, servicePoint);
  const scheduledArrival = call.arrivalTimetabled;
  const expectedArrival = call.arrivalEstimated;
  const scheduledDeparture = call.departureTimetabled;
  const expectedDeparture = call.departureEstimated;
  return {
    contributors: swissContributors(
      runtime,
      "ojp",
      ...(findServicePoint(call.stopPointRef ?? "", datasets).servicePoint ? ["master-data"] : []),
    ),
    delaySeconds:
      computeDelaySeconds(scheduledDeparture, expectedDeparture) ??
      computeDelaySeconds(scheduledArrival, expectedArrival),
    expectedArrival,
    expectedDeparture,
    ...(position ? { lat: position.lat, lng: position.lng } : {}),
    name: call.name || stopPoint?.designationOfficial || servicePoint?.name || rawRef || "Unknown",
    platform: call.estimatedQuay || call.plannedQuay,
    scheduledArrival,
    scheduledDeparture,
    stopId: rawRef ? providerId(rawRef) : providerId(call.name),
  };
}

export function mapRouteStopFromCall(
  runtime: SwissProviderRuntime,
  call: OjpCall,
  datasets: SwissStopDatasets,
  mode: TransportMode,
  sequence: number,
): SwissRouteStop {
  const rawRef = call.stopPointRef ?? `route-stop:${sequence}:${call.name ?? "unknown"}`;
  const { didok, servicePoint, servicePointSloid, stopPoint } = findServicePoint(rawRef, datasets);
  const position = callPosition(call, stopPoint, servicePoint);
  const ids = buildStopIds(rawRef, { didok, servicePointSloid });
  return {
    contributors: swissContributors(
      runtime,
      "ojp",
      ...(findServicePoint(call.stopPointRef ?? "", datasets).servicePoint ? ["master-data"] : []),
    ),
    id: providerId(rawRef),
    ...(ids.primaryScheme ? { primaryScheme: ids.primaryScheme } : {}),
    ...(ids.ids ? { ids: ids.ids } : {}),
    ...(position ? { lat: position.lat, lng: position.lng } : {}),
    modes: uniqueModes([mode, ...servicePointModes(servicePoint)]),
    name: call.name || stopPoint?.designationOfficial || servicePoint?.name || rawRef,
    parentStationId: servicePoint ? providerId(servicePoint.servicePointSloid) : undefined,
    platformCode: call.estimatedQuay || call.plannedQuay || platformCodeFromRef(call.stopPointRef),
    provider: PROVIDER,
    sequence,
  };
}

export function routeStopsFromJourney(
  journey: VehicleJourney,
  mode: TransportMode | undefined,
): SwissRouteStop[] {
  return journey.stops.map((stop, index) => ({
    id: stop.stopId,
    ...(stop.lat !== undefined && stop.lng !== undefined ? { lat: stop.lat, lng: stop.lng } : {}),
    modes: mode ? [mode] : [],
    name: stop.name,
    platformCode: stop.platform,
    provider: PROVIDER,
    sequence: index + 1,
  }));
}
