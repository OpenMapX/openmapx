import { describe, expect, it } from "vitest";
import { getRegionalBenchmark, REGIONAL_BENCHMARKS } from "./benchmarks";

describe("regional impact benchmarks", () => {
  it("resolves explicit country and currency fallbacks", () => {
    expect(getRegionalBenchmark("DE")).toBe(REGIONAL_BENCHMARKS.DE);
    expect(getRegionalBenchmark("uk")).toBe(REGIONAL_BENCHMARKS.GB);
    expect(getRegionalBenchmark(undefined, "USD")).toBe(REGIONAL_BENCHMARKS.US);
    expect(getRegionalBenchmark(undefined, "CHF")).toBe(REGIONAL_BENCHMARKS.CH);
  });

  it("uses the EU benchmark for Eurozone countries without a dedicated record", () => {
    expect(getRegionalBenchmark("ES")).toBe(REGIONAL_BENCHMARKS.EU);
    expect(getRegionalBenchmark("NL")).toBe(REGIONAL_BENCHMARKS.EU);
  });

  it("keeps price and grid sources separate and machine-readable", () => {
    const germany = getRegionalBenchmark("DE");

    expect(germany.petrolPricePerLiter.value).toBeGreaterThan(0);
    expect(germany.petrolPricePerLiter.source.citation).toContain("Oil Bulletin");
    expect(germany.electricityPricePerKwh.source.citation).toContain("Eurostat");
    expect(germany.gridCarbonIntensityGramsPerKwh.source.citation).toContain("EEA");
    expect(germany.gridCarbonIntensityGramsPerKwh.source.effectiveAt).toBe("2024");
    expect(germany.gridCarbonIntensityGramsPerKwh.source.scope).toContain("generation");
    expect(germany.petrolPricePerLiter.source.url).toMatch(/^https:\/\//);
  });

  it("falls back globally only when neither geography nor currency is recognized", () => {
    expect(getRegionalBenchmark("ZZ", "XYZ")).toBe(REGIONAL_BENCHMARKS.GLOBAL);
    expect(getRegionalBenchmark("JP", "CHF")).toBe(REGIONAL_BENCHMARKS.GLOBAL);
    expect(getRegionalBenchmark()).toBe(REGIONAL_BENCHMARKS.GLOBAL);
  });
});
