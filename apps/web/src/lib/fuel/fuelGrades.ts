import { useDataSourceStore } from "@openmapx/core";
import { useMemo } from "react";

/** The id of the data source that answers fuel prices. */
export const FUEL_SOURCE_ID = "fuel";

/** The along-route stop kind whose results are fuel stations, as the category search accepts it. */
export const ROUTE_FUEL_CATEGORY = "preset:amenity/fuel";

/**
 * The grade fuel prices are compared by: the first selected grade, else
 * diesel. The fuel data source labels its stations by the same rule, so a
 * price shown here is the one its labels show.
 */
export function fuelComparisonGrade(grades: readonly string[]): string {
  return grades[0] ?? "diesel";
}

/** The grades a fuel-type filter value selects, in the order they were picked. */
export function selectedFuelGrades(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

/**
 * The grades the fuel layer's filter selects, or none while another layer (or
 * none) is shown: the filter belongs to the fuel layer and is cleared with it.
 */
export function useSelectedFuelGrades(): string[] {
  const value = useDataSourceStore((s) =>
    s.activeSource === FUEL_SOURCE_ID ? s.filters.fuelType : undefined,
  );
  const signature = JSON.stringify(selectedFuelGrades(value));
  return useMemo(() => JSON.parse(signature) as string[], [signature]);
}
