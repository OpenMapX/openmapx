import { listNetexElementsByName, type NetexElement, type NetexEnvelope } from "./netex.js";
import {
  getXmlAttribute,
  getXmlChild,
  getXmlChildren,
  isXmlObject,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

export interface NetexCode {
  key?: string;
  type: "keyValue" | "privateCode" | "publicCode";
  value: string;
}

export interface NetexPoint {
  latitude?: number;
  longitude?: number;
}

export interface NetexEntitySummary {
  codes: NetexCode[];
  description?: string;
  id: string;
  name?: string;
  privateCode?: string;
  publicCode?: string;
  shortName?: string;
}

export interface NetexStopPlaceRecord extends NetexEntitySummary {
  centroid?: NetexPoint;
  parentSiteRef?: string;
  quayRefs: string[];
  transportMode?: string;
}

export interface NetexQuayRecord extends NetexEntitySummary {
  centroid?: NetexPoint;
  stopPlaceRef?: string;
}

export interface NetexScheduledStopPointRecord extends NetexEntitySummary {
  transportMode?: string;
}

export interface NetexPassengerStopAssignmentRecord {
  id: string;
  order?: number;
  quayRef?: string;
  scheduledStopPointRef?: string;
  stopPlaceRef?: string;
}

export interface NetexLineRecord extends NetexEntitySummary {
  authorityRef?: string;
  operatorRef?: string;
  transportMode?: string;
}

export interface NetexRoutePointRecord {
  id?: string;
  order?: number;
  routePointRef?: string;
  scheduledStopPointRef?: string;
}

export interface NetexRouteRecord extends NetexEntitySummary {
  directionType?: string;
  lineRef?: string;
  pointsInSequence: NetexRoutePointRecord[];
}

export interface NetexJourneyPatternPointRecord {
  destinationDisplayRef?: string;
  forAlighting?: boolean;
  forBoarding?: boolean;
  id?: string;
  order?: number;
  scheduledStopPointRef?: string;
}

export interface NetexJourneyPatternRecord extends NetexEntitySummary {
  directionType?: string;
  pointsInSequence: NetexJourneyPatternPointRecord[];
  routeRef?: string;
}

export interface NetexServiceJourneyCallRecord {
  arrivalTime?: string;
  departureTime?: string;
  forAlighting?: boolean;
  forBoarding?: boolean;
  id?: string;
  order?: number;
  stopPointInJourneyPatternRef?: string;
}

export interface NetexServiceJourneyRecord extends NetexEntitySummary {
  dayTypeRefs: string[];
  journeyPatternRef?: string;
  lineRef?: string;
  operatorRef?: string;
  passingTimes: NetexServiceJourneyCallRecord[];
  transportMode?: string;
}

export interface NetexTransitGraph {
  assignmentsByQuayRef: Record<string, string[]>;
  assignmentsByScheduledStopPointRef: Record<string, string[]>;
  journeyPatternsById: Record<string, NetexJourneyPatternRecord>;
  linesById: Record<string, NetexLineRecord>;
  passengerStopAssignmentsById: Record<string, NetexPassengerStopAssignmentRecord>;
  quaysById: Record<string, NetexQuayRecord>;
  quaysByStopPlaceRef: Record<string, string[]>;
  routesById: Record<string, NetexRouteRecord>;
  scheduledStopPointsById: Record<string, NetexScheduledStopPointRecord>;
  serviceJourneysById: Record<string, NetexServiceJourneyRecord>;
  stopPlacesById: Record<string, NetexStopPlaceRecord>;
}

type NetexInput = string | NetexEnvelope;

function parseBoolean(value: unknown): boolean | undefined {
  const text = xmlText(value);
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

function parseInteger(value: unknown): number | undefined {
  const text = xmlText(value);
  if (!text) return undefined;

  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumber(value: unknown): number | undefined {
  const text = xmlText(value);
  if (!text) return undefined;

  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getNetexRef(node: unknown, key: string): string | undefined {
  const child = getXmlChild(node, key);
  return getXmlAttribute(child, "ref") ?? xmlText(child);
}

function getNetexId(node: unknown): string | undefined {
  return getXmlAttribute(node, "id");
}

function getNetexName(node: unknown): string | undefined {
  return xmlText(isXmlObject(node) ? node.Name : undefined);
}

function getNetexShortName(node: unknown): string | undefined {
  return xmlText(isXmlObject(node) ? node.ShortName : undefined);
}

function getNetexDescription(node: unknown): string | undefined {
  return xmlText(isXmlObject(node) ? node.Description : undefined);
}

function getNetexPublicCode(node: unknown): string | undefined {
  return xmlText(isXmlObject(node) ? node.PublicCode : undefined);
}

function getNetexPrivateCode(node: unknown): string | undefined {
  return xmlText(isXmlObject(node) ? node.PrivateCode : undefined);
}

function getNetexTransportMode(node: unknown): string | undefined {
  return xmlText(isXmlObject(node) ? node.TransportMode : undefined);
}

function getNetexCentroid(node: unknown): NetexPoint | undefined {
  const centroid = getXmlChild(node, "Centroid") ?? getXmlChild(node, "centroid");
  const location = getXmlChild(centroid, "Location") ?? getXmlChild(centroid, "location");
  if (!location) return undefined;

  const latitude = parseNumber(location.Latitude ?? location.latitude);
  const longitude = parseNumber(location.Longitude ?? location.longitude);
  if (latitude == null && longitude == null) return undefined;

  return { latitude, longitude };
}

function listNetexKeyValueCodes(node: unknown): NetexCode[] {
  const containers = [
    getXmlChild(node, "keys"),
    getXmlChild(node, "KeyList"),
    getXmlChild(node, "codes"),
  ].filter(isXmlObject);

  const codes: NetexCode[] = [];
  for (const container of containers) {
    for (const [key, value] of Object.entries(container)) {
      if (key !== "KeyValue") continue;

      for (const entry of xmlNodeToArray(value).filter(isXmlObject)) {
        const codeValue = xmlText(entry.Value) ?? xmlText(entry.value);
        if (!codeValue) continue;

        codes.push({
          key: xmlText(entry.Key) ?? xmlText(entry.key),
          type: "keyValue",
          value: codeValue,
        });
      }
    }
  }

  return codes;
}

export function listNetexCodes(node: unknown): NetexCode[] {
  const codes: NetexCode[] = [];
  const publicCode = getNetexPublicCode(node);
  const privateCode = getNetexPrivateCode(node);

  if (publicCode) codes.push({ type: "publicCode", value: publicCode });
  if (privateCode) codes.push({ type: "privateCode", value: privateCode });

  return [...codes, ...listNetexKeyValueCodes(node)];
}

function createEntitySummary(node: NetexElement): NetexEntitySummary | undefined {
  const id = getNetexId(node);
  if (!id) return undefined;

  return {
    codes: listNetexCodes(node),
    description: getNetexDescription(node),
    id,
    name: getNetexName(node),
    privateCode: getNetexPrivateCode(node),
    publicCode: getNetexPublicCode(node),
    shortName: getNetexShortName(node),
  };
}

function listJourneyPatternPoints(node: NetexElement): NetexJourneyPatternPointRecord[] {
  return getXmlChildren(getXmlChild(node, "pointsInSequence"), "StopPointInJourneyPattern").map(
    (point) => ({
      destinationDisplayRef: getNetexRef(point, "DestinationDisplayRef"),
      forAlighting: parseBoolean(point.ForAlighting),
      forBoarding: parseBoolean(point.ForBoarding),
      id: getNetexId(point),
      order: parseInteger(point.Order),
      scheduledStopPointRef: getNetexRef(point, "ScheduledStopPointRef"),
    }),
  );
}

function listRoutePoints(node: NetexElement): NetexRoutePointRecord[] {
  return getXmlChildren(getXmlChild(node, "pointsInSequence"), "PointOnRoute").map((point) => ({
    id: getNetexId(point),
    order: parseInteger(point.Order),
    routePointRef: getNetexRef(point, "RoutePointRef"),
    scheduledStopPointRef: getNetexRef(point, "ScheduledStopPointRef"),
  }));
}

function listPassingTimes(node: NetexElement): NetexServiceJourneyCallRecord[] {
  const container = getXmlChild(node, "passingTimes");
  if (!container) return [];

  const records: NetexServiceJourneyCallRecord[] = [];
  for (const value of Object.values(container)) {
    for (const entry of xmlNodeToArray(value).filter(isXmlObject)) {
      records.push({
        arrivalTime: xmlText(entry.ArrivalTime),
        departureTime: xmlText(entry.DepartureTime),
        forAlighting: parseBoolean(entry.ForAlighting),
        forBoarding: parseBoolean(entry.ForBoarding),
        id: getNetexId(entry),
        order: parseInteger(entry.Order),
        stopPointInJourneyPatternRef: getNetexRef(entry, "StopPointInJourneyPatternRef"),
      });
    }
  }

  return records;
}

export function buildNetexTransitGraph(input: NetexInput): NetexTransitGraph {
  const stopPlacesById: Record<string, NetexStopPlaceRecord> = {};
  const quaysById: Record<string, NetexQuayRecord> = {};
  const scheduledStopPointsById: Record<string, NetexScheduledStopPointRecord> = {};
  const passengerStopAssignmentsById: Record<string, NetexPassengerStopAssignmentRecord> = {};
  const linesById: Record<string, NetexLineRecord> = {};
  const routesById: Record<string, NetexRouteRecord> = {};
  const journeyPatternsById: Record<string, NetexJourneyPatternRecord> = {};
  const serviceJourneysById: Record<string, NetexServiceJourneyRecord> = {};

  const quaysByStopPlaceRef: Record<string, string[]> = {};
  const assignmentsByScheduledStopPointRef: Record<string, string[]> = {};
  const assignmentsByQuayRef: Record<string, string[]> = {};

  for (const stopPlace of listNetexElementsByName(input, "StopPlace")) {
    const summary = createEntitySummary(stopPlace);
    if (!summary) continue;

    const quayRefs = getXmlChildren(getXmlChild(stopPlace, "quays"), "Quay")
      .map((quay) => getNetexId(quay))
      .filter((ref): ref is string => Boolean(ref));

    stopPlacesById[summary.id] = {
      ...summary,
      centroid: getNetexCentroid(stopPlace),
      parentSiteRef: getNetexRef(stopPlace, "ParentSiteRef"),
      quayRefs,
      transportMode: getNetexTransportMode(stopPlace),
    };

    if (quayRefs.length > 0) quaysByStopPlaceRef[summary.id] = [...quayRefs];
  }

  for (const quay of listNetexElementsByName(input, "Quay")) {
    const summary = createEntitySummary(quay);
    if (!summary) continue;

    let stopPlaceRef = getNetexRef(quay, "StopPlaceRef");
    if (!stopPlaceRef) {
      for (const [candidateStopPlaceRef, quayRefs] of Object.entries(quaysByStopPlaceRef)) {
        if (quayRefs.includes(summary.id)) {
          stopPlaceRef = candidateStopPlaceRef;
          break;
        }
      }
    }

    quaysById[summary.id] = {
      ...summary,
      centroid: getNetexCentroid(quay),
      stopPlaceRef,
    };

    if (stopPlaceRef) {
      const existing = quaysByStopPlaceRef[stopPlaceRef] ?? [];
      if (!existing.includes(summary.id)) existing.push(summary.id);
      quaysByStopPlaceRef[stopPlaceRef] = existing;
    }
  }

  for (const stopPoint of listNetexElementsByName(input, "ScheduledStopPoint")) {
    const summary = createEntitySummary(stopPoint);
    if (!summary) continue;

    scheduledStopPointsById[summary.id] = {
      ...summary,
      transportMode: getNetexTransportMode(stopPoint),
    };
  }

  for (const assignment of listNetexElementsByName(input, "PassengerStopAssignment")) {
    const id = getNetexId(assignment);
    if (!id) continue;

    const record: NetexPassengerStopAssignmentRecord = {
      id,
      order: parseInteger(assignment.Order),
      quayRef: getNetexRef(assignment, "QuayRef"),
      scheduledStopPointRef: getNetexRef(assignment, "ScheduledStopPointRef"),
      stopPlaceRef: getNetexRef(assignment, "StopPlaceRef"),
    };
    passengerStopAssignmentsById[id] = record;

    if (record.scheduledStopPointRef) {
      const refs = assignmentsByScheduledStopPointRef[record.scheduledStopPointRef] ?? [];
      refs.push(id);
      assignmentsByScheduledStopPointRef[record.scheduledStopPointRef] = refs;
    }

    if (record.quayRef) {
      const refs = assignmentsByQuayRef[record.quayRef] ?? [];
      refs.push(id);
      assignmentsByQuayRef[record.quayRef] = refs;
    }
  }

  for (const line of listNetexElementsByName(input, "Line")) {
    const summary = createEntitySummary(line);
    if (!summary) continue;

    linesById[summary.id] = {
      ...summary,
      authorityRef: getNetexRef(line, "AuthorityRef"),
      operatorRef: getNetexRef(line, "OperatorRef"),
      transportMode: getNetexTransportMode(line),
    };
  }

  for (const route of listNetexElementsByName(input, "Route")) {
    const summary = createEntitySummary(route);
    if (!summary) continue;

    routesById[summary.id] = {
      ...summary,
      directionType: xmlText(route.DirectionType),
      lineRef: getNetexRef(route, "LineRef"),
      pointsInSequence: listRoutePoints(route),
    };
  }

  for (const journeyPattern of listNetexElementsByName(input, "JourneyPattern")) {
    const summary = createEntitySummary(journeyPattern);
    if (!summary) continue;

    journeyPatternsById[summary.id] = {
      ...summary,
      directionType: xmlText(journeyPattern.DirectionType),
      pointsInSequence: listJourneyPatternPoints(journeyPattern),
      routeRef: getNetexRef(journeyPattern, "RouteRef"),
    };
  }

  for (const serviceJourney of listNetexElementsByName(input, "ServiceJourney")) {
    const summary = createEntitySummary(serviceJourney);
    if (!summary) continue;

    const dayTypeRefs = getXmlChildren(getXmlChild(serviceJourney, "dayTypes"), "DayTypeRef")
      .map((entry) => getXmlAttribute(entry, "ref") ?? xmlText(entry))
      .filter((ref): ref is string => Boolean(ref));

    serviceJourneysById[summary.id] = {
      ...summary,
      dayTypeRefs,
      journeyPatternRef: getNetexRef(serviceJourney, "JourneyPatternRef"),
      lineRef: getNetexRef(serviceJourney, "LineRef"),
      operatorRef: getNetexRef(serviceJourney, "OperatorRef"),
      passingTimes: listPassingTimes(serviceJourney),
      transportMode: getNetexTransportMode(serviceJourney),
    };
  }

  for (const assignment of Object.values(passengerStopAssignmentsById)) {
    if (assignment.stopPlaceRef) continue;
    if (!assignment.quayRef) continue;

    assignment.stopPlaceRef = quaysById[assignment.quayRef]?.stopPlaceRef;
  }

  return {
    assignmentsByQuayRef,
    assignmentsByScheduledStopPointRef,
    journeyPatternsById,
    linesById,
    passengerStopAssignmentsById,
    quaysById,
    quaysByStopPlaceRef,
    routesById,
    scheduledStopPointsById,
    serviceJourneysById,
    stopPlacesById,
  };
}

export function resolveNetexGraphStopPlace(
  graph: NetexTransitGraph,
  ref: string | null | undefined,
): NetexStopPlaceRecord | undefined {
  if (!ref) return undefined;
  return graph.stopPlacesById[ref];
}

export function resolveNetexGraphQuay(
  graph: NetexTransitGraph,
  ref: string | null | undefined,
): NetexQuayRecord | undefined {
  if (!ref) return undefined;
  return graph.quaysById[ref];
}

export function resolveNetexGraphScheduledStopPoint(
  graph: NetexTransitGraph,
  ref: string | null | undefined,
): NetexScheduledStopPointRecord | undefined {
  if (!ref) return undefined;
  return graph.scheduledStopPointsById[ref];
}

export function resolveNetexGraphLine(
  graph: NetexTransitGraph,
  ref: string | null | undefined,
): NetexLineRecord | undefined {
  if (!ref) return undefined;
  return graph.linesById[ref];
}

export function resolveNetexGraphRoute(
  graph: NetexTransitGraph,
  ref: string | null | undefined,
): NetexRouteRecord | undefined {
  if (!ref) return undefined;
  return graph.routesById[ref];
}

export function resolveNetexGraphJourneyPattern(
  graph: NetexTransitGraph,
  ref: string | null | undefined,
): NetexJourneyPatternRecord | undefined {
  if (!ref) return undefined;
  return graph.journeyPatternsById[ref];
}

export function resolveNetexGraphServiceJourney(
  graph: NetexTransitGraph,
  ref: string | null | undefined,
): NetexServiceJourneyRecord | undefined {
  if (!ref) return undefined;
  return graph.serviceJourneysById[ref];
}

export function resolveNetexAssignmentsForScheduledStopPoint(
  graph: NetexTransitGraph,
  scheduledStopPointRef: string,
): NetexPassengerStopAssignmentRecord[] {
  return (graph.assignmentsByScheduledStopPointRef[scheduledStopPointRef] ?? [])
    .map((assignmentRef) => graph.passengerStopAssignmentsById[assignmentRef])
    .filter((assignment): assignment is NetexPassengerStopAssignmentRecord => Boolean(assignment));
}

export function resolveNetexQuaysForStopPlace(
  graph: NetexTransitGraph,
  stopPlaceRef: string,
): NetexQuayRecord[] {
  return (graph.quaysByStopPlaceRef[stopPlaceRef] ?? [])
    .map((quayRef) => graph.quaysById[quayRef])
    .filter((quay): quay is NetexQuayRecord => Boolean(quay));
}

export function resolveNetexQuaysForScheduledStopPoint(
  graph: NetexTransitGraph,
  scheduledStopPointRef: string,
): NetexQuayRecord[] {
  return resolveNetexAssignmentsForScheduledStopPoint(graph, scheduledStopPointRef)
    .map((assignment) => (assignment.quayRef ? graph.quaysById[assignment.quayRef] : undefined))
    .filter((quay): quay is NetexQuayRecord => Boolean(quay));
}

export function resolveNetexStopPlacesForScheduledStopPoint(
  graph: NetexTransitGraph,
  scheduledStopPointRef: string,
): NetexStopPlaceRecord[] {
  const stopPlaces = new Map<string, NetexStopPlaceRecord>();

  for (const assignment of resolveNetexAssignmentsForScheduledStopPoint(
    graph,
    scheduledStopPointRef,
  )) {
    if (assignment.stopPlaceRef && graph.stopPlacesById[assignment.stopPlaceRef]) {
      stopPlaces.set(assignment.stopPlaceRef, graph.stopPlacesById[assignment.stopPlaceRef]);
    }

    if (assignment.quayRef) {
      const stopPlaceRef = graph.quaysById[assignment.quayRef]?.stopPlaceRef;
      if (stopPlaceRef && graph.stopPlacesById[stopPlaceRef]) {
        stopPlaces.set(stopPlaceRef, graph.stopPlacesById[stopPlaceRef]);
      }
    }
  }

  return [...stopPlaces.values()];
}

export function resolveNetexJourneyPatternPoints(
  graph: NetexTransitGraph,
  journeyPatternRef: string,
): NetexJourneyPatternPointRecord[] {
  return graph.journeyPatternsById[journeyPatternRef]?.pointsInSequence ?? [];
}

export function resolveNetexScheduledStopPointsForJourneyPattern(
  graph: NetexTransitGraph,
  journeyPatternRef: string,
): NetexScheduledStopPointRecord[] {
  return resolveNetexJourneyPatternPoints(graph, journeyPatternRef)
    .map((point) =>
      point.scheduledStopPointRef
        ? graph.scheduledStopPointsById[point.scheduledStopPointRef]
        : undefined,
    )
    .filter((point): point is NetexScheduledStopPointRecord => Boolean(point));
}

export function resolveNetexJourneyPatternForServiceJourney(
  graph: NetexTransitGraph,
  serviceJourney: string | NetexServiceJourneyRecord,
): NetexJourneyPatternRecord | undefined {
  const serviceJourneyRecord =
    typeof serviceJourney === "string" ? graph.serviceJourneysById[serviceJourney] : serviceJourney;
  return serviceJourneyRecord?.journeyPatternRef
    ? graph.journeyPatternsById[serviceJourneyRecord.journeyPatternRef]
    : undefined;
}

export function resolveNetexLineForServiceJourney(
  graph: NetexTransitGraph,
  serviceJourney: string | NetexServiceJourneyRecord,
): NetexLineRecord | undefined {
  const serviceJourneyRecord =
    typeof serviceJourney === "string" ? graph.serviceJourneysById[serviceJourney] : serviceJourney;
  const directLineRef = serviceJourneyRecord?.lineRef;
  if (directLineRef) return graph.linesById[directLineRef];

  const route = resolveNetexRouteForServiceJourney(graph, serviceJourneyRecord ?? "");
  return route?.lineRef ? graph.linesById[route.lineRef] : undefined;
}

export function resolveNetexRouteForServiceJourney(
  graph: NetexTransitGraph,
  serviceJourney: string | NetexServiceJourneyRecord,
): NetexRouteRecord | undefined {
  const journeyPattern = resolveNetexJourneyPatternForServiceJourney(graph, serviceJourney);
  return journeyPattern?.routeRef ? graph.routesById[journeyPattern.routeRef] : undefined;
}
