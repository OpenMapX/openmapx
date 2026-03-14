/**
 * Shared FPTF (Friendly Public Transport Format) normalization utilities.
 *
 * Used by hafas-mgate adapter, hafas provider, and db-vendo provider to avoid
 * duplicating departure/remark normalization logic.
 */
import type { Departure, TransportMode, TripRemark } from "./types";

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

/** Resolve a single FPTF product string to a TransportMode. */
export function productToMode(product: string | undefined): TransportMode {
  if (!product) return "bus";
  return FPTF_PRODUCT_MODE[product] ?? "bus";
}

/** Derive the modes served by a stop from its FPTF products bitmask map. */
export function mapProducts(products: Record<string, boolean> | undefined): TransportMode[] {
  if (!products) return ["bus"];
  const modes: TransportMode[] = [];
  for (const [key, enabled] of Object.entries(products)) {
    if (enabled) {
      const mode = FPTF_PRODUCT_MODE[key] ?? "bus";
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
 * Normalize a raw FPTF departure object into the internal Departure type.
 *
 * @param d     Raw FPTF departure (from hafas-client or hafas-mgate)
 * @param prefix  ID prefix for this provider (e.g. "db:", "tfl:")
 */
// biome-ignore lint/suspicious/noExplicitAny: FPTF departure shape varies by provider
export function normalizeFptfDeparture(d: any, prefix: string): Departure {
  const line = d.line ?? {};
  const mode = productToMode(line.product);
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
    occupancy: d.occupancy as Departure["occupancy"],
    remarks: normalizeRemarks(d.remarks),
  };
}
