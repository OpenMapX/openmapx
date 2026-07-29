import { XMLParser } from "fast-xml-parser";

type XmlRecord = Record<string, unknown>;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

export function parseDatex(xml: string): XmlRecord {
  return parser.parse(xml) as XmlRecord;
}

export function xmlText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number")
    return String(value).trim() || undefined;
  if (value && typeof value === "object" && !Array.isArray(value))
    return xmlText((value as XmlRecord)["#text"]);
  return undefined;
}

export function xmlNumber(value: unknown): number | undefined {
  const parsed = Number(xmlText(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function xmlPath(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as XmlRecord)[key];
  }
  return current;
}

export function xmlRecords(value: unknown, key: string, result: XmlRecord[] = []): XmlRecord[] {
  if (Array.isArray(value)) {
    for (const entry of value) xmlRecords(entry, key, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [childKey, child] of Object.entries(value as XmlRecord)) {
    if (childKey === key) {
      for (const entry of Array.isArray(child) ? child : [child]) {
        if (entry && typeof entry === "object" && !Array.isArray(entry))
          result.push(entry as XmlRecord);
      }
    }
    xmlRecords(child, key, result);
  }
  return result;
}
