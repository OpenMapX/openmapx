import { describe, expect, it } from "vitest";
import {
  CONTEXT_ZONE_CLASSES,
  CONTEXT_ZONE_STYLES,
  contextColorExpression,
  contextFillOpacityExpression,
  contextLineWidthExpression,
  contextSortKeyExpression,
  contextZoneClassesIn,
} from "./dataSourceContextStyle";

function matchArms(expression: unknown): Map<string, unknown> {
  const [, , ...rest] = expression as unknown[];
  const arms = new Map<string, unknown>();
  for (let i = 0; i + 1 < rest.length; i += 2) arms.set(rest[i] as string, rest[i + 1]);
  return arms;
}

describe("data-source context styles", () => {
  it("colors every zone class on the map with its legend color", () => {
    for (const dark of [false, true]) {
      const arms = matchArms(contextColorExpression(dark));
      for (const zoneClass of CONTEXT_ZONE_CLASSES) {
        const style = CONTEXT_ZONE_STYLES[zoneClass];
        expect(arms.get(zoneClass)).toBe(dark ? style.dark : style.light);
      }
    }
  });

  it("gives every zone class its own color in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const colors = CONTEXT_ZONE_CLASSES.map((zoneClass) =>
        CONTEXT_ZONE_STYLES[zoneClass][theme].toLowerCase(),
      );
      expect(new Set(colors).size).toBe(colors.length);
    }
  });

  it("draws fill opacity and line width from the shared styles", () => {
    const opacity = matchArms(contextFillOpacityExpression);
    const width = matchArms(contextLineWidthExpression);
    for (const zoneClass of CONTEXT_ZONE_CLASSES) {
      expect(opacity.get(zoneClass)).toBe(CONTEXT_ZONE_STYLES[zoneClass].fillOpacity);
      expect(width.get(zoneClass)).toBe(CONTEXT_ZONE_STYLES[zoneClass].lineWidth);
    }
    expect(CONTEXT_ZONE_STYLES.station_area.fillOpacity).toBeLessThan(
      CONTEXT_ZONE_STYLES.no_ride.fillOpacity,
    );
  });

  it("orders overlapping zones by z", () => {
    expect(contextSortKeyExpression).toEqual(["coalesce", ["get", "z"], 0]);
  });

  it("lists only the known zone classes present, in legend order", () => {
    expect(
      contextZoneClassesIn([
        { properties: { zoneClass: "station_area" } },
        { properties: { zoneClass: "no_ride" } },
        { properties: { zoneClass: "no_ride" } },
        { properties: { zoneClass: "unknown_kind" } },
        { properties: null },
        {},
      ]),
    ).toEqual(["no_ride", "station_area"]);
  });
});
