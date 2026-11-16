"use client";

import {
  type BoundingBox,
  bboxAroundPoint,
  type CategoryPlace,
  DATA_SOURCE_MATCH_METERS,
  type DataSourceResult,
  dataSourceSearchQueryOptions,
  matchDataSourceResults,
  useDataSources,
} from "@openmapx/core";
import { type QueryState, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { FUEL_SOURCE_ID, fuelComparisonGrade, useSelectedFuelGrades } from "@/lib/fuel/fuelGrades";
import { combineGatedQueries, useElementwiseStable, useRequestGate } from "./requestGate";

/** Price lookups kept in flight at once, beside the stop search's own requests. */
export const FUEL_LOOKUP_CONCURRENCY = 2;
/**
 * The side of a lookup cell, in degrees (about 2.2 km north to south). A
 * station answer is about 11 kB, so a box around a few stations stays small
 * where a 25 km search window around a city carries 2 MB; and a fixed grid
 * keeps a cell's request the same as the route ahead moves.
 */
const LOOKUP_CELL_DEG = 0.02;
/** How long a cell's prices are reused before a new search asks for them again. */
const LOOKUP_FRESH_MS = 5 * 60_000;

/** What is known about one fuel stop's price for the compared grade. */
export type RouteStopFuelPrice =
  | { status: "loading" }
  | { status: "unknown" }
  /** `result` is the data-source station; its `labelSummary` is the grade's price and age. */
  | { status: "priced"; result: DataSourceResult };

export type RouteFuelPrices = ReadonlyMap<string, RouteStopFuelPrice>;

/** One box of the lookup grid and the stops whose station it answers for. */
export interface FuelLookupCell {
  bbox: BoundingBox;
  placeIds: string[];
}

function edge(index: number): number {
  return rounded(index * LOOKUP_CELL_DEG);
}

/** Rounded so a cell's request key carries no float noise. */
function rounded(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * The grid cells holding the stops, in the order of the first stop in each.
 * Each box is its cell grown by the match distance, so it holds every
 * station a stop in the cell can be matched to.
 */
export function fuelLookupCells(places: readonly CategoryPlace[]): FuelLookupCell[] {
  const cells = new Map<string, FuelLookupCell>();
  for (const place of places) {
    const [lng, lat] = place.coordinates;
    const ix = Math.floor(lng / LOOKUP_CELL_DEG);
    const iy = Math.floor(lat / LOOKUP_CELL_DEG);
    const key = `${ix}/${iy}`;
    const held = cells.get(key);
    if (held) {
      held.placeIds.push(place.id);
      continue;
    }
    const southWest = bboxAroundPoint([edge(ix), edge(iy)], DATA_SOURCE_MATCH_METERS);
    const northEast = bboxAroundPoint([edge(ix + 1), edge(iy + 1)], DATA_SOURCE_MATCH_METERS);
    cells.set(key, {
      bbox: {
        south: rounded(southWest.south),
        west: rounded(southWest.west),
        north: rounded(northEast.north),
        east: rounded(northEast.east),
      },
      placeIds: [place.id],
    });
  }
  return [...cells.values()];
}

/** A cell answered within the last few minutes; an older one is asked again. */
function isFresh(state: QueryState | undefined, now: number): boolean {
  return (
    state?.status === "success" &&
    !state.isInvalidated &&
    now - state.dataUpdatedAt < LOOKUP_FRESH_MS
  );
}

/**
 * Prices of the compared grade for along-route fuel stops, from the fuel data
 * source, by stop id; null when not enabled or no fuel source is offered.
 *
 * Stops are looked up by grid cell, at most {@link FUEL_LOOKUP_CONCURRENCY}
 * cells at a time, in the order the stops are listed. A cell asked for once
 * in this view is not asked again on focus, reconnect or re-render; a view
 * opened later asks again for cells older than a few minutes, through the
 * same slots. The stop list never waits for prices: a stop is `loading` until
 * its cell answers, then `priced` or `unknown` (no matching station, no price
 * for the grade, or the lookup failed).
 *
 * `unknown` is reported only once some station in this search's answers
 * carries a price for any grade, so a source without price data here does
 * not mark every stop. Until then a stop without a price has no entry in the
 * map, which callers render like `loading`: with no marker.
 */
export function useRouteFuelPrices(
  places: readonly CategoryPlace[],
  enabled: boolean,
): RouteFuelPrices | null {
  const sources = useDataSources({ enabled });
  const offered = sources.data?.sources.some((source) => source.id === FUEL_SOURCE_ID) ?? false;
  const active = enabled && offered;
  const grades = useSelectedFuelGrades();
  const grade = fuelComparisonGrade(grades);
  const filters = useMemo(
    () => (grades.length > 0 ? { fuelType: grades } : {}) as Record<string, unknown>,
    [grades],
  );
  const cells = useMemo(() => (active ? fuelLookupCells(places) : []), [active, places]);

  // A cell with a fresh cached answer joins at once; the others, including
  // stale ones, take a slot. A slot's cell is fetched when it joins: on mount
  // (hence the default refetch on mount) or when it is enabled.
  const base = cells.map((cell) =>
    dataSourceSearchQueryOptions(FUEL_SOURCE_ID, cell.bbox, filters),
  );
  const enabledCells = useRequestGate(
    base.map((options) => options.queryKey),
    { active, concurrency: FUEL_LOOKUP_CONCURRENCY, ready: isFresh },
  );
  const queries = base.map((options, index) => ({
    ...options,
    enabled: enabledCells[index],
    staleTime: LOOKUP_FRESH_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  }));
  const answers = useQueries({ queries, combine: combineGatedQueries });
  const data = useElementwiseStable(answers.data);
  const statuses = answers.statuses.join();
  const fetching = answers.fetchStatuses.join();

  return useMemo(() => {
    if (!enabled) return null;
    if (!sources.data) return sources.isError ? null : loadingAll(places);
    if (!offered) return null;
    const cellOf = new Map<string, number>();
    for (const [index, cell] of cells.entries()) {
      for (const id of cell.placeIds) cellOf.set(id, index);
    }
    const stations = new Map<string, DataSourceResult>();
    for (const answer of data) {
      for (const station of answer?.data ?? []) {
        if (!stations.has(station.id)) stations.set(station.id, station);
      }
    }
    const answered = places.filter((place) => {
      const index = cellOf.get(place.id);
      return index !== undefined && data[index] !== undefined;
    });
    const matches = matchDataSourceResults(
      answered.map((place) => ({
        id: place.id,
        coordinates: place.coordinates,
        brand: place.brand?.name,
      })),
      [...stations.values()],
    );
    const priceData = [...stations.values()].some(hasAnyPrice);
    const statusList = statuses.split(",");
    const fetchList = fetching.split(",");
    const prices = new Map<string, RouteStopFuelPrice>();
    for (const place of places) {
      const index = cellOf.get(place.id);
      if (index === undefined) continue;
      if (data[index] !== undefined) {
        const station = matches.get(place.id);
        if (station?.labelSummary && station.sortValues?.[grade] !== undefined) {
          prices.set(place.id, { status: "priced", result: station });
        } else if (priceData) {
          prices.set(place.id, { status: "unknown" });
        }
      } else if (statusList[index] === "error" && fetchList[index] !== "fetching") {
        if (priceData) prices.set(place.id, { status: "unknown" });
      } else {
        prices.set(place.id, { status: "loading" });
      }
    }
    return prices;
  }, [
    enabled,
    sources.data,
    sources.isError,
    offered,
    cells,
    data,
    places,
    grade,
    statuses,
    fetching,
  ]);
}

/** Whether a station carries a price for any grade: `currency` is set only beside a priced summary. */
function hasAnyPrice(station: DataSourceResult): boolean {
  return station.currency !== undefined || Object.keys(station.sortValues ?? {}).length > 0;
}

function loadingAll(places: readonly CategoryPlace[]): RouteFuelPrices {
  return new Map(places.map((place) => [place.id, { status: "loading" } as const]));
}
