import {
  getOjpDelivery,
  type OjpGeoPosition,
  ojpChildren,
  ojpChildText,
  ojpGeoPosition,
  ojpText,
  ojpTexts,
  parseOjpXmlDocument,
} from "./ojp.js";
import { getXmlChild, getXmlChildren, isXmlObject, type XmlObject } from "./xml.js";

export interface OjpPlace {
  complete?: boolean;
  lat: number;
  lng: number;
  modes: string[];
  name: string;
  parentRef?: string;
  placeType: "stop_place" | "stop_point" | "topographic_place" | "poi" | "address" | "location";
  privateCode?: string;
  probability?: number;
  ref: string;
  stopPlaceRef?: string;
  stopPointRef?: string;
  topographicPlaceRef?: string;
}

export interface OjpAttributeDetail {
  accessFacility?: string;
  code?: string;
  text?: string;
  userText?: string;
}

export interface OjpDatedTrainNumberRef {
  operatorRef?: string;
  operatingDayRef?: string;
  trainNumber?: string;
}

export interface OjpCall {
  arrivalEstimated?: string;
  arrivalFormationRefs?: OjpDatedTrainNumberRef[];
  arrivalOccupancy?: string;
  arrivalTimetabled?: string;
  departureEstimated?: string;
  departureFormationRefs?: OjpDatedTrainNumberRef[];
  departureOccupancy?: string;
  departureTimetabled?: string;
  estimatedQuay?: string;
  geoPosition?: OjpGeoPosition;
  name: string;
  nameSuffix?: string;
  order?: number;
  plannedQuay?: string;
  stopPointRef?: string;
}

export interface OjpService {
  attributeDetails: OjpAttributeDetail[];
  attributes: string[];
  canceled?: boolean;
  datedTrainNumberRefs: OjpDatedTrainNumberRef[];
  destinationStopPointRef?: string;
  destinationText?: string;
  deviation?: boolean;
  directionRef?: string;
  journeyRef?: string;
  lineRef?: string;
  modeName?: string;
  modeShortName?: string;
  occupancy?: string;
  operatorRef?: string;
  operatorRefs: string[];
  operatingDayRef?: string;
  originStopPointRef?: string;
  originText?: string;
  productCategoryName?: string;
  productCategoryRef?: string;
  productCategoryShortName?: string;
  ptMode?: string;
  publishedLineName?: string;
  publishedServiceName?: string;
  routeDescription?: string;
  serviceFeatureRefs: string[];
  situationIds: string[];
  submode?: string;
  trainNumber?: string;
  undefinedDelay?: boolean;
  unplanned?: boolean;
  vehicleFeatureRefs: string[];
  vehicleRef?: string;
  viaStopPointRefs: string[];
  viaTexts: string[];
}

export interface OjpStopEvent {
  onwardCalls: OjpCall[];
  previousCalls: OjpCall[];
  service?: OjpService;
  thisCall?: OjpCall;
}

export interface OjpLegEndpoint {
  lat: number;
  lng: number;
  name: string;
  stopPointRef?: string;
}

export interface OjpTripLeg {
  alightCall?: OjpCall;
  attributes: string[];
  attributeDetails: OjpAttributeDetail[];
  boardCall?: OjpCall;
  bufferTimeSeconds?: number;
  durationSeconds?: number;
  end: OjpLegEndpoint;
  feasibility: string[];
  guidanceTexts: string[];
  id?: string;
  intermediateCalls: OjpCall[];
  kind: "continuous" | "timed" | "transfer";
  lengthMeters?: number;
  personalMode?: string;
  projectionCoordinates: [number, number][];
  service?: OjpService;
  situationIds: string[];
  start: OjpLegEndpoint;
  timeWindowEnd?: string;
  timeWindowStart?: string;
  transferMode?: string;
  transferType?: string;
  walkDurationSeconds?: number;
}

export interface OjpTripResult {
  distanceMeters?: number;
  durationSeconds?: number;
  endTime?: string;
  id?: string;
  legs: OjpTripLeg[];
  startTime?: string;
  transfers?: number;
}

export interface OjpJourneyTrackSection {
  coordinates: [number, number][];
  durationSeconds?: number;
  endStopPointRef?: string;
  startStopPointRef?: string;
}

export interface OjpTripInfoResult {
  onwardCalls: OjpCall[];
  position?: OjpGeoPosition;
  previousCalls: OjpCall[];
  service?: OjpService;
  trackSections: OjpJourneyTrackSection[];
}

export interface OjpFareProduct {
  authorityName?: string;
  authorityRef?: string;
  id?: string;
  infoUrls?: string[];
  name: string;
  amount?: number;
  currency?: string;
  netAmount?: number;
  saleUrls?: string[];
  travelClass?: string;
  vatRate?: number;
}

export interface OjpFareTripResult {
  fromLegId?: string;
  products: OjpFareProduct[];
  toLegId?: string;
}

export interface OjpFareResult {
  id?: string;
  trips: OjpFareTripResult[];
}

export interface OjpLocationInformationResponse {
  places: OjpPlace[];
}

export interface OjpStopEventResponse {
  places: OjpPlace[];
  stopEvents: OjpStopEvent[];
}

export interface OjpTripResponse {
  places: OjpPlace[];
  trips: OjpTripResult[];
}

export interface OjpTripInfoResponse {
  places: OjpPlace[];
  tripInfo?: OjpTripInfoResult;
}

export interface OjpFareResponse {
  fares: OjpFareResult[];
}

function parseIsoDurationSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? Math.round(total) : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function readPtMode(node: unknown): {
  modeName?: string;
  modeShortName?: string;
  ptMode?: string;
  submode?: string;
} {
  const mode = getXmlChild(node, "Mode");
  if (!mode) return {};
  const submodeKey = Object.keys(mode).find((key) => key.endsWith("Submode"));
  return {
    modeName: ojpText(getXmlChild(mode, "Name")),
    modeShortName: ojpText(getXmlChild(mode, "ShortName")),
    ptMode: ojpChildText(mode, "PtMode"),
    submode: submodeKey ? ojpChildText(mode, submodeKey) : undefined,
  };
}

function readPlaceModes(node: unknown): string[] {
  const modes = ojpChildren(node, "Mode");
  const values = new Set<string>();
  for (const mode of modes) {
    const ptMode = ojpChildText(mode, "PtMode");
    if (ptMode) values.add(ptMode);
  }
  return [...values];
}

function readPlaceRef(placeNode: XmlObject): OjpPlace {
  const stopPlace = getXmlChild(placeNode, "StopPlace");
  const stopPoint = getXmlChild(placeNode, "StopPoint");
  const topographicPlace = getXmlChild(placeNode, "TopographicPlace");
  const geo = ojpGeoPosition(placeNode);
  const baseName =
    ojpText(getXmlChild(placeNode, "Name")) ??
    ojpText(stopPlace ? getXmlChild(stopPlace, "StopPlaceName") : undefined) ??
    ojpText(stopPoint ? getXmlChild(stopPoint, "StopPointName") : undefined) ??
    ojpText(topographicPlace ? getXmlChild(topographicPlace, "TopographicPlaceName") : undefined) ??
    "Unknown";

  if (stopPoint && geo) {
    const stopPointRef = ojpChildText(stopPoint, "StopPointRef");
    return {
      lat: geo.latitude,
      lng: geo.longitude,
      modes: readPlaceModes(placeNode),
      name: baseName,
      parentRef: ojpChildText(stopPoint, "ParentRef"),
      placeType: "stop_point",
      ref: stopPointRef ?? baseName,
      stopPointRef: stopPointRef ?? undefined,
      topographicPlaceRef: ojpChildText(stopPoint, "TopographicPlaceRef"),
    };
  }
  if (stopPlace && geo) {
    const stopPlaceRef = ojpChildText(stopPlace, "StopPlaceRef");
    return {
      lat: geo.latitude,
      lng: geo.longitude,
      modes: readPlaceModes(placeNode),
      name: baseName,
      placeType: "stop_place",
      privateCode: ojpChildText(getXmlChild(stopPlace, "PrivateCode"), "Value"),
      ref: stopPlaceRef ?? baseName,
      stopPlaceRef: stopPlaceRef ?? undefined,
      topographicPlaceRef: ojpChildText(stopPlace, "TopographicPlaceRef"),
    };
  }
  if (topographicPlace && geo) {
    const ref = ojpChildText(topographicPlace, "TopographicPlaceCode") ?? baseName;
    return {
      lat: geo.latitude,
      lng: geo.longitude,
      modes: [],
      name: baseName,
      placeType: "topographic_place",
      ref,
    };
  }
  const ref =
    ojpChildText(placeNode, "PlaceRef") ??
    ojpChildText(placeNode, "PointOfInterestRef") ??
    ojpChildText(placeNode, "AddressRef") ??
    baseName;
  return {
    lat: geo?.latitude ?? 0,
    lng: geo?.longitude ?? 0,
    modes: [],
    name: baseName,
    placeType: "location",
    ref,
  };
}

function parsePlaceResults(nodes: XmlObject[]): OjpPlace[] {
  return nodes
    .map((node) => {
      const place = getXmlChild(node, "Place");
      if (!place) return null;
      const parsed = readPlaceRef(place);
      const probability = parseNumber(ojpChildText(node, "Probability"));
      const completeText = ojpChildText(node, "Complete");
      return {
        ...parsed,
        ...(probability != null ? { probability } : {}),
        ...(completeText != null ? { complete: completeText === "true" } : {}),
      } satisfies OjpPlace;
    })
    .filter((value): value is OjpPlace => value !== null);
}

function parsePlacesContext(node: XmlObject | undefined): OjpPlace[] {
  return ojpChildren(getXmlChild(node, "Places"), "Place").map(readPlaceRef);
}

function parseDatedTrainNumberRefs(node: XmlObject | undefined): OjpDatedTrainNumberRef[] {
  if (!node) return [];
  const groups = getXmlChildren(node, "DatedTrainNumberRefGroup");
  if (groups.length === 0) {
    const trainNumber =
      ojpChildText(node, "DatedTrainNumberRef") ?? ojpChildText(node, "TrainNumber");
    const operatorRef = ojpChildText(node, "OperatorRef");
    const operatingDayRef = ojpChildText(node, "OperatingDayRef");
    return trainNumber || operatorRef || operatingDayRef
      ? [{ operatorRef, operatingDayRef, trainNumber }]
      : [];
  }
  return groups
    .map((group) => ({
      operatorRef: ojpChildText(group, "OperatorRef"),
      operatingDayRef: ojpChildText(group, "OperatingDayRef"),
      trainNumber: ojpChildText(group, "DatedTrainNumberRef") ?? ojpChildText(group, "TrainNumber"),
    }))
    .filter((group) => group.trainNumber || group.operatorRef || group.operatingDayRef);
}

function parseAttribute(attribute: XmlObject): OjpAttributeDetail {
  return {
    accessFacility: ojpChildText(attribute, "AccessFacility"),
    code: ojpChildText(attribute, "Code"),
    text: ojpText(getXmlChild(attribute, "Text")),
    userText: ojpText(getXmlChild(attribute, "UserText")),
  };
}

function parseAttributeList(node: XmlObject | undefined): OjpAttributeDetail[] {
  return getXmlChildren(node, "Attribute").map(parseAttribute);
}

function attributeTexts(attributes: OjpAttributeDetail[]): string[] {
  return attributes
    .flatMap((attribute) => [attribute.text, attribute.userText])
    .filter((value): value is string => Boolean(value));
}

function parseCall(node: XmlObject | undefined): OjpCall | undefined {
  if (!node) return undefined;
  const call = getXmlChild(node, "CallAtStop") ?? node;
  const arrival = getXmlChild(call, "ServiceArrival");
  const departure = getXmlChild(call, "ServiceDeparture");
  const name =
    ojpText(getXmlChild(call, "StopPointName")) ?? ojpText(getXmlChild(call, "Name")) ?? "Unknown";
  return {
    arrivalEstimated: ojpChildText(arrival, "EstimatedTime"),
    arrivalFormationRefs: parseDatedTrainNumberRefs(arrival),
    arrivalOccupancy: ojpChildText(arrival, "Occupancy"),
    arrivalTimetabled: ojpChildText(arrival, "TimetabledTime"),
    departureEstimated: ojpChildText(departure, "EstimatedTime"),
    departureFormationRefs: parseDatedTrainNumberRefs(departure),
    departureOccupancy: ojpChildText(departure, "Occupancy"),
    departureTimetabled: ojpChildText(departure, "TimetabledTime"),
    estimatedQuay: ojpChildText(call, "EstimatedQuay"),
    geoPosition: ojpGeoPosition(call) ?? undefined,
    name,
    nameSuffix: ojpChildText(call, "NameSuffix"),
    order: parseNumber(ojpChildText(call, "Order")),
    plannedQuay: ojpChildText(call, "PlannedQuay"),
    stopPointRef: ojpChildText(call, "StopPointRef"),
  };
}

function parseCalls(node: XmlObject | undefined, keys: string | string[]): OjpCall[] {
  const names = Array.isArray(keys) ? keys : [keys];
  return names
    .flatMap((key) => getXmlChildren(node, key))
    .map((entry) => parseCall(entry))
    .filter((value): value is OjpCall => Boolean(value));
}

function collectTextsFromSubtree(
  node: unknown,
  wantedKeys: Set<string>,
  results: Set<string>,
): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectTextsFromSubtree(item, wantedKeys, results);
    return;
  }
  if (!isXmlObject(node)) return;

  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (wantedKeys.has(key)) {
      const text = ojpText(child);
      if (text) results.add(text);
    }
    collectTextsFromSubtree(child, wantedKeys, results);
  }
}

function parseGuidanceTexts(node: XmlObject | undefined): string[] {
  const guidance = getXmlChild(node, "PathGuidance");
  if (!guidance) return [];
  const results = new Set<string>();
  collectTextsFromSubtree(
    guidance,
    new Set(["Description", "Instruction", "LegDescription", "StepDescription", "TurnDescription"]),
    results,
  );
  return [...results];
}

function collectProjectionCoordinates(node: unknown, results: [number, number][]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectProjectionCoordinates(item, results);
    return;
  }
  if (!isXmlObject(node)) return;

  const hasDirectCoordinates = "Longitude" in node || "Latitude" in node;
  if (hasDirectCoordinates) {
    const position = ojpGeoPosition(node);
    if (position) {
      const coordinate: [number, number] = [position.longitude, position.latitude];
      const last = results.at(-1);
      if (!last || last[0] !== coordinate[0] || last[1] !== coordinate[1]) {
        results.push(coordinate);
      }
    }
    return;
  }

  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    collectProjectionCoordinates(child, results);
  }
}

function parseProjectionCoordinates(node: XmlObject | undefined): [number, number][] {
  const projection =
    getXmlChild(node, "LegProjection") ??
    getXmlChild(node, "LinkProjection") ??
    getXmlChild(node, "PathProjection");
  if (!projection) return [];
  const results: [number, number][] = [];
  collectProjectionCoordinates(projection, results);
  return results;
}

function parseSituationIds(node: XmlObject | undefined): string[] {
  return getXmlChildren(getXmlChild(node, "SituationFullRefs"), "SituationFullRef")
    .map((entry) => ojpChildText(entry, "SituationNumber"))
    .filter((value): value is string => Boolean(value));
}

function parseFeatureRefs(node: XmlObject | undefined, key: string): string[] {
  return ojpTexts(node, key);
}

function parseViaTexts(node: XmlObject | undefined): { refs: string[]; texts: string[] } {
  const refs = new Set<string>();
  const texts = new Set<string>();
  for (const via of getXmlChildren(node, "Via")) {
    const stopPointRef = ojpChildText(via, "StopPointRef");
    const text = ojpText(getXmlChild(via, "Text")) ?? ojpText(getXmlChild(via, "ViaText"));
    if (stopPointRef) refs.add(stopPointRef);
    if (text) texts.add(text);
  }
  return { refs: [...refs], texts: [...texts] };
}

function parseService(node: XmlObject | undefined): OjpService | undefined {
  if (!node) return undefined;
  const { modeName, modeShortName, ptMode, submode } = readPtMode(node);
  const attributes = parseAttributeList(node);
  const via = parseViaTexts(node);
  const operatorRefs = new Set<string>(
    ojpTexts(getXmlChild(node, "OperatorRefs"), "OperatorRef").filter((value): value is string =>
      Boolean(value),
    ),
  );
  const operatorRef = ojpChildText(node, "OperatorRef");
  if (operatorRef) operatorRefs.add(operatorRef);

  return {
    attributeDetails: attributes,
    attributes: attributeTexts(attributes),
    canceled: parseBoolean(ojpChildText(node, "Cancelled")),
    datedTrainNumberRefs: parseDatedTrainNumberRefs(node),
    destinationStopPointRef: ojpChildText(node, "DestinationStopPointRef"),
    destinationText: ojpChildText(node, "DestinationText"),
    deviation: parseBoolean(ojpChildText(node, "Deviation")),
    directionRef: ojpChildText(node, "DirectionRef"),
    journeyRef: ojpChildText(node, "JourneyRef"),
    lineRef: ojpChildText(node, "LineRef"),
    modeName,
    modeShortName,
    occupancy: ojpChildText(node, "Occupancy"),
    operatorRef,
    operatorRefs: [...operatorRefs],
    operatingDayRef: ojpChildText(node, "OperatingDayRef"),
    originStopPointRef: ojpChildText(node, "OriginStopPointRef"),
    originText: ojpChildText(node, "OriginText"),
    productCategoryName: ojpText(getXmlChild(getXmlChild(node, "ProductCategory"), "Name")),
    productCategoryRef: ojpChildText(getXmlChild(node, "ProductCategory"), "ProductCategoryRef"),
    productCategoryShortName: ojpText(
      getXmlChild(getXmlChild(node, "ProductCategory"), "ShortName"),
    ),
    ptMode,
    publishedLineName: ojpText(getXmlChild(node, "PublishedLineName")),
    publishedServiceName: ojpText(getXmlChild(node, "PublishedServiceName")),
    routeDescription: ojpText(getXmlChild(node, "RouteDescription")),
    serviceFeatureRefs: parseFeatureRefs(getXmlChild(node, "ServiceInfo"), "ServiceFeatureRef"),
    situationIds: parseSituationIds(node),
    submode,
    trainNumber: ojpChildText(node, "TrainNumber"),
    undefinedDelay: parseBoolean(ojpChildText(node, "UndefinedDelay")),
    unplanned: parseBoolean(ojpChildText(node, "Unplanned")),
    vehicleFeatureRefs: parseFeatureRefs(getXmlChild(node, "ServiceInfo"), "VehicleFeatureRef"),
    vehicleRef: ojpChildText(node, "VehicleRef"),
    viaStopPointRefs: via.refs,
    viaTexts: via.texts,
  };
}

function buildPlaceLookup(places: OjpPlace[]): Map<string, OjpPlace> {
  const map = new Map<string, OjpPlace>();
  for (const place of places) {
    map.set(place.ref, place);
    if (place.stopPlaceRef) map.set(place.stopPlaceRef, place);
    if (place.stopPointRef) map.set(place.stopPointRef, place);
  }
  return map;
}

function endpointFromPlace(
  placeRef: string | undefined,
  name: string,
  geo: OjpGeoPosition | null,
  places: Map<string, OjpPlace>,
): OjpLegEndpoint {
  const lookup = placeRef ? places.get(placeRef) : undefined;
  if (lookup) {
    return {
      lat: lookup.lat,
      lng: lookup.lng,
      name: lookup.name || name,
      stopPointRef: lookup.stopPointRef ?? lookup.stopPlaceRef,
    };
  }
  return {
    lat: geo?.latitude ?? 0,
    lng: geo?.longitude ?? 0,
    name,
    stopPointRef: placeRef,
  };
}

function parseLegEndpoint(
  node: XmlObject | undefined,
  places: Map<string, OjpPlace>,
): OjpLegEndpoint | undefined {
  if (!node) return undefined;
  const stopPointRef = ojpChildText(node, "StopPointRef");
  const name =
    ojpText(getXmlChild(node, "StopPointName")) ?? ojpText(getXmlChild(node, "Name")) ?? "Unknown";
  return endpointFromPlace(stopPointRef, name, ojpGeoPosition(node), places);
}

function parseTimedLeg(node: XmlObject, places: Map<string, OjpPlace>): OjpTripLeg {
  const boardCall = parseCall(getXmlChild(node, "LegBoard"));
  const alightCall = parseCall(getXmlChild(node, "LegAlight"));
  const attributeDetails = parseAttributeList(node);
  return {
    alightCall,
    attributes: attributeTexts(attributeDetails),
    attributeDetails,
    boardCall,
    durationSeconds: parseIsoDurationSeconds(ojpChildText(node, "Duration")),
    end: endpointFromPlace(alightCall?.stopPointRef, alightCall?.name ?? "Unknown", null, places),
    feasibility: [],
    guidanceTexts: parseGuidanceTexts(node),
    intermediateCalls: parseCalls(node, ["LegIntermediate", "LegIntermediates"]),
    kind: "timed",
    projectionCoordinates: parseProjectionCoordinates(node),
    service: parseService(getXmlChild(node, "Service")),
    situationIds: parseSituationIds(node),
    start: endpointFromPlace(boardCall?.stopPointRef, boardCall?.name ?? "Unknown", null, places),
  };
}

function parseContinuousLeg(
  node: XmlObject,
  places: Map<string, OjpPlace>,
  kind: "continuous" | "transfer",
): OjpTripLeg {
  const start = parseLegEndpoint(getXmlChild(node, "LegStart"), places) ?? {
    lat: 0,
    lng: 0,
    name: "Origin",
  };
  const end = parseLegEndpoint(getXmlChild(node, "LegEnd"), places) ?? {
    lat: 0,
    lng: 0,
    name: "Destination",
  };
  const attributeDetails = parseAttributeList(node);
  return {
    attributes: attributeTexts(attributeDetails),
    attributeDetails,
    bufferTimeSeconds: parseIsoDurationSeconds(ojpChildText(node, "BufferTime")),
    durationSeconds: parseIsoDurationSeconds(ojpChildText(node, "Duration")),
    end,
    feasibility: ojpTexts(getXmlChild(node, "Feasibility"), "Text"),
    guidanceTexts: parseGuidanceTexts(node),
    intermediateCalls: [],
    kind,
    lengthMeters: parseNumber(ojpChildText(node, "Length")),
    personalMode: ojpChildText(getXmlChild(node, "Service"), "PersonalMode"),
    projectionCoordinates: parseProjectionCoordinates(node),
    service: parseService(getXmlChild(node, "Service")),
    situationIds: parseSituationIds(node),
    start,
    timeWindowEnd: ojpChildText(node, "TimeWindowEnd"),
    timeWindowStart: ojpChildText(node, "TimeWindowStart"),
    transferMode: ojpChildText(node, "TransferMode"),
    transferType: ojpChildText(node, "TransferType"),
    walkDurationSeconds: parseIsoDurationSeconds(ojpChildText(node, "WalkDuration")),
  };
}

function parseTripLeg(node: XmlObject, places: Map<string, OjpPlace>): OjpTripLeg | null {
  const legId = ojpChildText(node, "Id") ?? ojpChildText(node, "LegId");
  const timed = getXmlChild(node, "TimedLeg");
  if (timed) {
    return {
      ...parseTimedLeg(timed, places),
      id: legId,
    };
  }
  const transfer = getXmlChild(node, "TransferLeg");
  if (transfer) {
    return {
      ...parseContinuousLeg(transfer, places, "transfer"),
      id: legId,
    };
  }
  const continuous = getXmlChild(node, "ContinuousLeg");
  if (continuous) {
    return {
      ...parseContinuousLeg(continuous, places, "continuous"),
      id: legId,
    };
  }
  return null;
}

function parseTrackSections(node: XmlObject | undefined): OjpJourneyTrackSection[] {
  return getXmlChildren(getXmlChild(node, "JourneyTrack"), "TrackSection").map((section) => ({
    coordinates: parseProjectionCoordinates(section),
    durationSeconds: parseIsoDurationSeconds(ojpChildText(section, "Duration")),
    endStopPointRef: ojpChildText(getXmlChild(section, "TrackSectionEnd"), "StopPointRef"),
    startStopPointRef: ojpChildText(getXmlChild(section, "TrackSectionStart"), "StopPointRef"),
  }));
}

function getOjpTopLevelDelivery(document: XmlObject, key: string): XmlObject | undefined {
  return getOjpDelivery(document, key) ?? getXmlChild(document, key);
}

function parseOjpFareProduct(node: XmlObject): OjpFareProduct {
  return {
    amount: parseNumber(
      ojpChildText(node, "Amount") ??
        ojpChildText(node, "Price") ??
        ojpChildText(getXmlChild(node, "Price"), "Amount") ??
        ojpChildText(getXmlChild(node, "Price"), "Value"),
    ),
    authorityName: ojpChildText(node, "FareAuthorityText"),
    authorityRef: ojpChildText(node, "FareAuthorityRef"),
    currency:
      ojpChildText(node, "Currency") ??
      ojpChildText(getXmlChild(node, "Price"), "Currency") ??
      ojpChildText(getXmlChild(node, "Price"), "CurrencyCode"),
    id: ojpChildText(node, "FareProductRef") ?? ojpChildText(node, "FareProductId"),
    infoUrls: ojpTexts(getXmlChild(node, "InfoLinks"), "InfoLink"),
    name: ojpChildText(node, "FareProductName") ?? ojpChildText(node, "Name") ?? "Fare product",
    netAmount: parseNumber(
      ojpChildText(node, "NetAmount") ??
        ojpChildText(node, "NetPrice") ??
        ojpChildText(getXmlChild(node, "NetPrice"), "Amount") ??
        ojpChildText(getXmlChild(node, "NetPrice"), "Value"),
    ),
    saleUrls: ojpTexts(getXmlChild(node, "SalesLinks"), "SalesLink"),
    travelClass: ojpChildText(node, "TravelClass"),
    vatRate: parseNumber(ojpChildText(node, "VatRate")),
  };
}

function parseOjpFareTripResult(node: XmlObject): OjpFareTripResult {
  const products = [
    ...getXmlChildren(node, "FareProduct"),
    ...getXmlChildren(getXmlChild(node, "FareProducts"), "FareProduct"),
  ].map(parseOjpFareProduct);
  return {
    fromLegId:
      ojpChildText(node, "FromLegIdRef") ??
      ojpChildText(node, "FromTripLegIdRef") ??
      ojpChildText(getXmlChild(node, "FromTripLeg"), "TripLegIdRef"),
    products,
    toLegId:
      ojpChildText(node, "ToLegIdRef") ??
      ojpChildText(node, "ToTripLegIdRef") ??
      ojpChildText(getXmlChild(node, "ToTripLeg"), "TripLegIdRef"),
  };
}

export function extractOjpTripRequestTrips(xml: string): XmlObject[] {
  const document = parseOjpXmlDocument(xml);
  const delivery =
    getOjpTopLevelDelivery(document, "OJPTripDelivery") ??
    getOjpTopLevelDelivery(document, "TripDelivery");
  return getXmlChildren(delivery, "TripResult")
    .map((result) => getXmlChild(result, "Trip") ?? result)
    .filter(isXmlObject);
}

export function parseOjpLocationInformationResponse(xml: string): OjpLocationInformationResponse {
  const document = parseOjpXmlDocument(xml);
  const delivery = getOjpTopLevelDelivery(document, "OJPLocationInformationDelivery");
  return {
    places: parsePlaceResults(getXmlChildren(delivery, "PlaceResult")),
  };
}

export function parseOjpStopEventResponse(xml: string): OjpStopEventResponse {
  const document = parseOjpXmlDocument(xml);
  const delivery = getOjpTopLevelDelivery(document, "OJPStopEventDelivery");
  return {
    places: parsePlacesContext(getXmlChild(delivery, "StopEventResponseContext")),
    stopEvents: getXmlChildren(delivery, "StopEventResult").map((result) => {
      const stopEvent = getXmlChild(result, "StopEvent");
      return {
        onwardCalls: parseCalls(stopEvent, "OnwardCall"),
        previousCalls: parseCalls(stopEvent, "PreviousCall"),
        service: parseService(getXmlChild(stopEvent, "Service")),
        thisCall: parseCall(getXmlChild(stopEvent, "ThisCall")),
      } satisfies OjpStopEvent;
    }),
  };
}

export function parseOjpTripResponse(xml: string): OjpTripResponse {
  const document = parseOjpXmlDocument(xml);
  const delivery =
    getOjpTopLevelDelivery(document, "OJPTripDelivery") ??
    getOjpTopLevelDelivery(document, "TripDelivery");
  const places = parsePlacesContext(getXmlChild(delivery, "TripResponseContext"));
  const placeLookup = buildPlaceLookup(places);

  return {
    places,
    trips: getXmlChildren(delivery, "TripResult").map((result) => {
      const trip = getXmlChild(result, "Trip") ?? result;
      return {
        distanceMeters: parseNumber(ojpChildText(trip, "Distance")),
        durationSeconds: parseIsoDurationSeconds(ojpChildText(trip, "Duration")),
        endTime: ojpChildText(trip, "EndTime"),
        id:
          ojpChildText(trip, "Id") ??
          ojpChildText(trip, "TripId") ??
          ojpChildText(result, "Id") ??
          ojpChildText(result, "TripId"),
        legs: [...getXmlChildren(trip, "Leg"), ...getXmlChildren(trip, "TripLeg")]
          .map((leg) => parseTripLeg(leg, placeLookup))
          .filter((value): value is OjpTripLeg => value !== null),
        startTime: ojpChildText(trip, "StartTime"),
        transfers: parseNumber(ojpChildText(trip, "Transfers")),
      } satisfies OjpTripResult;
    }),
  };
}

export function parseOjpTripInfoResponse(xml: string): OjpTripInfoResponse {
  const document = parseOjpXmlDocument(xml);
  const delivery = getOjpTopLevelDelivery(document, "OJPTripInfoDelivery");
  const tripInfo = getXmlChild(delivery, "TripInfoResult");
  return {
    places: parsePlacesContext(getXmlChild(delivery, "TripInfoResponseContext")),
    tripInfo: tripInfo
      ? {
          onwardCalls: parseCalls(tripInfo, "OnwardCall"),
          position: ojpGeoPosition(getXmlChild(tripInfo, "Position")) ?? undefined,
          previousCalls: parseCalls(tripInfo, "PreviousCall"),
          service: parseService(getXmlChild(tripInfo, "Service")),
          trackSections: parseTrackSections(tripInfo),
        }
      : undefined,
  };
}

export function parseOjpFareResponse(xml: string): OjpFareResponse {
  const document = parseOjpXmlDocument(xml);
  const delivery = getOjpTopLevelDelivery(document, "OJPFareDelivery");
  return {
    fares: getXmlChildren(delivery, "FareResult").map((fareResult) => ({
      id: ojpChildText(fareResult, "Id") ?? ojpChildText(fareResult, "ResultId"),
      trips: [
        ...getXmlChildren(fareResult, "TripFareResult"),
        ...getXmlChildren(getXmlChild(fareResult, "TripFareResults"), "TripFareResult"),
      ].map(parseOjpFareTripResult),
    })),
  };
}
