import type { BoundingBox, DataSourceAttribution } from "@openmapx/core";
import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";

export function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function parseLocalizedNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .replace(/\s+/g, "")
    .replace(",", ".")
    .match(/-?\d+(?:\.\d+)?/)?.[0];
  if (!normalized) return undefined;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function isSafeHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function bboxContainsCoordinates(bbox: BoundingBox, coordinates: [number, number]): boolean {
  const [lng, lat] = coordinates;
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

export function bboxOverlaps(
  bbox: BoundingBox,
  coverage: { south: number; west: number; north: number; east: number },
): boolean {
  return (
    bbox.south <= coverage.north &&
    bbox.north >= coverage.south &&
    bbox.west <= coverage.east &&
    bbox.east >= coverage.west
  );
}

export function bboxCenter(bbox: BoundingBox): [number, number] {
  return [(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2];
}

const EARTH_M = 6_371_000;

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,|]/)
    .map((part) => cleanString(part))
    .filter((part): part is string => Boolean(part));
}

export function uniqueStrings(values: Array<string[] | undefined>): string[] | undefined {
  const seen = new Map<string, string>();
  for (const arr of values) {
    for (const value of arr ?? []) {
      const cleaned = cleanString(value);
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (!seen.has(key)) seen.set(key, cleaned);
    }
  }
  return seen.size > 0 ? Array.from(seen.values()) : undefined;
}

export function uniqueAttributions(
  values: Array<DataSourceAttribution[] | undefined>,
): DataSourceAttribution[] | undefined {
  const seen = new Map<string, DataSourceAttribution>();
  for (const arr of values) {
    for (const attribution of arr ?? []) {
      const key = [
        attribution.text.toLowerCase(),
        attribution.url,
        attribution.license ?? "",
        attribution.licenseUrl ?? "",
      ].join("|");
      if (!seen.has(key)) seen.set(key, attribution);
    }
  }
  return seen.size > 0 ? Array.from(seen.values()) : undefined;
}

export function joinAddress(parts: Array<string | undefined>): string | undefined {
  return parts.filter(Boolean).join(" ") || undefined;
}

export function newestIsoString(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (time > bestTime) {
      best = value;
      bestTime = time;
    }
  }
  return best;
}

export function normalizeConnectorType(value: string | undefined): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const lower = cleaned.toLowerCase();
  if (lower.includes("combo") || lower.includes("ccs") || lower === "j1772combo") return "CCS";
  if (lower.includes("chademo")) return "CHAdeMO";
  if (lower.includes("typ 2") || lower.includes("type 2") || lower.includes("iec 62196-2")) {
    return "Type 2";
  }
  if (lower.includes("typ 1") || lower.includes("type 1") || lower === "j1772") return "Type 1";
  if (lower.includes("tesla") || lower === "j3271" || lower === "nacs") return "Tesla";
  if (lower.includes("schuko") || lower.includes("cee 7") || lower.startsWith("nema")) {
    return "Schuko";
  }
  return cleaned;
}

export function inferCurrentType(type: string | undefined, fallback?: string): string | undefined {
  const cleanedFallback = cleanString(fallback);
  const lower = `${type ?? ""} ${cleanedFallback ?? ""}`.toLowerCase();
  if (
    lower.includes("dc") ||
    lower.includes("ccs") ||
    lower.includes("combo") ||
    lower.includes("chademo")
  ) {
    return "DC";
  }
  if (lower.includes("ac") || lower.includes("type 2") || lower.includes("typ 2")) return "AC";
  return cleanedFallback;
}

export function connector(input: EvChargingConnector): EvChargingConnector {
  return {
    ...input,
    type: normalizeConnectorType(input.type),
    currentType: inferCurrentType(input.type, input.currentType),
    quantity: input.quantity && input.quantity > 0 ? input.quantity : undefined,
  };
}
