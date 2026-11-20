import type { CacheClient } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  type ContributingRecord,
  contributorsForField,
  type FieldContributors,
  readCapturedFieldContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type {
  OccupancyLevel,
  TransitRoute,
  TransitStop,
  TransportMode,
} from "@openmapx/mobility-core/transit";
import type { SwissTransitClient } from "./client.js";
import type { SwissDatasets } from "./datasets.js";

export const PROVIDER = "otdch";
const PREFIX = "otdch:";

/** A route stop keeps its place in the list even when it cannot be placed on the map. */
export type SwissRouteStop = Omit<TransitStop, "lat" | "lng"> & {
  lat?: number;
  lng?: number;
  sequence: number;
};

export interface SwissObservedRouteEntry {
  expiresAt: number;
  hintStopIds: string[];
  operatorRefs: string[];
  route: TransitRoute;
  stops?: SwissRouteStop[];
  tripIds: string[];
}

export interface SwissProviderState {
  observedRoutes: Map<string, SwissObservedRouteEntry>;
  epoch: number;
  available: boolean;
  disposed: boolean;
}
export interface SwissProviderRuntime {
  cache?: CacheClient;
  writer?: Pick<CacheClient, "set">;
  cacheIdentity: string;
  client: SwissTransitClient;
  datasets: SwissDatasets;
  contributors: Readonly<Record<string, readonly Attribution[]>>;
  state: SwissProviderState;
  epoch: number;
}

export function providerId(raw: string): string {
  return `${PREFIX}${raw}`;
}

export function stripProviderPrefix(id: string): string {
  if (id.startsWith(PREFIX)) return id.slice(PREFIX.length);
  return id;
}

export function normalizeText(value: string | undefined): string {
  return String(value ?? "").trim();
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function normalizeSwissLookupKey(value: string | undefined): string | null {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized || null;
}

export function extractSwissOrganisationNumber(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (/^\d+$/.test(normalized)) return normalized;
  const exact = normalized.match(/^85:(\d+)(?::\d+)?$/);
  if (exact?.[1]) return exact[1];
  return undefined;
}

export function normalizeSwissOperatingDate(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  if (/^\d{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  return undefined;
}

export function uniqueModes(values: Array<TransportMode | null | undefined>): TransportMode[] {
  const set = new Set<TransportMode>();
  for (const value of values) {
    if (value) set.add(value);
  }
  return [...set];
}

export function mapSwissMode(raw: string | undefined): TransportMode | null {
  switch (String(raw ?? "").toLowerCase()) {
    case "rail":
    case "train":
      return "rail";
    case "bus":
      return "bus";
    case "tram":
      return "tram";
    case "metro":
    case "subway":
    case "underground":
      return "subway";
    case "water":
    case "waterborne":
    case "ferry":
    case "ship":
      return "ferry";
    case "funicular":
      return "funicular";
    case "gondola":
      return "gondola";
    case "cableway":
    case "cablecar":
    case "cable_car":
      return "cable_car";
    case "monorail":
      return "monorail";
    case "foot":
    case "walk":
    case "walking":
      return "walking";
    default:
      return null;
  }
}

export function mapSwissOccupancy(raw: string | undefined): OccupancyLevel | undefined {
  const value = normalizeText(raw).toLowerCase();
  if (!value) return undefined;
  if (["manyseatsavailable", "seatsavailable", "low", "lowoccupancy", "1", "2"].includes(value)) {
    return "low";
  }
  if (["standingavailable", "limitedstanding", "medium", "mediumoccupancy", "3"].includes(value)) {
    return "medium";
  }
  if (["fewseatsavailable", "standingroomonly", "high", "highoccupancy", "4"].includes(value)) {
    return "high";
  }
  if (["full", "crushedstanding", "overcrowded", "veryhighoccupancy", "5"].includes(value)) {
    return "overcrowded";
  }
  return undefined;
}

export function computeDelaySeconds(
  scheduled: string | undefined,
  expected: string | undefined,
): number | undefined {
  if (!scheduled || !expected) return undefined;
  const delta = Math.round((new Date(expected).getTime() - new Date(scheduled).getTime()) / 1000);
  return Number.isFinite(delta) && delta !== 0 ? delta : undefined;
}

/** Snapshot retained field owners before adding an independently acquired value. */
export function retainedFieldContributors(
  record: ContributingRecord & { fieldContributors?: FieldContributors },
): Record<string, readonly Attribution[]> {
  if (record.fieldContributors !== undefined)
    return { ...readCapturedFieldContributors(record.fieldContributors) };
  return Object.fromEntries(
    Object.keys(record)
      .filter((field) => field !== "contributors" && field !== "fieldContributors")
      .map((field) => [field, contributorsForField(record, field)]),
  );
}

export function nestedFieldContributors(
  record: ContributingRecord & { fieldContributors?: FieldContributors },
  field: string,
): Record<string, readonly Attribution[]> {
  return {
    [field]: snapshotContributors(record.contributors ?? []),
    ...Object.fromEntries(
      Object.entries(retainedFieldContributors(record)).map(([key, receipts]) => [
        `${field}.${key}`,
        snapshotContributors(receipts),
      ]),
    ),
  };
}

export function swissContributors(
  runtime: SwissProviderRuntime,
  ...sourceIds: string[]
): Attribution[] {
  return snapshotContributors(
    ...sourceIds.map((id) => runtime.contributors[`opentransportdata-ch-${id}`] ?? []),
  );
}
