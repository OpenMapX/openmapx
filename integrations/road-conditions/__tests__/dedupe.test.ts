import { describe, expect, it } from "vitest";
import { dedupeRoadConditionEvents } from "../dedupe.js";
import type { RoadConditionEvent } from "../types.js";

function ev(
  over: Partial<RoadConditionEvent> & Pick<RoadConditionEvent, "id">,
): RoadConditionEvent {
  return {
    source: "s",
    provider: "p",
    type: "accident",
    severity: "high",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    headline: "Accident on A1",
    ...over,
  };
}

describe("dedupeRoadConditionEvents", () => {
  it("collapses exact-id duplicates, keeping the newest dataUpdatedAt", () => {
    const out = dedupeRoadConditionEvents([
      ev({ id: "x", dataUpdatedAt: "2026-01-01T00:00:00Z", headline: "old" }),
      ev({ id: "x", dataUpdatedAt: "2026-06-01T00:00:00Z", headline: "new" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.headline).toBe("new");
  });

  it("collapses near-identical events from different providers (newest wins, keeps its provider)", () => {
    const out = dedupeRoadConditionEvents([
      ev({
        id: "oc:1",
        provider: "road-conditions-openconditions",
        geometry: { type: "Point", coordinates: [13.4, 52.5] },
        dataUpdatedAt: "2026-06-01T00:00:00Z",
        headline: "Accident on the A1 northbound",
      }),
      ev({
        id: "tt:9",
        provider: "road-conditions-tomtom",
        geometry: { type: "Point", coordinates: [13.4004, 52.5001] }, // ~35 m away
        dataUpdatedAt: "2026-06-02T00:00:00Z",
        headline: "Accident A1 northbound",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.provider).toBe("road-conditions-tomtom");
  });

  it("keeps events that differ in type even when co-located", () => {
    const out = dedupeRoadConditionEvents([
      ev({ id: "a", type: "accident", geometry: { type: "Point", coordinates: [13.4, 52.5] } }),
      ev({ id: "b", type: "roadworks", geometry: { type: "Point", coordinates: [13.4, 52.5] } }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps same-type events that are far apart", () => {
    const out = dedupeRoadConditionEvents([
      ev({ id: "a", geometry: { type: "Point", coordinates: [13.4, 52.5] } }),
      ev({ id: "b", geometry: { type: "Point", coordinates: [9.99, 53.55] } }), // Hamburg, far
    ]);
    expect(out).toHaveLength(2);
  });

  it("returns [] for []", () => {
    expect(dedupeRoadConditionEvents([])).toEqual([]);
  });
});
