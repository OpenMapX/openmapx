import {
  buildXmlDocument,
  getXmlChild,
  getXmlChildren,
  parseXmlDocument,
  type XmlObject,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

const OJP_NAMESPACE = "http://www.vdv.de/ojp";
const SIRI_NAMESPACE = "http://www.siri.org.uk/siri";
const XML_SCHEMA_INSTANCE_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";

export interface OjpRequestOptions {
  language?: string;
  messageIdentifier?: string;
  requestTimestamp?: string;
  requestorRef?: string;
}

export interface OjpGeoPosition {
  latitude: number;
  longitude: number;
}

export interface OjpRectangle {
  upperLeft: OjpGeoPosition;
  lowerRight: OjpGeoPosition;
}

export interface OjpPlaceRef {
  stopPlaceRef?: string;
  stopPointRef?: string;
  geoPosition?: OjpGeoPosition;
  name?: string;
  topographicPlaceRef?: string;
}

export interface OjpLocationInformationRequestParams extends OjpRequestOptions {
  query?: string;
  placeRef?: OjpPlaceRef;
  geoRestrictionCircleMeters?: number;
  geoRestrictionRectangle?: OjpRectangle;
  limit?: number;
  includePtModes?: boolean;
  types?: string[];
}

export interface OjpStopEventRequestParams extends OjpRequestOptions {
  stopRef: string;
  dateTime: string;
  stopEventType: "departure" | "arrival";
  includeAllRestrictedLines?: boolean;
  includeOnwardCalls?: boolean;
  includePreviousCalls?: boolean;
  numberOfResults?: number;
  useRealtimeData?: "none" | "full" | "explanatory";
}

export interface OjpTripRequestParams extends OjpRequestOptions {
  arrivalTime?: string;
  departureTime?: string;
  destination: OjpPlaceRef;
  includeAccessibility?: boolean;
  includeFormation?: "none" | "simple" | "full";
  includeIntermediateStops?: boolean;
  includeLegProjection?: boolean;
  includeTrackSections?: boolean;
  includeTurnDescription?: boolean;
  includeSituationsContext?: boolean;
  individualTransportModeAtDestination?: string;
  individualTransportModeAtOrigin?: string;
  itModesToCover?: string[];
  numberOfResults?: number;
  origin: OjpPlaceRef;
  useRealtimeData?: "none" | "full" | "explanatory";
}

export interface OjpTripInfoRequestParams extends OjpRequestOptions {
  includeCalls?: boolean;
  includeFormation?: "none" | "simple" | "full";
  includeLinkProjection?: boolean;
  includePosition?: boolean;
  includeService?: boolean;
  includeSituationsContext?: boolean;
  includeTrackSections?: boolean;
  journeyRef: string;
  operatingDayRef: string;
  useRealtimeData?: "none" | "full" | "explanatory";
}

export interface OjpFareEntitlementProduct {
  entitlementProductName?: string;
  entitlementProductRef: string;
  fareAuthorityRef?: string;
}

export interface OjpFareTraveller {
  age?: number;
  entitlementProducts?: OjpFareEntitlementProduct[];
  passengerCategory?: string;
}

export interface OjpFareRequestParams extends OjpRequestOptions {
  fareAuthorityFilter?: string;
  passengerCategory?: string;
  travelClass?: string;
  travellers?: OjpFareTraveller[];
  trips: XmlObject[];
}

function isoNow(): string {
  return new Date().toISOString();
}

function buildTextNode(value: string): XmlObject {
  return { Text: value };
}

function buildGeoPositionNode(position: OjpGeoPosition): XmlObject {
  return {
    GeoPosition: {
      "siri:Longitude": String(position.longitude),
      "siri:Latitude": String(position.latitude),
    },
  };
}

function buildPlaceRefNode(placeRef: OjpPlaceRef): XmlObject {
  const node: XmlObject = {};
  if (placeRef.stopPointRef) {
    node["siri:StopPointRef"] = placeRef.stopPointRef;
  } else if (placeRef.stopPlaceRef) {
    node.StopPlaceRef = placeRef.stopPlaceRef;
  }
  if (placeRef.geoPosition) {
    Object.assign(node, buildGeoPositionNode(placeRef.geoPosition));
  }
  if (placeRef.name) {
    node.Name = buildTextNode(placeRef.name);
  }
  if (placeRef.topographicPlaceRef) {
    node.TopographicPlaceRef = placeRef.topographicPlaceRef;
  }
  return node;
}

function buildEnvelope(
  requestTag: string,
  requestBody: XmlObject,
  options: OjpRequestOptions = {},
): string {
  const requestTimestamp = options.requestTimestamp ?? isoNow();
  const messageIdentifier = options.messageIdentifier;
  return buildXmlDocument(
    {
      OJP: {
        "@_xmlns": OJP_NAMESPACE,
        "@_xmlns:siri": SIRI_NAMESPACE,
        "@_xmlns:xsi": XML_SCHEMA_INSTANCE_NAMESPACE,
        "@_version": "2.0",
        "@_xsi:schemaLocation": OJP_NAMESPACE,
        OJPRequest: {
          "siri:ServiceRequest": {
            ...(options.language
              ? { "siri:ServiceRequestContext": { "siri:Language": options.language } }
              : {}),
            "siri:RequestTimestamp": requestTimestamp,
            "siri:RequestorRef": options.requestorRef ?? "OpenMapX",
            [requestTag]: {
              "siri:RequestTimestamp": requestTimestamp,
              ...(messageIdentifier ? { "siri:MessageIdentifier": messageIdentifier } : {}),
              ...requestBody,
            },
          },
        },
      },
    },
    { xmlDeclaration: true },
  );
}

export function buildOjpLocationInformationRequestXml(
  params: OjpLocationInformationRequestParams,
): string {
  const restrictions: XmlObject = {
    ...(params.types?.length ? { Type: params.types } : { Type: "stop" }),
    ...(params.limit ? { NumberOfResults: String(params.limit) } : {}),
    ...(params.includePtModes ? { IncludePtModes: true } : {}),
  };
  const body: XmlObject = {
    ...(params.query ||
    params.placeRef?.geoPosition ||
    params.geoRestrictionCircleMeters ||
    params.geoRestrictionRectangle
      ? {
          InitialInput: {
            ...(params.query ? { Name: params.query } : {}),
            ...(params.placeRef?.geoPosition
              ? buildGeoPositionNode(params.placeRef.geoPosition)
              : {}),
            ...(params.geoRestrictionCircleMeters && params.placeRef?.geoPosition
              ? {
                  GeoRestriction: {
                    Circle: {
                      Center: {
                        "siri:Longitude": String(params.placeRef.geoPosition.longitude),
                        "siri:Latitude": String(params.placeRef.geoPosition.latitude),
                      },
                      Radius: String(params.geoRestrictionCircleMeters),
                    },
                  },
                }
              : {}),
            ...(params.geoRestrictionRectangle
              ? {
                  GeoRestriction: {
                    Rectangle: {
                      UpperLeft: {
                        "siri:Longitude": String(
                          params.geoRestrictionRectangle.upperLeft.longitude,
                        ),
                        "siri:Latitude": String(params.geoRestrictionRectangle.upperLeft.latitude),
                      },
                      LowerRight: {
                        "siri:Longitude": String(
                          params.geoRestrictionRectangle.lowerRight.longitude,
                        ),
                        "siri:Latitude": String(params.geoRestrictionRectangle.lowerRight.latitude),
                      },
                    },
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(params.placeRef ? { PlaceRef: buildPlaceRefNode(params.placeRef) } : {}),
    Restrictions: restrictions,
  };

  return buildEnvelope("OJPLocationInformationRequest", body, params);
}

export function buildOjpStopEventRequestXml(params: OjpStopEventRequestParams): string {
  return buildEnvelope(
    "OJPStopEventRequest",
    {
      Location: {
        PlaceRef: {
          "siri:StopPointRef": params.stopRef,
        },
        DepArrTime: params.dateTime,
      },
      Params: {
        ...(params.includeAllRestrictedLines ? { IncludeAllRestrictedLines: true } : {}),
        ...(params.numberOfResults ? { NumberOfResults: String(params.numberOfResults) } : {}),
        StopEventType: params.stopEventType,
        ...(params.includePreviousCalls != null
          ? { IncludePreviousCalls: params.includePreviousCalls }
          : {}),
        ...(params.includeOnwardCalls != null
          ? { IncludeOnwardCalls: params.includeOnwardCalls }
          : {}),
        ...(params.useRealtimeData ? { UseRealtimeData: params.useRealtimeData } : {}),
      },
    },
    params,
  );
}

export function buildOjpTripRequestXml(params: OjpTripRequestParams): string {
  const depArrTime = params.arrivalTime ?? params.departureTime ?? isoNow();
  const extension: XmlObject = {};
  if (params.itModesToCover?.some((mode) => mode.endsWith("_rental") || mode === "car_sharing")) {
    extension.ItModesToCover = params.itModesToCover.filter(
      (mode) => mode.endsWith("_rental") || mode === "car_sharing",
    );
  }
  if (params.individualTransportModeAtOrigin) {
    extension.Origin = {
      Mode: params.individualTransportModeAtOrigin,
    };
  }
  if (params.individualTransportModeAtDestination) {
    extension.Destination = {
      Mode: params.individualTransportModeAtDestination,
    };
  }

  return buildEnvelope(
    "OJPTripRequest",
    {
      Origin: {
        PlaceRef: buildPlaceRefNode(params.origin),
        DepArrTime: depArrTime,
      },
      Destination: {
        PlaceRef: buildPlaceRefNode(params.destination),
      },
      Params: {
        ...(params.numberOfResults ? { NumberOfResults: String(params.numberOfResults) } : {}),
        ...(params.includeIntermediateStops != null
          ? { IncludeIntermediateStops: params.includeIntermediateStops }
          : {}),
        ...(params.includeTrackSections != null
          ? { IncludeTrackSections: params.includeTrackSections }
          : {}),
        ...(params.includeLegProjection != null
          ? { IncludeLegProjection: params.includeLegProjection }
          : {}),
        ...(params.includeTurnDescription != null
          ? { IncludeTurnDescription: params.includeTurnDescription }
          : {}),
        ...(params.includeAccessibility != null
          ? { IncludeAccessibility: params.includeAccessibility }
          : {}),
        ...(params.includeFormation ? { IncludeFormation: params.includeFormation } : {}),
        ...(params.includeSituationsContext != null
          ? { IncludeSituationsContext: params.includeSituationsContext }
          : {}),
        ...(params.itModesToCover?.length
          ? {
              ItModesToCover: params.itModesToCover.filter(
                (mode) => !mode.endsWith("_rental") && mode !== "car_sharing",
              ),
            }
          : {}),
        ...(Object.keys(extension).length ? { Extension: extension } : {}),
        ...(params.useRealtimeData ? { UseRealtimeData: params.useRealtimeData } : {}),
        ...(params.arrivalTime ? { ArriveBy: true } : {}),
      },
    },
    params,
  );
}

export function buildOjpTripInfoRequestXml(params: OjpTripInfoRequestParams): string {
  return buildEnvelope(
    "OJPTripInfoRequest",
    {
      JourneyRef: params.journeyRef,
      OperatingDayRef: params.operatingDayRef,
      Params: {
        ...(params.useRealtimeData ? { UseRealtimeData: params.useRealtimeData } : {}),
        ...(params.includeCalls != null ? { IncludeCalls: params.includeCalls } : {}),
        ...(params.includePosition != null ? { IncludePosition: params.includePosition } : {}),
        ...(params.includeService != null ? { IncludeService: params.includeService } : {}),
        ...(params.includeTrackSections != null
          ? { IncludeTrackSections: params.includeTrackSections }
          : {}),
        ...(params.includeLinkProjection != null
          ? { IncludeLinkProjection: params.includeLinkProjection }
          : {}),
        ...(params.includeFormation ? { IncludeFormation: params.includeFormation } : {}),
        ...(params.includeSituationsContext != null
          ? { IncludeSituationsContext: params.includeSituationsContext }
          : {}),
      },
    },
    params,
  );
}

function buildOjpFareTravellerNode(traveller: OjpFareTraveller): XmlObject {
  return {
    ...(traveller.age != null ? { Age: String(traveller.age) } : {}),
    ...(traveller.passengerCategory ? { PassengerCategory: traveller.passengerCategory } : {}),
    ...(traveller.entitlementProducts?.length
      ? {
          EntitlementProducts: {
            EntitlementProduct: traveller.entitlementProducts.map((product) => ({
              ...(product.fareAuthorityRef ? { FareAuthorityRef: product.fareAuthorityRef } : {}),
              ...(product.entitlementProductName
                ? { EntitlementProductName: product.entitlementProductName }
                : {}),
              EntitlementProductRef: product.entitlementProductRef,
            })),
          },
        }
      : {}),
  };
}

export function buildOjpFareRequestXml(params: OjpFareRequestParams): string {
  const fareParams: XmlObject = {
    ...(params.fareAuthorityFilter ? { FareAuthorityFilter: params.fareAuthorityFilter } : {}),
    ...(params.passengerCategory ? { PassengerCategory: params.passengerCategory } : {}),
    ...(params.travelClass ? { TravelClass: params.travelClass } : {}),
    ...(params.travellers?.length
      ? {
          Traveller: params.travellers.map(buildOjpFareTravellerNode),
        }
      : {}),
  };

  return buildEnvelope(
    "OJPFareRequest",
    {
      TripFareRequest: {
        Trip: params.trips,
      },
      ...(Object.keys(fareParams).length ? { Params: fareParams } : {}),
    },
    params,
  );
}

export function parseOjpXmlDocument(xml: string): XmlObject {
  return parseXmlDocument(xml);
}

export function getOjpServiceDelivery(document: XmlObject): XmlObject | undefined {
  return getXmlChild(getXmlChild(getXmlChild(document, "OJP"), "OJPResponse"), "ServiceDelivery");
}

export function getOjpDelivery(document: XmlObject, key: string): XmlObject | undefined {
  return getXmlChild(getOjpServiceDelivery(document), key);
}

export function ojpText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!(typeof value === "object") || Array.isArray(value)) {
    return undefined;
  }
  const direct = xmlText(value);
  if (direct) return direct;
  const textNode = (value as XmlObject).Text;
  if (typeof textNode === "string") return textNode;
  for (const entry of xmlNodeToArray(textNode)) {
    const text = xmlText(entry);
    if (text) return text;
  }
  return undefined;
}

export function ojpChildText(node: unknown, key: string): string | undefined {
  if (!(typeof node === "object") || node == null || Array.isArray(node)) return undefined;
  return ojpText((node as XmlObject)[key]);
}

export function ojpTexts(node: unknown, key: string): string[] {
  if (!(typeof node === "object") || node == null || Array.isArray(node)) return [];
  return xmlNodeToArray((node as XmlObject)[key])
    .map(ojpText)
    .filter((value): value is string => Boolean(value));
}

export function ojpGeoPosition(node: unknown): OjpGeoPosition | null {
  const direct =
    typeof node === "object" &&
    node !== null &&
    !Array.isArray(node) &&
    ("Longitude" in node || "Latitude" in node)
      ? (node as XmlObject)
      : undefined;
  const geo = getXmlChild(node, "GeoPosition") ?? getXmlChild(node, "Position") ?? direct;
  if (!geo) return null;
  const longitude = Number(ojpChildText(geo, "Longitude"));
  const latitude = Number(ojpChildText(geo, "Latitude"));
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return { latitude, longitude };
}

export function ojpChildren(node: unknown, key: string): XmlObject[] {
  return getXmlChildren(node, key);
}
