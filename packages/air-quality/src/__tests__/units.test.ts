import { describe, expect, it } from "vitest";
import { convertConcentration, normalizeSample } from "../normalize/units";

const sample = {
  startAt: "2026-08-30T00:00:00.000Z",
  endAt: "2026-08-30T01:00:00.000Z",
  value: 0.012,
  unit: "mg/m3" as const,
  valid: true,
  estimated: false,
  gapFilled: false,
};

describe("concentration normalization", () => {
  it("converts only within a dimension", () => {
    expect(convertConcentration(0.012, "mg/m3", "ug/m3")).toBe(12);
    expect(convertConcentration(0.012, "ppm", "ppb")).toBe(12);
    expect(convertConcentration(12, "ug/m3", "ppb")).toBeNull();
    expect(convertConcentration(12, "ppb", "ug/m3")).toBeNull();
  });

  it("preserves original values and makes unsupported conversions traceable", () => {
    expect(normalizeSample(sample, "ug/m3")).toMatchObject({
      value: 12,
      unit: "ug/m3",
      originalValue: 0.012,
      originalUnit: "mg/m3",
      valid: true,
      invalidReason: null,
    });
    expect(normalizeSample(sample, "ppb")).toMatchObject({
      value: 0.012,
      unit: "mg/m3",
      valid: false,
      invalidReason: "unsupported_unit",
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1])("rejects invalid value %s", (value) => {
    expect(normalizeSample({ ...sample, value }, "ug/m3").valid).toBe(false);
  });
});
