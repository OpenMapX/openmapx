import type { RoadConditionEvent } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { eventsToFeatureCollection } from "../eventsToGeojson";

const base: RoadConditionEvent = {
  id: "ndw:1",
  source: "ndw",
  provider: "road-conditions",
  type: "accident",
  severity: "high",
  geometry: { type: "Point", coordinates: [5, 52] },
  headline: "Accident on A1",
};

describe("eventsToFeatureCollection", () => {
  it("carries delaySeconds onto the feature properties when set", () => {
    const fc = eventsToFeatureCollection([{ ...base, delaySeconds: 1500 }]);
    expect(fc.features[0]?.properties.delaySeconds).toBe(1500);
  });

  it("emits null delaySeconds when the event carries no delay", () => {
    const fc = eventsToFeatureCollection([base]);
    expect(fc.features[0]?.properties.delaySeconds).toBeNull();
  });

  it("round-trips the planned/forecast flags, emitting null when unset", () => {
    const fc = eventsToFeatureCollection([{ ...base, isForecast: true, isPlanned: true }, base]);
    expect(fc.features[0]?.properties.isForecast).toBe(true);
    expect(fc.features[0]?.properties.isPlanned).toBe(true);
    expect(fc.features[1]?.properties.isForecast).toBeNull();
    expect(fc.features[1]?.properties.isPlanned).toBeNull();
  });

  it("serializes the optional source situation group id", () => {
    const grouped = { ...base, groupId: "SITUATION_1" };
    const fc = eventsToFeatureCollection([grouped, base]);
    expect(fc.features[0]?.properties.groupId).toBe("SITUATION_1");
    expect(fc.features[1]?.properties.groupId).toBeUndefined();
  });
});
