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
    expect(out[0].headline).toBe("new");
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
    expect(out[0].provider).toBe("road-conditions-tomtom");
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

  it("merges a Point against a LineString for the same incident (first-vertices far apart)", () => {
    // The point sits ~33 m off the MIDDLE of the line; the line's first vertex is
    // ~340 m away, so first-vertex proximity would miss it — segment distance won't.
    const out = dedupeRoadConditionEvents([
      ev({
        id: "oc:1",
        provider: "road-conditions-openconditions",
        geometry: {
          type: "LineString",
          coordinates: [
            [13.4, 52.5],
            [13.41, 52.5],
          ],
        },
        dataUpdatedAt: "2026-06-01T00:00:00Z",
        headline: "Accident on the A1",
      }),
      ev({
        id: "tt:9",
        provider: "road-conditions-tomtom",
        geometry: { type: "Point", coordinates: [13.405, 52.5003] },
        dataUpdatedAt: "2026-06-02T00:00:00Z",
        headline: "Accident A1",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe("road-conditions-tomtom");
  });

  it("merges two sparsely-digitised overlapping lines (no shared/near vertices)", () => {
    // B overlaps A's eastern half offset ~22 m north; their vertices are >600 m
    // apart, so only vertex-to-SEGMENT distance catches the overlap.
    const out = dedupeRoadConditionEvents([
      ev({
        id: "a",
        type: "roadworks",
        headline: "Roadworks on the A2",
        geometry: {
          type: "LineString",
          coordinates: [
            [13.4, 52.5],
            [13.42, 52.5],
          ],
        },
      }),
      ev({
        id: "b",
        type: "roadworks",
        headline: "Roadworks A2",
        geometry: {
          type: "LineString",
          coordinates: [
            [13.41, 52.5002],
            [13.43, 52.5002],
          ],
        },
      }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps two same-type lines that are far apart", () => {
    const out = dedupeRoadConditionEvents([
      ev({
        id: "a",
        type: "roadworks",
        geometry: {
          type: "LineString",
          coordinates: [
            [13.4, 52.5],
            [13.41, 52.5],
          ],
        },
      }),
      ev({
        id: "b",
        type: "roadworks",
        geometry: {
          type: "LineString",
          coordinates: [
            [13.5, 52.5],
            [13.51, 52.5],
          ],
        },
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("returns [] for []", () => {
    expect(dedupeRoadConditionEvents([])).toEqual([]);
  });

  describe("road-name guard", () => {
    it("does NOT merge co-located same-type events on different named roads", () => {
      // ~7 m apart, identical generic headline (jaccard 1.0) — would merge on
      // geometry alone — but they name different roads (an interchange).
      const out = dedupeRoadConditionEvents([
        ev({
          id: "a",
          type: "roadworks",
          headline: "Roadworks",
          roads: [{ name: "A3" }],
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
        }),
        ev({
          id: "b",
          type: "roadworks",
          headline: "Roadworks",
          roads: [{ name: "A44" }],
          geometry: { type: "Point", coordinates: [13.4001, 52.5] },
        }),
      ]);
      expect(out).toHaveLength(2);
    });

    it("still merges co-located same-type events that share a road name", () => {
      const out = dedupeRoadConditionEvents([
        ev({
          id: "a",
          type: "roadworks",
          headline: "Roadworks",
          roads: [{ name: "A3" }],
          dataUpdatedAt: "2026-06-01T00:00:00Z",
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
        }),
        ev({
          id: "b",
          type: "roadworks",
          headline: "Roadworks",
          roads: [{ name: "A3", direction: "north" }],
          dataUpdatedAt: "2026-06-02T00:00:00Z",
          geometry: { type: "Point", coordinates: [13.4001, 52.5] },
        }),
      ]);
      expect(out).toHaveLength(1);
    });

    it("still merges when one or both events carry no road ref (NDW fallback)", () => {
      const out = dedupeRoadConditionEvents([
        ev({
          id: "a",
          type: "lane_closure",
          headline: "Lane closure",
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
        }),
        ev({
          id: "b",
          type: "lane_closure",
          headline: "Lane closure",
          roads: [{ name: "A3" }],
          geometry: { type: "Point", coordinates: [13.4001, 52.5] },
        }),
      ]);
      expect(out).toHaveLength(1);
    });
  });
});
