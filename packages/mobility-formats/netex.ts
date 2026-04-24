import { isDeepStrictEqual } from "node:util";
import {
  getXmlAttribute,
  getXmlChild,
  isXmlObject,
  parseXmlDocument,
  stripXmlNamespace,
  type XmlObject,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

export type NetexElement = XmlObject;
export type NetexEnvelope = XmlObject & { PublicationDelivery: NetexElement };
export type NetexEntityIndex = Record<string, NetexElement>;

function parseNetexInput(input: string | NetexEnvelope): NetexEnvelope {
  if (typeof input !== "string") return input;
  return parseNetexDocument(input);
}

function collectNetexElements(
  node: unknown,
  predicate: (elementName: string) => boolean,
  results: NetexElement[],
): void {
  if (!isXmlObject(node)) return;

  for (const [key, value] of Object.entries(node)) {
    const elementName = stripXmlNamespace(key);
    for (const child of xmlNodeToArray(value).filter(isXmlObject)) {
      if (predicate(elementName)) results.push(child);
      collectNetexElements(child, predicate, results);
    }
  }
}

function collectNetexIndexedElements(
  node: unknown,
  index: NetexEntityIndex,
  predicate?: (elementName: string) => boolean,
): void {
  if (!isXmlObject(node)) return;

  for (const [key, value] of Object.entries(node)) {
    const elementName = stripXmlNamespace(key);
    for (const child of xmlNodeToArray(value).filter(isXmlObject)) {
      const id = getXmlAttribute(child, "id");
      if (id && (!predicate || predicate(elementName))) {
        const existing = index[id];
        if (existing && !isDeepStrictEqual(existing, child)) {
          throw new Error(`Conflicting NeTEx entity for id "${id}".`);
        }
        index[id] = child;
      }
      collectNetexIndexedElements(child, index, predicate);
    }
  }
}

export function parseNetexDocument(content: string): NetexEnvelope {
  const parsed = parseXmlDocument(content);
  if (!isXmlObject(parsed.PublicationDelivery)) {
    throw new Error("Expected NeTEx PublicationDelivery root element.");
  }
  return parsed as NetexEnvelope;
}

export function getNetexPublicationDelivery(
  input: string | NetexEnvelope,
): NetexElement | undefined {
  return parseNetexInput(input).PublicationDelivery;
}

export function getNetexPublicationTimestamp(input: string | NetexEnvelope): string | undefined {
  return xmlText(getNetexPublicationDelivery(input)?.PublicationTimestamp);
}

export function getNetexParticipantRef(input: string | NetexEnvelope): string | undefined {
  return xmlText(getNetexPublicationDelivery(input)?.ParticipantRef);
}

export function listNetexDataObjects(input: string | NetexEnvelope): NetexElement[] {
  const delivery = getNetexPublicationDelivery(input);
  const dataObjects = getXmlChild(delivery, "dataObjects");
  if (!dataObjects) return [];

  const results: NetexElement[] = [];
  for (const value of Object.values(dataObjects)) {
    results.push(...xmlNodeToArray(value).filter(isXmlObject));
  }
  return results;
}

export function listNetexFrames(input: string | NetexEnvelope): NetexElement[] {
  const results: NetexElement[] = [];
  collectNetexElements(
    getNetexPublicationDelivery(input),
    (name) => name.endsWith("Frame"),
    results,
  );
  return results;
}

export function listNetexFramesByName(
  input: string | NetexEnvelope,
  frameName: string,
): NetexElement[] {
  const results: NetexElement[] = [];
  collectNetexElements(getNetexPublicationDelivery(input), (name) => name === frameName, results);
  return results;
}

export function listNetexElementsByName(
  input: string | NetexEnvelope,
  elementName: string,
): NetexElement[] {
  const results: NetexElement[] = [];
  collectNetexElements(getNetexPublicationDelivery(input), (name) => name === elementName, results);
  return results;
}

export function listNetexScheduledStopPoints(input: string | NetexEnvelope): NetexElement[] {
  return listNetexElementsByName(input, "ScheduledStopPoint");
}

export function listNetexStopPlaces(input: string | NetexEnvelope): NetexElement[] {
  return listNetexElementsByName(input, "StopPlace");
}

export function listNetexQuays(input: string | NetexEnvelope): NetexElement[] {
  return listNetexElementsByName(input, "Quay");
}

export function listNetexLines(input: string | NetexEnvelope): NetexElement[] {
  return listNetexElementsByName(input, "Line");
}

export function listNetexRoutes(input: string | NetexEnvelope): NetexElement[] {
  return listNetexElementsByName(input, "Route");
}

export function listNetexJourneyPatterns(input: string | NetexEnvelope): NetexElement[] {
  return listNetexElementsByName(input, "JourneyPattern");
}

export function listNetexServiceJourneys(input: string | NetexEnvelope): NetexElement[] {
  return listNetexElementsByName(input, "ServiceJourney");
}

export function indexNetexElementsById(
  input: string | NetexEnvelope,
  elementNames?: string[],
): NetexEntityIndex {
  const allowedNames = elementNames ? new Set(elementNames) : null;
  const index: NetexEntityIndex = {};
  collectNetexIndexedElements(
    getNetexPublicationDelivery(input),
    index,
    allowedNames ? (name) => allowedNames.has(name) : undefined,
  );
  return index;
}

export function resolveNetexRef(
  index: NetexEntityIndex,
  ref: string | null | undefined,
): NetexElement | undefined {
  if (!ref) return undefined;
  return index[ref];
}
