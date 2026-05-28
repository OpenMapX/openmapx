import { isI18nToken } from "@openmapx/integration-framework/strings";
import type { FuelStation } from "@openmapx/mobility-core/fuel";
import { describe, expect, it } from "vitest";
import { mapFuelStationToDetail, mapFuelStationToResult } from "../mapper.js";

function makeStation(overrides: Partial<FuelStation> = {}): FuelStation {
  return {
    id: "tankerkoenig/abc-123",
    name: "Test Station",
    coordinates: [11.5, 48.5],
    fuelPrices: { diesel: 1.559, e5: 1.699, e10: 1.639 },
    ...overrides,
  };
}

describe("fuel mapper", () => {
  it("emits I18nToken for section titles, columns, and row labels", () => {
    const detail = mapFuelStationToDetail(makeStation());
    for (const section of detail.sections) {
      expect(
        isI18nToken(section.title),
        `section.title should be I18nToken, got: ${JSON.stringify(section.title)}`,
      ).toBe(true);
      if (section.columns) {
        for (const col of section.columns) {
          expect(isI18nToken(col), `column should be I18nToken, got: ${JSON.stringify(col)}`).toBe(
            true,
          );
        }
      }
      if (section.rows) {
        for (const [label] of section.rows) {
          expect(
            isI18nToken(label),
            `row label should be I18nToken, got: ${JSON.stringify(label)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("emits I18nToken for summary on result cards", () => {
    const result = mapFuelStationToResult(makeStation());
    expect(isI18nToken(result.summary)).toBe(true);
  });

  it("uses the fuel-prices section token title", () => {
    const detail = mapFuelStationToDetail(makeStation());
    const priceSection = detail.sections.find((s) => s.sectionIcon === "fuel");
    expect(priceSection?.title).toEqual({ $t: "section.fuelPrices" });
    expect(priceSection?.columns).toEqual([{ $t: "column.fuelType" }, { $t: "column.priceEur" }]);
  });

  it("emits fuel-row tokens keyed by fuel type", () => {
    const detail = mapFuelStationToDetail(
      makeStation({ fuelPrices: { diesel: 1.5, e5: 1.7, sp98: 1.9, lpg: 0.8 } }),
    );
    const priceSection = detail.sections.find((s) => s.sectionIcon === "fuel");
    const labels = (priceSection?.rows ?? []).map((r) => r[0]);
    expect(labels).toEqual([
      { $t: "fuel.diesel" },
      { $t: "fuel.e5" },
      { $t: "fuel.sp98" },
      { $t: "fuel.lpg" },
    ]);
  });

  it("omits the prices section entirely when no prices are present", () => {
    const detail = mapFuelStationToDetail(makeStation({ fuelPrices: {} }));
    expect(detail.sections).toHaveLength(0);
  });

  it("returns undefined summary when no prices are present", () => {
    const result = mapFuelStationToResult(makeStation({ fuelPrices: {} }));
    expect(result.summary).toBeUndefined();
  });
});
