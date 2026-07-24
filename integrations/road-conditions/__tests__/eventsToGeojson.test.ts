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
});
