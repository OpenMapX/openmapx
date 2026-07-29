import {
  type BoundingBox,
  type DataSourceAttribution,
  haversineMeters as haversineMetersCore,
} from "@openmapx/core";
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

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  return haversineMetersCore(lat1, lng1, lat2, lng2);
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

/**
 * OCPI Location identity fields relevant to poiId derivation. `id` alone is
 * only unique per `country_code` + `party_id` (different CPOs reuse the same
 * `id` value) — see the DOT-NL scout report — so the poiId must be the
 * composite of all three, not `id` alone.
 */
export interface OcpiLocationIdentity {
  id?: string;
  country_code?: string;
  party_id?: string;
}

/**
 * Derives the DOT-NL station poiId from an OCPI Location's composite
 * identity (`country_code` + `party_id` + `id`), uppercasing the
 * country/party components for stability while keeping `id` opaque. Used by
 * BOTH the static and live DOT-NL parsers — they MUST stay identical or
 * live-merge stops joining to the right station. Returns undefined when
 * `id` is missing/blank. Falls back to `id` alone only when both
 * `country_code` and `party_id` are absent; if only one is present, it's
 * still folded into the key (partial specificity beats none).
 */
export function nlDotnlLocationPoiId(location: OcpiLocationIdentity): string | undefined {
  const id = cleanString(location.id);
  if (!id) return undefined;
  const countryCode = cleanString(location.country_code)?.toUpperCase();
  const partyId = cleanString(location.party_id)?.toUpperCase();
  const prefixParts = [countryCode, partyId].filter((part): part is string => Boolean(part));
  const key = prefixParts.length > 0 ? `${prefixParts.join("*")}*${id}` : id;
  return encodeURIComponent(key);
}

/**
 * Derives the OCPDB station poiId. Unlike the raw DOT-NL feed, OCPDB assigns
 * its own already-deduplicated, globally-stable numeric `id` per location, so
 * no composite country/party key is needed. Used by BOTH the static and live
 * OCPDB parsers — they MUST stay identical or live-merge stops joining to the
 * right station. Returns undefined when `id` is missing/blank.
 */
export function deOcpdbLocationPoiId(location: { id?: unknown }): string | undefined {
  return idString(location.id);
}

/**
 * Coerces an OCPDB id (tariff id, evse uid, location id) to a stable string
 * key. Ids are JSON strings today, but harden against OCPDB ever emitting a
 * number — otherwise a bare string check would drop every row and silently kill
 * the pricing join.
 */
export function idString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return cleanString(value);
}

/**
 * Deterministic short id derived from arbitrary parts. Many national feeds
 * (Ireland ESB, NZ EVRoam, Cyprus, Australia, Luxembourg) carry no stable
 * native station id, so the parser synthesises one from
 * territory/address/coordinates. djb2 → unsigned base36 keeps it compact and
 * table-name-safe; stable across re-downloads as long as the inputs are.
 */
export function stableHashId(...parts: Array<string | number | undefined>): string {
  const joined = parts.map((part) => (part === undefined ? "" : String(part))).join("|");
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function connector(input: EvChargingConnector): EvChargingConnector {
  return {
    ...input,
    type: normalizeConnectorType(input.type),
    currentType: inferCurrentType(input.type, input.currentType),
    quantity: input.quantity && input.quantity > 0 ? input.quantity : undefined,
  };
}

interface ConnectorGroup {
  type?: string;
  powerKw?: number;
  currentType?: string;
  quantity: number;
  status?: string;
  statusDiverged: boolean;
}

/**
 * Collapses physically-identical connectors (same type/power/currentType)
 * into a single row with a summed quantity, so a station with e.g. six
 * identical Type 2 plugs shows one grouped row instead of six. `status` is
 * kept only when every member of the group shares it; otherwise it's
 * dropped rather than picking one arbitrarily. Per-connector `reference` is
 * not carried into the grouped result. Output is sorted by descending
 * powerKw, matching the ungrouped table's prior sort order.
 */
export function groupConnectors(connectors: EvChargingConnector[]): EvChargingConnector[] {
  const groups = new Map<string, ConnectorGroup>();
  for (const conn of connectors) {
    const key = `${conn.type ?? ""}|${conn.powerKw ?? ""}|${conn.currentType ?? ""}`;
    const existing = groups.get(key);
    const quantity = conn.quantity && conn.quantity > 0 ? conn.quantity : 1;
    if (!existing) {
      groups.set(key, {
        type: conn.type,
        powerKw: conn.powerKw,
        currentType: conn.currentType,
        quantity,
        status: conn.status,
        statusDiverged: false,
      });
      continue;
    }
    existing.quantity += quantity;
    if (existing.status !== conn.status) existing.statusDiverged = true;
  }
  return Array.from(groups.values())
    .map(
      (group): EvChargingConnector => ({
        type: group.type,
        powerKw: group.powerKw,
        currentType: group.currentType,
        quantity: group.quantity,
        status: group.statusDiverged ? undefined : group.status,
      }),
    )
    .sort((a, b) => (b.powerKw ?? 0) - (a.powerKw ?? 0));
}
