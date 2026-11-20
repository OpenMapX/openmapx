import { describe, expect, it } from "vitest";
import { pickDataSourceContextAction } from "./dataSourceContextInteraction";

describe("pickDataSourceContextAction", () => {
  it("does nothing without a zone", () => {
    expect(pickDataSourceContextAction(undefined)).toEqual({ type: "none" });
  });

  it("selects resolvable station areas", () => {
    expect(
      pickDataSourceContextAction({
        contextKind: "station_area",
        stationId: "s:central",
      }),
    ).toEqual({ type: "select-station", stationId: "s:central" });
  });

  it("opens semantic restrictions for inspection", () => {
    const properties = { contextKind: "restriction_zone", zoneClass: "no_parking" };
    expect(pickDataSourceContextAction(properties)).toEqual({ type: "inspect", properties });
  });
});
