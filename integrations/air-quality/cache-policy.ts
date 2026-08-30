import { createHash } from "node:crypto";

import type {
  AirQualityCurrentResponse,
  AirQualityForecastResponse,
  AirQualityStandardId,
} from "@openmapx/air-quality";
import type { UpstreamCacheRead, UpstreamRuntime } from "@openmapx/integration-framework";

export const CANONICAL_POINT_CACHE_TTL = {
  softMs: 5 * 60_000,
  hardMs: 15 * 60_000,
  staleIfErrorMs: 3 * 60 * 60_000,
} as const;

export type CanonicalPointResponse = AirQualityCurrentResponse | AirQualityForecastResponse;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

/** A non-reversible spatial bucket; cache keys and logs never contain raw coordinates. */
export function pointCacheCell(latitude: number, longitude: number): string {
  const y = Math.floor((latitude + 90) * 100);
  const x = Math.floor((longitude + 180) * 100);
  return digest({ x, y }).slice(0, 22);
}

export function canonicalPointCacheKey(input: {
  mode: "current" | "forecast";
  latitude: number;
  longitude: number;
  hours?: number;
  localStandardId: AirQualityStandardId | null;
  localStandardRevision: string | null;
  comparisonStandardId: AirQualityStandardId | null;
  queryBinding: string;
  providersCandidate: readonly string[];
  providersPolicyExcluded: readonly string[];
  providerPriorities: Readonly<Record<string, number>>;
}): string {
  return `air-quality:${input.mode}:v1:${digest({
    cell: pointCacheCell(input.latitude, input.longitude),
    // A full-response cache also contains point-specific jurisdiction and
    // distance decisions. Bind those without rendering coordinates in keys;
    // provider-native cell reuse remains the provider cache's responsibility.
    point: digest({ latitude: input.latitude, longitude: input.longitude }),
    hours: input.hours ?? null,
    localStandardId: input.localStandardId,
    localStandardRevision: input.localStandardRevision,
    comparisonStandardId: input.comparisonStandardId,
    queryBinding: input.queryBinding,
    providersCandidate: [...input.providersCandidate].sort(),
    providersPolicyExcluded: [...input.providersPolicyExcluded].sort(),
    providerPriorities: Object.entries(input.providerPriorities).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  })}`;
}

export async function readCanonicalPointCache<T extends CanonicalPointResponse>(
  runtime: UpstreamRuntime | undefined,
  key: string,
): Promise<UpstreamCacheRead<T>> {
  if (!runtime) return { state: "miss" };
  try {
    return await runtime.read<T>(key);
  } catch {
    return { state: "miss", diagnostic: "store_unavailable" };
  }
}

export async function writeCanonicalPointCache<T extends CanonicalPointResponse>(
  runtime: UpstreamRuntime | undefined,
  key: string,
  value: T,
): Promise<void> {
  if (!runtime) return;
  await runtime.write(key, value, CANONICAL_POINT_CACHE_TTL).catch(() => undefined);
}
