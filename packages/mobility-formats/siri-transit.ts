import {
  getSiriServiceDelivery,
  listSiriMonitoredStopVisits,
  listSiriVehicleActivities,
  type SiriElement,
  type SiriEnvelope,
} from "./siri.js";
import {
  getXmlAttribute,
  getXmlChild,
  getXmlChildren,
  isXmlObject,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

export interface SiriTextValue {
  language?: string;
  value: string;
}

export interface SiriDeliveryStatus {
  deliveryName: string;
  requestMessageRef?: string;
  responseTimestamp?: string;
  status?: boolean;
  validUntil?: string;
  errorConditionType?: string;
  errorDescription?: string;
  version?: string;
}

export interface SiriJourneyRefs {
  dataFrameRef?: string;
  datedVehicleJourneyRef?: string;
  destinationRef?: string;
  directionRef?: string;
  journeyPatternRef?: string;
  lineRef?: string;
  operatorRef?: string;
  originRef?: string;
  routeRef?: string;
  vehicleRef?: string;
}

export interface SiriVehicleLocation {
  latitude?: number;
  longitude?: number;
}

export interface SiriCall {
  arrivalPlatformName?: string;
  arrivalStatus?: string;
  aimedArrivalTime?: string;
  aimedDepartureTime?: string;
  actualArrivalTime?: string;
  actualDepartureTime?: string;
  departurePlatformName?: string;
  departureStatus?: string;
  destinationDisplay?: string;
  expectedArrivalTime?: string;
  expectedDepartureTime?: string;
  order?: number;
  stopPointName?: string;
  stopPointRef?: string;
  visitNumber?: number;
}

export interface SiriMonitoredVehicleJourney {
  bearing?: number;
  delay?: string;
  destinationName?: string;
  destinationText?: SiriTextValue[];
  lineName?: string;
  lineNames?: SiriTextValue[];
  location?: SiriVehicleLocation;
  monitoredCall?: SiriCall;
  occupancy?: string;
  onwardCalls: SiriCall[];
  originAimedDepartureTime?: string;
  originName?: string;
  originText?: SiriTextValue[];
  progressRate?: string;
  progressStatus?: string;
  refs: SiriJourneyRefs;
  vehicleMode?: string;
}

export interface SiriVehicleActivityRecord {
  journey: SiriMonitoredVehicleJourney;
  recordedAtTime?: string;
  validUntilTime?: string;
}

export interface SiriMonitoredStopVisitRecord {
  journey: SiriMonitoredVehicleJourney;
  monitoringRef?: string;
  recordedAtTime?: string;
}

export interface SiriValidityPeriod {
  endTime?: string;
  startTime?: string;
}

export interface SiriSituationConsequence {
  advice?: string;
  blocking?: boolean;
  condition?: string;
  effect?: string;
  severity?: string;
}

export interface SiriSituationAffects {
  lineRefs: string[];
  networkRefs: string[];
  operatorRefs: string[];
  routeRefs: string[];
  stopPlaceRefs: string[];
  stopPointRefs: string[];
  vehicleJourneyRefs: string[];
  vehicleRefs: string[];
}

export interface SiriSituation {
  creationTime?: string;
  consequences: SiriSituationConsequence[];
  descriptions: SiriTextValue[];
  id?: string;
  lineRefs: string[];
  networkRefs: string[];
  operatorRefs: string[];
  participantRef?: string;
  publicationWindows: SiriValidityPeriod[];
  progress?: string;
  reality?: string;
  reportType?: string;
  routeRefs: string[];
  severity?: string;
  situationNumber?: string;
  stopPlaceRefs: string[];
  stopPointRefs: string[];
  summaries: SiriTextValue[];
  type: string;
  validityPeriods: SiriValidityPeriod[];
  vehicleRefs: string[];
  vehicleJourneyRefs: string[];
  affects: SiriSituationAffects;
}

type SiriInput = string | SiriEnvelope;

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

function parseFloatNumber(value: unknown): number | undefined {
  const text = xmlText(value);
  if (!text) return undefined;

  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function collectSiriTextValues(node: unknown, results: SiriTextValue[]): void {
  if (node == null) return;

  if (Array.isArray(node)) {
    for (const item of node) collectSiriTextValues(item, results);
    return;
  }

  const value = xmlText(node);
  if (value != null) {
    results.push({
      language: getXmlAttribute(node, "lang") ?? getXmlAttribute(node, "xml:lang"),
      value,
    });
    return;
  }

  if (!isXmlObject(node)) return;

  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    collectSiriTextValues(child, results);
  }
}

function dedupeTextValues(values: SiriTextValue[]): SiriTextValue[] {
  const seen = new Set<string>();
  const deduped: SiriTextValue[] = [];

  for (const value of values) {
    const key = `${value.language ?? ""}\u0000${value.value}`;
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(value);
  }

  return deduped;
}

export function listSiriTextValues(node: unknown): SiriTextValue[] {
  const values: SiriTextValue[] = [];
  collectSiriTextValues(node, values);
  return dedupeTextValues(values);
}

export function resolveSiriTextValue(
  node: unknown,
  preferredLanguages: string[] = [],
): string | undefined {
  const values = listSiriTextValues(node);
  if (values.length === 0) return undefined;

  const normalizedLanguages = preferredLanguages.map((language) => language.toLowerCase());
  for (const language of normalizedLanguages) {
    const exactMatch = values.find((entry) => entry.language?.toLowerCase() === language);
    if (exactMatch) return exactMatch.value;

    const baseLanguage = language.split("-")[0];
    const partialMatch = values.find((entry) => {
      const entryLanguage = entry.language?.toLowerCase();
      return entryLanguage === baseLanguage || entryLanguage?.startsWith(`${baseLanguage}-`);
    });
    if (partialMatch) return partialMatch.value;
  }

  return values[0]?.value;
}

function getNestedRef(node: unknown, key: string): string | undefined {
  const child = getXmlChild(node, key);
  return getXmlAttribute(child, "ref") ?? xmlText(child);
}

function normalizeSiriCall(call: unknown): SiriCall | undefined {
  if (!isXmlObject(call)) return undefined;

  return {
    arrivalPlatformName: resolveSiriTextValue(call.ArrivalPlatformName),
    arrivalStatus: xmlText(call.ArrivalStatus),
    aimedArrivalTime: xmlText(call.AimedArrivalTime),
    aimedDepartureTime: xmlText(call.AimedDepartureTime),
    actualArrivalTime: xmlText(call.ActualArrivalTime),
    actualDepartureTime: xmlText(call.ActualDepartureTime),
    departurePlatformName: resolveSiriTextValue(call.DeparturePlatformName),
    departureStatus: xmlText(call.DepartureStatus),
    destinationDisplay: resolveSiriTextValue(call.DestinationDisplay),
    expectedArrivalTime: xmlText(call.ExpectedArrivalTime),
    expectedDepartureTime: xmlText(call.ExpectedDepartureTime),
    order: parseInteger(call.Order),
    stopPointName: resolveSiriTextValue(call.StopPointName),
    stopPointRef: xmlText(call.StopPointRef),
    visitNumber: parseInteger(call.VisitNumber),
  };
}

export function normalizeSiriDeliveryStatus(
  delivery: SiriElement,
  deliveryName: string,
): SiriDeliveryStatus {
  const errorCondition = getXmlChild(delivery, "ErrorCondition");
  let errorConditionType: string | undefined;

  if (errorCondition) {
    for (const [key, value] of Object.entries(errorCondition)) {
      if (key.startsWith("@_") || key === "Description") continue;
      if (xmlNodeToArray(value).some((entry) => entry != null)) {
        errorConditionType = key;
        break;
      }
    }
  }

  return {
    deliveryName,
    errorConditionType,
    errorDescription:
      xmlText(errorCondition?.Description) ?? resolveSiriTextValue(errorCondition?.Description),
    requestMessageRef: xmlText(delivery.RequestMessageRef),
    responseTimestamp: xmlText(delivery.ResponseTimestamp),
    status: parseBoolean(delivery.Status),
    validUntil: xmlText(delivery.ValidUntil),
    version: getXmlAttribute(delivery, "version"),
  };
}

export function listSiriDeliveryStatuses(input: SiriInput): SiriDeliveryStatus[] {
  const delivery = getSiriServiceDelivery(input);
  if (!delivery) return [];

  const statuses: SiriDeliveryStatus[] = [];
  for (const [key, value] of Object.entries(delivery)) {
    if (!key.endsWith("Delivery")) continue;

    for (const item of xmlNodeToArray(value).filter(isXmlObject)) {
      statuses.push(normalizeSiriDeliveryStatus(item, key));
    }
  }

  return statuses;
}

export function normalizeSiriMonitoredVehicleJourney(
  journey: SiriElement | undefined,
): SiriMonitoredVehicleJourney | undefined {
  if (!journey) return undefined;

  const framedVehicleJourneyRef = getXmlChild(journey, "FramedVehicleJourneyRef");
  const onwardCallsContainer = getXmlChild(journey, "OnwardCalls");
  const onwardCalls = getXmlChildren(onwardCallsContainer, "OnwardCall")
    .map((call) => normalizeSiriCall(call))
    .filter((call): call is SiriCall => Boolean(call));
  const location = getXmlChild(journey, "VehicleLocation");

  return {
    bearing: parseFloatNumber(journey.Bearing),
    delay: xmlText(journey.Delay),
    destinationName: resolveSiriTextValue(journey.DestinationName),
    destinationText: listSiriTextValues(journey.DestinationName),
    lineName: resolveSiriTextValue(journey.PublishedLineName),
    lineNames: listSiriTextValues(journey.PublishedLineName),
    location:
      location != null
        ? {
            latitude: parseFloatNumber(location.Latitude),
            longitude: parseFloatNumber(location.Longitude),
          }
        : undefined,
    monitoredCall: normalizeSiriCall(getXmlChild(journey, "MonitoredCall")),
    occupancy: xmlText(journey.Occupancy),
    onwardCalls,
    originAimedDepartureTime: xmlText(journey.OriginAimedDepartureTime),
    originName: resolveSiriTextValue(journey.OriginName),
    originText: listSiriTextValues(journey.OriginName),
    progressRate: xmlText(journey.ProgressRate),
    progressStatus: xmlText(journey.ProgressStatus),
    refs: {
      dataFrameRef: xmlText(framedVehicleJourneyRef?.DataFrameRef),
      datedVehicleJourneyRef: xmlText(framedVehicleJourneyRef?.DatedVehicleJourneyRef),
      destinationRef: xmlText(journey.DestinationRef),
      directionRef: xmlText(journey.DirectionRef),
      journeyPatternRef: getNestedRef(journey, "JourneyPatternRef"),
      lineRef: xmlText(journey.LineRef),
      operatorRef: xmlText(journey.OperatorRef),
      originRef: xmlText(journey.OriginRef),
      routeRef: getNestedRef(journey, "RouteRef"),
      vehicleRef: xmlText(journey.VehicleRef),
    },
    vehicleMode:
      xmlText(journey.VehicleMode) ??
      xmlText(getXmlChild(getXmlChild(journey, "VehicleModes"), "VehicleMode")),
  };
}

export function normalizeSiriVehicleActivity(
  activity: SiriElement,
): SiriVehicleActivityRecord | undefined {
  const journey = normalizeSiriMonitoredVehicleJourney(
    getXmlChild(activity, "MonitoredVehicleJourney"),
  );
  if (!journey) return undefined;

  return {
    journey,
    recordedAtTime: xmlText(activity.RecordedAtTime),
    validUntilTime: xmlText(activity.ValidUntilTime),
  };
}

export function listSiriVehicleActivityRecords(input: SiriInput): SiriVehicleActivityRecord[] {
  return listSiriVehicleActivities(input)
    .map((activity) => normalizeSiriVehicleActivity(activity))
    .filter((activity): activity is SiriVehicleActivityRecord => Boolean(activity));
}

export function normalizeSiriMonitoredStopVisit(
  visit: SiriElement,
): SiriMonitoredStopVisitRecord | undefined {
  const journey = normalizeSiriMonitoredVehicleJourney(
    getXmlChild(visit, "MonitoredVehicleJourney"),
  );
  if (!journey) return undefined;

  return {
    journey,
    monitoringRef: xmlText(visit.MonitoringRef),
    recordedAtTime: xmlText(visit.RecordedAtTime),
  };
}

export function listSiriMonitoredStopVisitRecords(
  input: SiriInput,
): SiriMonitoredStopVisitRecord[] {
  return listSiriMonitoredStopVisits(input)
    .map((visit) => normalizeSiriMonitoredStopVisit(visit))
    .filter((visit): visit is SiriMonitoredStopVisitRecord => Boolean(visit));
}

function collectSituationRefValues(node: unknown, key: string, values: Set<string>): void {
  if (node == null) return;

  if (Array.isArray(node)) {
    for (const item of node) collectSituationRefValues(item, key, values);
    return;
  }

  if (!isXmlObject(node)) return;

  for (const [childKey, childValue] of Object.entries(node)) {
    if (childKey.startsWith("@_")) continue;

    if (childKey === key) {
      for (const candidate of xmlNodeToArray(childValue)) {
        const value =
          getXmlAttribute(candidate, "ref") ??
          getXmlAttribute(candidate, "id") ??
          xmlText(candidate);
        if (value) values.add(value);
      }
    }

    collectSituationRefValues(childValue, key, values);
  }
}

function listSituationEntries(
  input: SiriInput,
): Array<{ elementName: string; element: SiriElement }> {
  const serviceDelivery = getSiriServiceDelivery(input);
  if (!serviceDelivery) return [];

  const entries: Array<{ elementName: string; element: SiriElement }> = [];
  for (const delivery of getXmlChildren(serviceDelivery, "SituationExchangeDelivery")) {
    const situations = getXmlChild(delivery, "Situations");
    if (!situations) continue;

    for (const [key, value] of Object.entries(situations)) {
      if (!key.endsWith("SituationElement")) continue;
      for (const element of xmlNodeToArray(value).filter(isXmlObject)) {
        entries.push({ element, elementName: key });
      }
    }
  }

  return entries;
}

function listSiriValidityPeriods(node: SiriElement): SiriValidityPeriod[] {
  const periodsContainer = getXmlChild(node, "ValidityPeriods");
  if (!periodsContainer) return [];

  return getXmlChildren(periodsContainer, "ValidityPeriod").map((period) => ({
    endTime: xmlText(period.EndTime),
    startTime: xmlText(period.StartTime),
  }));
}

function listSiriConsequences(node: SiriElement): SiriSituationConsequence[] {
  return getXmlChildren(getXmlChild(node, "Consequences"), "Consequence").map((consequence) => ({
    advice: resolveSiriTextValue(consequence.Advice),
    blocking: parseBoolean(consequence.Blocking),
    condition: xmlText(consequence.Condition),
    effect: xmlText(consequence.Effect),
    severity: xmlText(consequence.Severity),
  }));
}

function listSiriPublicationWindows(node: SiriElement): SiriValidityPeriod[] {
  const windows = getXmlChild(node, "PublicationWindows");
  if (!windows) return [];

  return getXmlChildren(windows, "PublicationWindow").map((window) => ({
    endTime: xmlText(window.EndTime),
    startTime: xmlText(window.StartTime),
  }));
}

export function normalizeSiriSituation(element: SiriElement, elementName: string): SiriSituation {
  const stopPointRefs = new Set<string>();
  const stopPlaceRefs = new Set<string>();
  const lineRefs = new Set<string>();
  const networkRefs = new Set<string>();
  const routeRefs = new Set<string>();
  const operatorRefs = new Set<string>();
  const vehicleRefs = new Set<string>();
  const vehicleJourneyRefs = new Set<string>();

  collectSituationRefValues(element, "StopPointRef", stopPointRefs);
  collectSituationRefValues(element, "StopPlaceRef", stopPlaceRefs);
  collectSituationRefValues(element, "LineRef", lineRefs);
  collectSituationRefValues(element, "NetworkRef", networkRefs);
  collectSituationRefValues(element, "RouteRef", routeRefs);
  collectSituationRefValues(element, "OperatorRef", operatorRefs);
  collectSituationRefValues(element, "VehicleRef", vehicleRefs);
  collectSituationRefValues(element, "VehicleJourneyRef", vehicleJourneyRefs);
  collectSituationRefValues(element, "DatedVehicleJourneyRef", vehicleJourneyRefs);

  const summaryNode = element.Summary ?? element.SummaryText;
  const descriptionNode = element.Description ?? element.DescriptionText;
  const consequences = listSiriConsequences(element);
  const affects = {
    lineRefs: [...lineRefs],
    networkRefs: [...networkRefs],
    operatorRefs: [...operatorRefs],
    routeRefs: [...routeRefs],
    stopPlaceRefs: [...stopPlaceRefs],
    stopPointRefs: [...stopPointRefs],
    vehicleJourneyRefs: [...vehicleJourneyRefs],
    vehicleRefs: [...vehicleRefs],
  } satisfies SiriSituationAffects;

  return {
    creationTime: xmlText(element.CreationTime),
    consequences,
    descriptions: listSiriTextValues(descriptionNode),
    id: getXmlAttribute(element, "id"),
    lineRefs: affects.lineRefs,
    networkRefs: affects.networkRefs,
    operatorRefs: affects.operatorRefs,
    participantRef: xmlText(element.ParticipantRef),
    progress: xmlText(element.Progress),
    publicationWindows: listSiriPublicationWindows(element),
    reality: xmlText(element.Reality),
    reportType: xmlText(element.ReportType),
    routeRefs: affects.routeRefs,
    severity: xmlText(element.Severity) ?? consequences[0]?.severity,
    situationNumber: xmlText(element.SituationNumber),
    stopPlaceRefs: affects.stopPlaceRefs,
    stopPointRefs: affects.stopPointRefs,
    summaries: listSiriTextValues(summaryNode),
    type: elementName,
    validityPeriods: listSiriValidityPeriods(element),
    vehicleJourneyRefs: affects.vehicleJourneyRefs,
    vehicleRefs: affects.vehicleRefs,
    affects,
  };
}

export function listSiriSituations(input: SiriInput): SiriSituation[] {
  return listSituationEntries(input).map(({ element, elementName }) =>
    normalizeSiriSituation(element, elementName),
  );
}
