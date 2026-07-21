import { describe, expect, it } from "vitest";
import { resolvePoiSourceId } from "../derive";

describe("resolvePoiSourceId", () => {
  it("derives id + prefix from parts", () => {
    expect(resolvePoiSourceId({ parts: { country: "ch", operator: "sfoe" } })).toEqual({
      id: "ch-sfoe",
      stationIdPrefix: "ch-sfoe:",
    });
  });
  it("falls back to explicit id/prefix when no parts (global source)", () => {
    expect(resolvePoiSourceId({ id: "osm", stationIdPrefix: "osm:" })).toEqual({
      id: "osm",
      stationIdPrefix: "osm:",
    });
  });
});
