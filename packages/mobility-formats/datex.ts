import { isDeepStrictEqual } from "node:util";
import {
  getXmlAttribute,
  getXmlChild,
  getXmlChildren,
  isXmlObject,
  parseXmlDocument,
  stripXmlNamespace,
  type XmlObject,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

export type DatexElement = XmlObject;
export type DatexEntityIndex = Record<string, DatexElement>;
export type DatexInput = string | DatexEnvelope | DatexElement;

export interface DatexEnvelope extends XmlObject {
  d2LogicalModel?: DatexElement;
  D2LogicalModel?: DatexElement;
}

export interface DatexMultilingualValue {
  language?: string;
  value: string;
}

export const DATEX_PUBLICATION_TYPES = {
  elaboratedData: "ElaboratedDataPublication",
  generic: "GenericPublication",
  measuredData: "MeasuredDataPublication",
  measurementSiteTable: "MeasurementSiteTablePublication",
  parkingTable: "ParkingTablePublication",
  predefinedLocations: "PredefinedLocationsPublication",
  situation: "SituationPublication",
  trafficView: "TrafficViewPublication",
  vms: "VmsPublication",
  vmsTable: "VmsTablePublication",
} as const;

function parseDatexRoot(input: DatexInput): DatexElement {
  if (typeof input === "string") return parseXmlDocument(input);
  return input;
}

function normalizeDatexTypeName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return stripXmlNamespace(value.trim());
}

function collectDatexElements(
  node: unknown,
  predicate: (elementName: string) => boolean,
  results: DatexElement[],
): void {
  if (!isXmlObject(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;

    const elementName = stripXmlNamespace(key);
    for (const child of xmlNodeToArray(value).filter(isXmlObject)) {
      if (predicate(elementName)) results.push(child);
      collectDatexElements(child, predicate, results);
    }
  }
}

function collectDatexIndexedElements(
  node: unknown,
  index: DatexEntityIndex,
  predicate?: (elementName: string) => boolean,
): void {
  if (!isXmlObject(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;

    const elementName = stripXmlNamespace(key);
    for (const child of xmlNodeToArray(value).filter(isXmlObject)) {
      const id = getDatexElementId(child);
      if (id && (!predicate || predicate(elementName))) {
        const existing = index[id];
        if (existing && !isDeepStrictEqual(existing, child)) {
          throw new Error(`Conflicting DATEX II entity for id "${id}".`);
        }
        index[id] = child;
      }

      collectDatexIndexedElements(child, index, predicate);
    }
  }
}

function getDatexPublicationEntry(
  logicalModel: DatexElement | undefined,
): [elementName: string, element: DatexElement] | undefined {
  if (!logicalModel) return undefined;

  for (const key of ["payload", "payloadPublication"]) {
    const child = getXmlChild(logicalModel, key);
    if (child) return [key, child];
  }

  for (const [key, value] of Object.entries(logicalModel)) {
    if (key.startsWith("@_")) continue;

    const elementName = stripXmlNamespace(key);
    if (!elementName.endsWith("Publication")) continue;

    const element = xmlNodeToArray(value).find(isXmlObject);
    if (element) return [elementName, element];
  }

  return undefined;
}

function collectMultilingualEntries(node: unknown): DatexMultilingualValue[] {
  if (!isXmlObject(node)) return [];

  const candidates: unknown[] = [
    ...xmlNodeToArray(node.value),
    ...xmlNodeToArray(getXmlChild(node, "values")?.value),
  ];

  const entries = candidates.flatMap((candidate) => {
    const value = xmlText(candidate);
    if (value == null) return [];

    return [
      {
        language: getXmlAttribute(candidate, "lang") ?? getXmlAttribute(candidate, "language"),
        value,
      },
    ];
  });

  if (entries.length > 0) return entries;

  const value = xmlText(node);
  if (value == null) return [];

  return [
    {
      language: getXmlAttribute(node, "lang") ?? getXmlAttribute(node, "language"),
      value,
    },
  ];
}

export function parseDatexDocument(content: string): DatexEnvelope {
  const parsed = parseXmlDocument(content);
  const logicalModel = parsed.d2LogicalModel ?? parsed.D2LogicalModel;
  if (!isXmlObject(logicalModel)) {
    throw new Error("Expected DATEX II d2LogicalModel root element.");
  }
  return parsed as DatexEnvelope;
}

function looksLikeDatexPayload(node: unknown): node is DatexElement {
  if (!isXmlObject(node)) return false;

  return (
    "publicationTime" in node ||
    "publicationCreator" in node ||
    "parkingRecordStatus" in node ||
    "parkingTable" in node ||
    "situation" in node ||
    "siteMeasurements" in node
  );
}

function getDirectDatexPayload(node: unknown): DatexElement | undefined {
  if (!isXmlObject(node)) return undefined;

  const payload = getXmlChild(node, "payload") ?? getXmlChild(node, "payloadPublication");
  if (payload) return payload;

  return looksLikeDatexPayload(node) ? node : undefined;
}

export function getDatexLogicalModel(input: DatexInput): DatexElement | undefined {
  const root = parseDatexRoot(input);
  const logicalModel = root.d2LogicalModel ?? root.D2LogicalModel;
  return isXmlObject(logicalModel) ? logicalModel : undefined;
}

export function getDatexExchange(input: DatexInput): DatexElement | undefined {
  return getXmlChild(getDatexLogicalModel(input), "exchange");
}

export function getDatexSupplierIdentification(input: DatexInput): DatexElement | undefined {
  return getXmlChild(getDatexExchange(input), "supplierIdentification");
}

export function getDatexSupplierCountry(input: DatexInput): string | undefined {
  return xmlText(getDatexSupplierIdentification(input)?.country);
}

export function getDatexSupplierNationalIdentifier(input: DatexInput): string | undefined {
  return xmlText(getDatexSupplierIdentification(input)?.nationalIdentifier);
}

export function getDatexPayloadPublication(input: DatexInput): DatexElement | undefined {
  const root = parseDatexRoot(input);
  const logicalModel = getDatexLogicalModel(root);
  const publicationEntry = getDatexPublicationEntry(logicalModel);
  if (publicationEntry) return publicationEntry[1];

  const directPayload = getDirectDatexPayload(root);
  if (directPayload) return directPayload;

  return getDirectDatexPayload(getXmlChild(root, "messageContainer"));
}

export function getDatexPayloadPublicationElementName(input: DatexInput): string | undefined {
  const root = parseDatexRoot(input);
  const logicalModel = getDatexLogicalModel(root);
  const publicationEntry = getDatexPublicationEntry(logicalModel);
  if (publicationEntry) return publicationEntry[0];

  if (getXmlChild(root, "payload")) return "payload";
  if (getXmlChild(root, "payloadPublication")) return "payloadPublication";

  const messageContainer = getXmlChild(root, "messageContainer");
  if (messageContainer) {
    if (getXmlChild(messageContainer, "payload")) return "payload";
    if (getXmlChild(messageContainer, "payloadPublication")) return "payloadPublication";
  }

  return undefined;
}

export function getDatexPayloadPublicationType(input: DatexInput): string | undefined {
  const publication = getDatexPayloadPublication(input);
  const explicitType = normalizeDatexTypeName(getXmlAttribute(publication, "type"));
  if (explicitType) return explicitType;

  const elementName = getDatexPayloadPublicationElementName(input);
  return elementName?.endsWith("Publication") ? elementName : undefined;
}

export function isDatexPublicationType(input: DatexInput, publicationType: string): boolean {
  return getDatexPayloadPublicationType(input) === publicationType;
}

export function getDatexModelBaseVersion(input: DatexInput): string | undefined {
  return (
    getXmlAttribute(getDatexPayloadPublication(input), "modelBaseVersion") ??
    getXmlAttribute(getDatexLogicalModel(input), "modelBaseVersion")
  );
}

export function getDatexPublicationLanguage(input: DatexInput): string | undefined {
  return (
    getXmlAttribute(getDatexPayloadPublication(input), "lang") ??
    getXmlAttribute(getDatexPayloadPublication(input), "language")
  );
}

export function getDatexPublicationTime(input: DatexInput): string | undefined {
  return xmlText(getDatexPayloadPublication(input)?.publicationTime);
}

export function getDatexPublicationCreator(input: DatexInput): DatexElement | undefined {
  return getXmlChild(getDatexPayloadPublication(input), "publicationCreator");
}

export function getDatexPublicationCreatorCountry(input: DatexInput): string | undefined {
  return xmlText(getDatexPublicationCreator(input)?.country);
}

export function getDatexPublicationCreatorNationalIdentifier(
  input: DatexInput,
): string | undefined {
  return xmlText(getDatexPublicationCreator(input)?.nationalIdentifier);
}

export function getDatexElementId(node: unknown): string | undefined {
  return getXmlAttribute(node, "id");
}

export function getDatexElementType(node: unknown): string | undefined {
  return normalizeDatexTypeName(getXmlAttribute(node, "type"));
}

export function listDatexElementsByName(input: DatexInput, elementName: string): DatexElement[] {
  const results: DatexElement[] = [];
  collectDatexElements(getDatexLogicalModel(input), (name) => name === elementName, results);
  return results;
}

export function listDatexSituations(input: DatexInput): DatexElement[] {
  return getXmlChildren(getDatexPayloadPublication(input), "situation");
}

export function listDatexSituationRecords(input: DatexInput): DatexElement[] {
  return listDatexSituations(input).flatMap((situation) =>
    getXmlChildren(situation, "situationRecord"),
  );
}

export function listDatexSiteMeasurements(input: DatexInput): DatexElement[] {
  return getXmlChildren(getDatexPayloadPublication(input), "siteMeasurements");
}

export function listDatexMeasuredValues(input: DatexInput): DatexElement[] {
  return listDatexSiteMeasurements(input).flatMap((siteMeasurement) =>
    getXmlChildren(siteMeasurement, "measuredValue"),
  );
}

export function listDatexElaboratedData(input: DatexInput): DatexElement[] {
  return getXmlChildren(getDatexPayloadPublication(input), "elaboratedData");
}

export function listDatexMeasurementSiteTables(input: DatexInput): DatexElement[] {
  return getXmlChildren(getDatexPayloadPublication(input), "measurementSiteTable");
}

export function listDatexMeasurementSiteRecords(input: DatexInput): DatexElement[] {
  return listDatexMeasurementSiteTables(input).flatMap((table) =>
    getXmlChildren(table, "measurementSiteRecord"),
  );
}

export function listDatexParkingTables(input: DatexInput): DatexElement[] {
  const publication = getDatexPayloadPublication(input);
  const directTables = getXmlChildren(publication, "parkingTable");
  if (directTables.length > 0) return directTables;

  const genericExtension = getXmlChild(publication, "genericPublicationExtension");
  const tablePublication =
    getXmlChild(genericExtension, "parkingTablePublication") ??
    getXmlChild(publication, "parkingTablePublication");
  if (!tablePublication) return [];

  return getXmlChildren(tablePublication, "parkingTable");
}

export function listDatexParkingRecords(input: DatexInput): DatexElement[] {
  return listDatexParkingTables(input).flatMap((table) => getXmlChildren(table, "parkingRecord"));
}

export function listDatexParkingRecordStatuses(input: DatexInput): DatexElement[] {
  const publication = getDatexPayloadPublication(input);
  const directStatuses = getXmlChildren(publication, "parkingRecordStatus");
  const genericExtension = getXmlChild(publication, "genericPublicationExtension");
  const statusPublication =
    getXmlChild(genericExtension, "parkingStatusPublication") ??
    getXmlChild(publication, "parkingStatusPublication");
  const nestedStatuses = getXmlChildren(statusPublication, "parkingRecordStatus");
  return [...directStatuses, ...nestedStatuses];
}

export function listDatexMultilingualValues(node: unknown): DatexMultilingualValue[] {
  const seen = new Set<string>();
  const values: DatexMultilingualValue[] = [];

  for (const entry of collectMultilingualEntries(node)) {
    const key = `${entry.language ?? ""}\u0000${entry.value}`;
    if (seen.has(key)) continue;

    seen.add(key);
    values.push(entry);
  }

  return values;
}

export function resolveDatexMultilingualValue(
  node: unknown,
  preferredLanguages: string[] = [],
): string | undefined {
  const values = listDatexMultilingualValues(node);
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

export function indexDatexElementsById(
  input: DatexInput,
  elementNames?: string[],
): DatexEntityIndex {
  const allowedNames = elementNames ? new Set(elementNames) : null;
  const index: DatexEntityIndex = {};

  collectDatexIndexedElements(
    getDatexLogicalModel(input),
    index,
    allowedNames ? (name) => allowedNames.has(name) : undefined,
  );

  return index;
}

export function resolveDatexRef(
  index: DatexEntityIndex,
  ref: string | null | undefined,
): DatexElement | undefined {
  if (!ref) return undefined;
  return index[ref];
}
