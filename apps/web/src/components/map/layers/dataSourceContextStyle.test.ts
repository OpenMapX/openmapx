import { describe, expect, it } from "vitest";
import {
  contextColorExpression,
  contextFillOpacityExpression,
  contextLineWidthExpression,
  contextSortKeyExpression,
} from "./dataSourceContextStyle";

describe("data-source context styles", () => {
  it("covers every semantic class in light and dark themes", () => {
    for (const dark of [false, true]) {
      const expression = JSON.stringify(contextColorExpression(dark));
      for (const zoneClass of [
        "no_ride",
        "no_parking",
        "no_start",
        "slow_zone",
        "parking_hub",
        "station_area",
      ]) {
        expect(expression).toContain(zoneClass);
      }
    }
  });

  it("keeps station areas visually subtle and orders by z", () => {
    expect(JSON.stringify(contextFillOpacityExpression)).toContain("station_area");
    expect(JSON.stringify(contextLineWidthExpression)).toContain("station_area");
    expect(contextSortKeyExpression).toEqual(["coalesce", ["get", "z"], 0]);
  });
});
