import { describe, expect, it } from "vitest";
import { pickDataSourceContextAction } from "./dataSourceContextInteraction";

describe("pickDataSourceContextAction", () => {
  it("lets an overlapping marker win", () => {
    expect(
      pickDataSourceContextAction(1, {
        contextKind: "restriction_zone",
        contextId: "zone:one",
      }),
    ).toEqual({ type: "none" });
  });

  it("selects resolvable station areas", () => {
    expect(
      pickDataSourceContextAction(0, {
        contextKind: "station_area",
        stationId: "s:central",
      }),
    ).toEqual({ type: "select-station", stationId: "s:central" });
  });

  it("opens semantic restrictions for inspection", () => {
    const properties = { contextKind: "restriction_zone", zoneClass: "no_parking" };
    expect(pickDataSourceContextAction(0, properties)).toEqual({ type: "inspect", properties });
  });
});
