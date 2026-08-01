import { TRAFFIC_BAND_COLORS } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { BANDS } from "./legend";

describe("traffic flow legend bands", () => {
  it("uses the shared palette rather than its own hexes", () => {
    expect(BANDS.map((b) => b.color)).toEqual([
      TRAFFIC_BAND_COLORS.freeFlow,
      TRAFFIC_BAND_COLORS.light,
      TRAFFIC_BAND_COLORS.moderate,
      TRAFFIC_BAND_COLORS.heavy,
      TRAFFIC_BAND_COLORS.severe,
    ]);
  });

  it("keeps the band keys the i18n file already defines", () => {
    expect(BANDS.map((b) => b.key)).toEqual(["freeFlow", "light", "moderate", "heavy", "severe"]);
  });
});
