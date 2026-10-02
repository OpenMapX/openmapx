import { roadConditionFeatureToEvent } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { eventsToFeatureCollection } from "../eventsToGeojson";
import { effect, situation, text } from "./fixtures";

describe("eventsToFeatureCollection", () => {
  it("moves the geometry out and keeps every other field as a property", () => {
    const event = situation({ groupId: "SITUATION_1" });
    const [feature] = eventsToFeatureCollection([event]).features;
    expect(feature).toMatchObject({ type: "Feature", id: event.id, geometry: event.geometry });
    expect(feature?.properties).not.toHaveProperty("geometry");
    expect(feature?.properties).toMatchObject({ id: event.id, groupId: "SITUATION_1" });
  });

  it("leaves absent optional fields absent rather than null", () => {
    const [feature] = eventsToFeatureCollection([situation()]).features;
    for (const key of ["groupId", "subtype", "description", "roads", "evidence", "expiresAt"]) {
      expect(feature?.properties).not.toHaveProperty(key);
    }
  });

  it("round-trips through the client's reader unchanged, effects, validity and all", () => {
    const event = situation({
      kind: "roadworks",
      type: "works",
      subtype: "resurfacing",
      severity: { label: "moderate", level: 3 },
      temporality: "scheduled",
      planned: true,
      headline: [
        { lang: "nl", text: "Werkzaamheden" },
        { lang: "en", text: "Roadworks" },
      ],
      description: text("Lane closed overnight"),
      roads: [{ ref: "A1", name: text("Rijksweg 1"), class: "motorway" }],
      direction: { value: "positive", compass: "E" },
      validity: {
        status: "planned",
        start: "2026-10-05T20:00:00Z",
        end: "2026-10-09T05:00:00Z",
        periods: [{ startTime: "22:00", duration: "PT7H", scheduleTimezone: "Europe/Amsterdam" }],
      },
      effects: [
        effect("r1/lanes", "lane_restriction", {
          lanesClosed: 1,
          lanesTotal: 3,
          vehicleImpact: "lane_closed",
        }),
        effect("r1/speed", "speed_limit", { limit: { value: 70, unit: "km/h" } }),
        effect("r1/height", "dimension_limit", {
          applicability: { kind: "classes", include: [{ class: "truck" }] },
          dimension: "height",
          value: { value: 4, unit: "m" },
          operator: "lte",
          meaning: "maximum_permitted",
        }),
      ],
      origin: "crowd",
      evidence: { state: "corroborated", confidenceScore: 0.7, routingEligible: false },
      updatedAt: "2026-09-30T08:00:00Z",
      expiresAt: "2026-09-30T08:10:00Z",
    });
    const fc = JSON.parse(JSON.stringify(eventsToFeatureCollection([event])));
    expect(roadConditionFeatureToEvent(fc.features[0])).toEqual(event);
  });
});
