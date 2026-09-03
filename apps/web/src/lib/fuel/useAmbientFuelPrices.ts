import {
  bboxAroundPoint,
  type DataSourceResult,
  type LngLat,
  type ProvenanceMeta,
  useDataSourceSearch,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import { useMemo } from "react";

const SAMPLE_RADIUS_METERS = 10_000;
const PRICE_FILTERS = { pricesOnly: true } as const;
const PETROL_GRADES = ["e10", "e5", "sp98"] as const;

export type AmbientFuelGrade = "diesel" | (typeof PETROL_GRADES)[number];

export interface AmbientFuelQuote {
  fuelGrade: AmbientFuelGrade;
  pricePerLiter: number;
  currency: string;
  sampleCount: number;
  provenance: ProvenanceMeta;
}

export interface AmbientFuelPrices {
  petrol: AmbientFuelQuote | null;
  diesel: AmbientFuelQuote | null;
}

export interface UseAmbientFuelPricesResult {
  prices: AmbientFuelPrices | null;
  isLoading: boolean;
}

function isValidPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function calculateMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Number(median.toFixed(4));
}

function quoteTimestamp(results: DataSourceResult[], freshness: Freshness | undefined): string {
  if (freshness?.dataAsOf) return freshness.dataAsOf;
  const observed = results
    .map((result) => result.observedAt)
    .filter(
      (value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)),
    )
    .sort();
  // The median depends on every included sample. The oldest observation is
  // the conservative freshness timestamp for the aggregate.
  return observed[0] ?? freshness?.fetchedAt ?? new Date(0).toISOString();
}

function quoteSource(
  results: DataSourceResult[],
  attributions: Attribution[],
): { citation: string; sourceUrl?: string } {
  const sourceIds = new Set(results.map((result) => result.source));
  const names = attributions
    .filter((attribution) => sourceIds.has(attribution.sourceId))
    .map((attribution) => attribution.name);
  return {
    citation: [...new Set(names.length > 0 ? names : [...sourceIds])].join(", "),
    sourceUrl: attributions.find((attribution) => sourceIds.has(attribution.sourceId))?.url,
  };
}

function quoteForGrade(
  results: DataSourceResult[],
  grade: AmbientFuelGrade,
  attributions: Attribution[],
  freshness: Freshness | undefined,
): AmbientFuelQuote | null {
  const samples = results.filter((result) => isValidPrice(result.sortValues?.[grade]));
  const price = calculateMedian(samples.map((result) => result.sortValues?.[grade] as number));
  if (price === null) return null;

  const currencies = new Set(samples.map((result) => result.currency).filter(Boolean));
  if (currencies.size !== 1) return null;
  const currency = [...currencies][0] as string;
  const source = quoteSource(samples, attributions);
  const calculatedAt = new Date().toISOString();

  return {
    fuelGrade: grade,
    pricePerLiter: price,
    currency,
    sampleCount: samples.length,
    provenance: {
      kind: "provider",
      timestamp: quoteTimestamp(samples, freshness),
      calculatedAt,
      citation: source.citation,
      ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
      assumptions: [
        {
          kind: "fuel_price_sample",
          radiusMeters: SAMPLE_RADIUS_METERS,
          stationCount: samples.length,
        },
      ],
    },
  };
}

export function useAmbientFuelPrices(
  center: LngLat | null,
  enabled = true,
): UseAmbientFuelPricesResult {
  const bbox = useMemo(
    () => (enabled && center ? bboxAroundPoint(center, SAMPLE_RADIUS_METERS) : null),
    [center, enabled],
  );
  const { data, attributions, freshness, isLoading, isError } = useDataSourceSearch(
    bbox ? "fuel" : null,
    bbox,
    PRICE_FILTERS,
  );

  const prices = useMemo<AmbientFuelPrices | null>(() => {
    if (!bbox || isError || !data?.length) return null;
    const petrol =
      PETROL_GRADES.map((grade) => quoteForGrade(data, grade, attributions, freshness)).find(
        (quote) => quote !== null,
      ) ?? null;
    const diesel = quoteForGrade(data, "diesel", attributions, freshness);
    return petrol || diesel ? { petrol, diesel } : null;
  }, [attributions, bbox, data, freshness, isError]);

  return {
    prices,
    isLoading: bbox !== null && Boolean(isLoading),
  };
}
