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

  it("carries both restriction fields, and neither when the event makes no claim", () => {
    const details = {
      schemaVersion: 1,
      vehicleScope: "specific",
      completeness: "complete",
      issues: [],
      source: {
        sourceId: "fi-digitraffic",
        recordId: "GUID50465935",
        recordVersion: "31",
        sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
        feedUrls: ["https://tie.digitraffic.fi/api/traffic-message/v2/roadworks"],
        publisher: "Fintraffic / Digitraffic",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "Fintraffic / Digitraffic",
        modificationNotice: "Normalized by OpenConditions",
      },
      facts: [],
      evaluatedAt: "2026-09-12T07:14:00.000Z",
      sourceCheckedAt: "2026-09-12T07:13:00.000Z",
      freshUntil: "2026-09-12T07:23:00.000Z",
      nextTransitionAt: null,
      isStale: false,
    } as unknown as NonNullable<RoadConditionEvent["restrictionDetails"]>;

    const fc = eventsToFeatureCollection([
      { ...base, id: "fi:1", restrictionDetails: details, subtype: "road construction" },
      { ...base, id: "fi:2", restrictionDetailsUnsupported: true },
      base,
    ]);
    expect(fc.features[0]?.properties.restrictionDetails).toEqual(details);
    expect(fc.features[0]?.properties.subtype).toBe("road construction");
    expect(fc.features[1]?.properties.restrictionDetailsUnsupported).toBe(true);
    expect(fc.features[1]?.properties).not.toHaveProperty("restrictionDetails");
    expect(fc.features[2]?.properties).not.toHaveProperty("restrictionDetails");
    expect(fc.features[2]?.properties).not.toHaveProperty("restrictionDetailsUnsupported");
  });
});
