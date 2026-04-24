import {
  buildXmlDocument,
  getXmlChild,
  getXmlChildren,
  isXmlObject,
  parseXmlDocument,
  type XmlObject,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

export type SiriElement = XmlObject;
export type SiriEnvelope = XmlObject & { Siri: SiriElement };

export interface SiriServiceRequestOptions {
  encoding?: string;
  namespaceUri?: string;
  requestTimestamp?: string;
  requestorRef: string;
  requests: Record<string, SiriElement | SiriElement[]>;
  schemaLocation?: string;
  serviceRequestFields?: SiriElement;
  version?: string;
}

export interface SiriVehicleMonitoringRequestOptions {
  additionalFields?: SiriElement;
  detailLevel?: string;
  lineRef?: string;
  maximumStopVisits?: number | string;
  minimumStopVisitsPerLine?: number | string;
  requestTimestamp?: string;
  requestorRef: string;
  serviceRequestFields?: SiriElement;
  vehicleMonitoringRef?: string;
  version?: string;
}

export interface SiriStopMonitoringRequestOptions {
  additionalFields?: SiriElement;
  detailLevel?: string;
  directionRef?: string;
  lineRef?: string;
  maximumStopVisits?: number | string;
  minimumStopVisitsPerLine?: number | string;
  monitoringRef?: string;
  previewInterval?: string;
  requestTimestamp?: string;
  requestorRef: string;
  serviceRequestFields?: SiriElement;
  stopVisitTypes?: string;
  version?: string;
}

export const SIRI_NAMESPACE_URI = "http://www.siri.org.uk/siri";
export const SIRI_SCHEMA_LOCATION = `${SIRI_NAMESPACE_URI} siri.xsd`;

function parseSiriInput(input: string | SiriEnvelope): SiriEnvelope {
  if (typeof input !== "string") return input;
  return parseSiriDocument(input);
}

function normalizeSiriRequestPayload(
  value: SiriElement,
  requestTimestamp: string,
  version: string,
): SiriElement {
  return {
    ...(value.RequestTimestamp == null ? { RequestTimestamp: requestTimestamp } : {}),
    "@_version": typeof value["@_version"] === "string" ? value["@_version"] : version,
    ...value,
  };
}

function listSiriDeliveries(input: string | SiriEnvelope, key: string): SiriElement[] {
  const serviceDelivery = getSiriServiceDelivery(input);
  if (!serviceDelivery) return [];
  return getXmlChildren(serviceDelivery, key);
}

export function parseSiriDocument(content: string): SiriEnvelope {
  const parsed = parseXmlDocument(content);
  if (!isXmlObject(parsed.Siri)) throw new Error("Expected SIRI root element.");
  return parsed as SiriEnvelope;
}

export function getSiriServiceRequest(input: string | SiriEnvelope): SiriElement | undefined {
  return getXmlChild(parseSiriInput(input).Siri, "ServiceRequest");
}

export function getSiriServiceDelivery(input: string | SiriEnvelope): SiriElement | undefined {
  return getXmlChild(parseSiriInput(input).Siri, "ServiceDelivery");
}

export function getSiriServiceTimestamp(input: string | SiriEnvelope): string | undefined {
  return xmlText(getSiriServiceDelivery(input)?.ResponseTimestamp);
}

export function listSiriVehicleMonitoringDeliveries(input: string | SiriEnvelope): SiriElement[] {
  return listSiriDeliveries(input, "VehicleMonitoringDelivery");
}

export function listSiriVehicleActivities(input: string | SiriEnvelope): SiriElement[] {
  return listSiriVehicleMonitoringDeliveries(input).flatMap((delivery) =>
    getXmlChildren(delivery, "VehicleActivity"),
  );
}

export function listSiriStopMonitoringDeliveries(input: string | SiriEnvelope): SiriElement[] {
  return listSiriDeliveries(input, "StopMonitoringDelivery");
}

export function listSiriMonitoredStopVisits(input: string | SiriEnvelope): SiriElement[] {
  return listSiriStopMonitoringDeliveries(input).flatMap((delivery) =>
    getXmlChildren(delivery, "MonitoredStopVisit"),
  );
}

export function listSiriSituationExchangeDeliveries(input: string | SiriEnvelope): SiriElement[] {
  return listSiriDeliveries(input, "SituationExchangeDelivery");
}

export function listSiriSituationElements(input: string | SiriEnvelope): SiriElement[] {
  const elements: SiriElement[] = [];

  for (const delivery of listSiriSituationExchangeDeliveries(input)) {
    const situations = getXmlChild(delivery, "Situations");
    if (!situations) continue;

    for (const [key, value] of Object.entries(situations)) {
      if (!key.endsWith("SituationElement")) continue;
      elements.push(...xmlNodeToArray(value).filter(isXmlObject));
    }
  }

  return elements;
}

export function buildSiriServiceRequest(options: SiriServiceRequestOptions): string {
  const namespaceUri = options.namespaceUri ?? SIRI_NAMESPACE_URI;
  const requestTimestamp = options.requestTimestamp ?? new Date().toISOString();
  const version = options.version ?? "2.0";

  const requests = Object.fromEntries(
    Object.entries(options.requests).map(([key, value]) => {
      if (Array.isArray(value)) {
        return [
          key,
          value.map((entry) => normalizeSiriRequestPayload(entry, requestTimestamp, version)),
        ];
      }

      return [key, normalizeSiriRequestPayload(value, requestTimestamp, version)];
    }),
  );

  return buildXmlDocument(
    {
      Siri: {
        "@_xmlns": namespaceUri,
        "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        "@_version": version,
        "@_xsi:schemaLocation": options.schemaLocation ?? SIRI_SCHEMA_LOCATION,
        ServiceRequest: {
          RequestTimestamp: requestTimestamp,
          RequestorRef: options.requestorRef,
          ...(options.serviceRequestFields ?? {}),
          ...requests,
        },
      },
    },
    {
      encoding: options.encoding,
      format: true,
      xmlDeclaration: true,
    },
  );
}

export function buildSiriVehicleMonitoringRequest(
  options: SiriVehicleMonitoringRequestOptions,
): string {
  const request: SiriElement = {
    ...(options.vehicleMonitoringRef ? { VehicleMonitoringRef: options.vehicleMonitoringRef } : {}),
    ...(options.lineRef ? { LineRef: options.lineRef } : {}),
    ...(options.detailLevel ? { VehicleMonitoringDetailLevel: options.detailLevel } : {}),
    ...(options.maximumStopVisits != null
      ? { MaximumStopVisits: String(options.maximumStopVisits) }
      : {}),
    ...(options.minimumStopVisitsPerLine != null
      ? { MinimumStopVisitsPerLine: String(options.minimumStopVisitsPerLine) }
      : {}),
    ...(options.additionalFields ?? {}),
  };

  return buildSiriServiceRequest({
    requestTimestamp: options.requestTimestamp,
    requestorRef: options.requestorRef,
    requests: {
      VehicleMonitoringRequest: request,
    },
    serviceRequestFields: options.serviceRequestFields,
    version: options.version,
  });
}

export function buildSiriStopMonitoringRequest(options: SiriStopMonitoringRequestOptions): string {
  const request: SiriElement = {
    ...(options.monitoringRef ? { MonitoringRef: options.monitoringRef } : {}),
    ...(options.lineRef ? { LineRef: options.lineRef } : {}),
    ...(options.directionRef ? { DirectionRef: options.directionRef } : {}),
    ...(options.detailLevel ? { StopMonitoringDetailLevel: options.detailLevel } : {}),
    ...(options.previewInterval ? { PreviewInterval: options.previewInterval } : {}),
    ...(options.stopVisitTypes ? { StopVisitTypes: options.stopVisitTypes } : {}),
    ...(options.maximumStopVisits != null
      ? { MaximumStopVisits: String(options.maximumStopVisits) }
      : {}),
    ...(options.minimumStopVisitsPerLine != null
      ? { MinimumStopVisitsPerLine: String(options.minimumStopVisitsPerLine) }
      : {}),
    ...(options.additionalFields ?? {}),
  };

  return buildSiriServiceRequest({
    requestTimestamp: options.requestTimestamp,
    requestorRef: options.requestorRef,
    requests: {
      StopMonitoringRequest: request,
    },
    serviceRequestFields: options.serviceRequestFields,
    version: options.version,
  });
}
