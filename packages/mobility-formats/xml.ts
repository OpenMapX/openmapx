import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";

export interface XmlObject {
  [key: string]: unknown;
}

export interface XmlParseOptions {
  ignoreAttributes?: boolean;
  preserveOrder?: boolean;
  removeNamespacePrefix?: boolean;
  validate?: boolean;
}

export interface XmlBuildOptions {
  encoding?: string;
  format?: boolean;
  ignoreAttributes?: boolean;
  indentBy?: string;
  suppressEmptyNode?: boolean;
  xmlDeclaration?: boolean;
}

const XML_ATTRIBUTE_PREFIX = "@_";

function validationMessage(result: unknown): string {
  if (result === true) return "";
  if (
    typeof result === "object" &&
    result !== null &&
    "err" in result &&
    typeof result.err === "object" &&
    result.err !== null &&
    "msg" in result.err &&
    typeof result.err.msg === "string"
  ) {
    return result.err.msg;
  }
  return "Unknown XML validation error";
}

function createXmlParser(options: XmlParseOptions = {}): XMLParser {
  return new XMLParser({
    attributeNamePrefix: XML_ATTRIBUTE_PREFIX,
    ignoreAttributes: options.ignoreAttributes ?? false,
    parseAttributeValue: false,
    parseTagValue: false,
    preserveOrder: options.preserveOrder ?? false,
    processEntities: true,
    removeNSPrefix: options.removeNamespacePrefix ?? true,
    trimValues: true,
  });
}

function createXmlBuilder(options: XmlBuildOptions = {}): XMLBuilder {
  return new XMLBuilder({
    attributeNamePrefix: XML_ATTRIBUTE_PREFIX,
    format: options.format ?? true,
    ignoreAttributes: options.ignoreAttributes ?? false,
    indentBy: options.indentBy ?? "  ",
    suppressEmptyNode: options.suppressEmptyNode ?? false,
  });
}

export function isXmlObject(value: unknown): value is XmlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripXmlNamespace(name: string): string {
  const separatorIndex = name.indexOf(":");
  return separatorIndex >= 0 ? name.slice(separatorIndex + 1) : name;
}

// Transit feeds (SIRI/OJP/NetEx/DATEX/GTFS-RT) never declare custom XML
// entities. Reject any document that does: an internal-subset `<!ENTITY ...>`
// is the "billion laughs" amplification vector, and the parser runs on live,
// third-party feeds. Numeric/predefined entity decoding stays enabled. The
// guard is exported so parsers that need fast-xml-parser's default value
// coercion can apply the same rejection without switching to parseXmlDocument.
export function assertNoXmlEntityDeclarations(content: string): void {
  // Case-insensitive scan for an ENTITY declaration anywhere in the prolog.
  if (/<!ENTITY/i.test(content)) {
    throw new Error("XML entity declarations are not allowed");
  }
}

export function parseXmlDocument(content: string, options: XmlParseOptions = {}): XmlObject {
  assertNoXmlEntityDeclarations(content);

  if (options.validate ?? true) {
    const validationResult = XMLValidator.validate(content);
    if (validationResult !== true) {
      throw new Error(`Invalid XML document: ${validationMessage(validationResult)}`);
    }
  }

  const parsed = createXmlParser(options).parse(content);
  if (!isXmlObject(parsed)) throw new Error("Expected XML document to parse into an object root.");
  return parsed;
}

export function buildXmlDocument(document: XmlObject, options: XmlBuildOptions = {}): string {
  const xml = createXmlBuilder(options).build(document);
  if (!(options.xmlDeclaration ?? false)) return xml;

  const encoding = options.encoding ?? "UTF-8";
  return `<?xml version="1.0" encoding="${encoding}"?>\n${xml}`;
}

export function xmlNodeToArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function xmlText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!isXmlObject(value)) return undefined;

  const textValue = value["#text"] ?? value.text;
  if (typeof textValue === "string") return textValue;
  if (typeof textValue === "number" || typeof textValue === "boolean") return String(textValue);
  return undefined;
}

export function getXmlAttribute(node: unknown, name: string): string | undefined {
  if (!isXmlObject(node)) return undefined;
  return xmlText(node[`${XML_ATTRIBUTE_PREFIX}${name}`]);
}

export function getXmlChild(node: unknown, key: string): XmlObject | undefined {
  if (!isXmlObject(node)) return undefined;
  const child = node[key];
  return isXmlObject(child) ? child : undefined;
}

export function getXmlChildren(node: unknown, key: string): XmlObject[] {
  if (!isXmlObject(node)) return [];
  return xmlNodeToArray(node[key]).filter(isXmlObject);
}
