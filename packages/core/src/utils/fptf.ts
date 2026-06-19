/**
 * Shared FPTF (Friendly Public Transport Format) normalization utilities.
 *
 * Used by hafas-mgate adapter, hafas provider, and db-vendo provider to avoid
 * duplicating departure/remark normalization logic.
 */
import type {
  Departure,
  OccupancyLevel,
  TransportMode,
  TripRemark,
} from "@openmapx/mobility-core/transit";

/**
 * Maps FPTF product strings to internal TransportMode values.
 * Superset covering hafas-client, hafas-mgate, and db-vendo-client products.
 */
export const FPTF_PRODUCT_MODE: Readonly<Record<string, TransportMode>> = {
  nationalExpress: "rail",
  national: "rail",
  interregional: "rail",
  regionalExpress: "rail",
  regional: "rail",
  "express-train": "rail",
  "long-distance-train": "rail",
  "long-distance-train-1": "rail",
  "long-distance-train-2": "rail",
  "long-distance-train-3": "rail",
  "long-distance-train-4": "rail",
  "regional-train": "rail",
  suburban: "rail",
  "s-bahn": "rail",
  subway: "subway",
  "u-bahn": "subway",
  tram: "tram",
  bus: "bus",
  ferry: "ferry",
  onCall: "bus",
  "on-call": "bus",
  "on-demand": "bus",
  taxi: "bus",
  gondola: "gondola",
  funicular: "funicular",
  cableCar: "cable_car",
};

/**
 * Infer TransportMode from a product string that isn't in the exact-match table.
 * Checks for common substrings in product IDs across HAFAS endpoints.
 */
function inferModeFromProduct(product: string): TransportMode | null {
  const lower = product.toLowerCase();
  if (
    lower.includes("express") ||
    lower.includes("train") ||
    lower.includes("regional") ||
    lower.includes("suburban") ||
    lower.includes("bahn") ||
    lower.includes("intercity")
  )
    return "rail";
  if (lower.includes("subway") || lower.includes("metro") || lower.includes("underground"))
    return "subway";
  if (lower.includes("tram") || lower.includes("streetcar") || lower.includes("straßenbahn"))
    return "tram";
  if (lower.includes("ferry") || lower.includes("watercraft") || lower.includes("fähre"))
    return "ferry";
  if (lower.includes("funicular")) return "funicular";
  if (lower.includes("gondola") || lower.includes("cable")) return "cable_car";
  return null;
}

/**
 * Infer TransportMode from a route/line name when product info is missing or wrong.
 * Matches well-known European line name patterns.
 */
export function inferModeFromName(name: string): TransportMode | null {
  const trimmed = name.trim();
  if (/^(ICE|IC|EC|EN|TGV|THA|EIC|EX|CNL|NJ|RJ|RJX|EST|EUR|Thalys|Eurostar)\b/i.test(trimmed))
    return "rail";
  if (/^(RE|RB|IRE|MEX|FEX|HLB|AKN|ERB|WFB|NWB|RTB|VIA)\b/i.test(trimmed)) return "rail";
  if (/^S\d/i.test(trimmed)) return "rail";
  if (/^U\d/i.test(trimmed)) return "subway";
  if (/^STR\s?\d/i.test(trimmed)) return "tram";
  return null;
}

/** Resolve a single FPTF product string to a TransportMode. */
export function productToMode(product: string | undefined): TransportMode {
  if (!product) return "bus";
  return FPTF_PRODUCT_MODE[product] ?? inferModeFromProduct(product) ?? "bus";
}

/** Derive the modes served by a stop from its FPTF products bitmask map. */
export function mapProducts(products: Record<string, boolean> | undefined): TransportMode[] {
  if (!products) return ["bus"];
  const modes: TransportMode[] = [];
  for (const [key, enabled] of Object.entries(products)) {
    if (enabled) {
      const mode = FPTF_PRODUCT_MODE[key] ?? inferModeFromProduct(key) ?? "bus";
      if (!modes.includes(mode)) modes.push(mode);
    }
  }
  return modes.length ? modes : ["bus"];
}

/** Normalize FPTF remarks array with deduplication. */
export function normalizeRemarks(raw: unknown[] | undefined): TripRemark[] | undefined {
  if (!raw?.length) return undefined;
  const seen = new Set<string>();
  const result: TripRemark[] = [];
  for (const r of raw as Array<{ type?: string; code?: string; summary?: string; text?: string }>) {
    const text = r.summary ?? r.text ?? "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    let type: TripRemark["type"] = "info";
    if (r.type === "warning") type = "warning";
    else if (/cancel|nicht|ausfall|fährt\s+nicht/i.test(text)) type = "cancellation";
    result.push({ text, type });
  }
  return result.length ? result : undefined;
}

/**
 * Map an FPTF `loadFactor` (db-vendo-client / hafas-client occupancy, derived
 * from DB `auslastungsmeldungen` stufe 1–4) to our `OccupancyLevel`:
 * low-to-medium → low · high → medium · very-high → high · exceptionally-high → overcrowded.
 */
export function mapFptfLoadFactor(loadFactor: string | undefined): OccupancyLevel | undefined {
  switch (loadFactor) {
    case "low-to-medium":
      return "low";
    case "high":
      return "medium";
    case "very-high":
      return "high";
    case "exceptionally-high":
      return "overcrowded";
    default:
      return undefined;
  }
}

/**
 * Normalize a raw FPTF departure object into the internal Departure type.
 *
 * @param d     Raw FPTF departure (from hafas-client or hafas-mgate)
 * @param prefix  ID prefix for this provider (e.g. "db:", "tfl:")
 */
// biome-ignore lint/suspicious/noExplicitAny: FPTF departure shape varies by provider
export function normalizeFptfDeparture(d: any, prefix: string): Departure {
  const line = d.line ?? {};
  let mode = productToMode(line.product);
  // Safety net: if product mapping fell through to "bus" but the line name
  // is clearly a train/subway/tram, override with the inferred mode.
  if (mode === "bus") {
    const nameMode = inferModeFromName(line.name ?? "");
    if (nameMode) mode = nameMode;
  }
  const scheduledAt = d.plannedWhen ?? d.when ?? new Date().toISOString();
  const delaySeconds: number | undefined = typeof d.delay === "number" ? d.delay : undefined;
  const expectedAt =
    delaySeconds !== undefined
      ? new Date(new Date(scheduledAt).getTime() + delaySeconds * 1000).toISOString()
      : undefined;
  return {
    tripId: d.tripId ? `${prefix}${d.tripId}` : "",
    route: {
      id: `${prefix}${line.id ?? line.fahrtNr ?? ""}`,
      shortName: line.name ?? line.fahrtNr ?? "",
      longName: line.productName ?? line.name ?? "",
      mode,
      color: line.color?.bg?.replace(/^#/, "") ?? undefined,
    },
    headsign: d.direction ?? "",
    scheduledAt,
    expectedAt,
    delaySeconds,
    platform: d.plannedPlatform ?? d.platform ?? undefined,
    canceled: d.cancelled ?? false,
    occupancy: mapFptfLoadFactor(d.loadFactor),
    remarks: normalizeRemarks(d.remarks),
  };
}
