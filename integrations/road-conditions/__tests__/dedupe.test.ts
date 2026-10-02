import { describe, expect, it } from "vitest";
import { dedupeRoadConditionEvents } from "../dedupe.js";
import type { RoadConditionEvent } from "../types.js";
import { effect, situation, text } from "./fixtures.js";

function ev(
  over: Partial<RoadConditionEvent> & Pick<RoadConditionEvent, "id">,
): RoadConditionEvent {
  return situation({
    source: "s",
    provider: "p",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    ...over,
  });
}

const works = { kind: "roadworks", type: "works" } as const;

describe("dedupeRoadConditionEvents", () => {
  it("collapses exact-id duplicates, keeping the newest updatedAt", () => {
    const out = dedupeRoadConditionEvents([
      ev({ id: "x", updatedAt: "2026-01-01T00:00:00Z", headline: text("old") }),
      ev({ id: "x", updatedAt: "2026-06-01T00:00:00Z", headline: text("new") }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.headline).toEqual(text("new"));
  });

  it("collapses near-identical situations from different providers (newest wins whole)", () => {
    const older = ev({
      id: "oc:1",
      provider: "road-conditions-openconditions",
      source: "nl-ndw",
      attribution: { provider: "NDW", license: "CC0-1.0" },
      updatedAt: "2026-06-01T00:00:00Z",
      headline: text("Accident on the A1 northbound"),
    });
    const newer = ev({
      id: "tt:9",
      provider: "road-conditions-tomtom",
      source: "tomtom",
      attribution: { provider: "TomTom" },
      geometry: { type: "Point", coordinates: [13.4004, 52.5001] }, // ~35 m away
      updatedAt: "2026-06-02T00:00:00Z",
      headline: text("Accident A1 northbound"),
    });
    expect(dedupeRoadConditionEvents([older, newer])).toEqual([newer]);
    expect(dedupeRoadConditionEvents([newer, older])).toEqual([newer]);
  });

  it("matches headlines in a shared language when the publishers' own differ", () => {
    const out = dedupeRoadConditionEvents([
      ev({
        id: "a",
        headline: [
          { lang: "nl", text: "Ongeval op de A1" },
          { lang: "en", text: "Accident on the A1" },
        ],
      }),
      ev({ id: "b", headline: text("Accident A1") }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps situations that differ in classification even when co-located", () => {
    const out = dedupeRoadConditionEvents([ev({ id: "a" }), ev({ id: "b", ...works })]);
    expect(out).toHaveLength(2);
  });

  it("keeps same-type situations that are far apart", () => {
    const out = dedupeRoadConditionEvents([
      ev({ id: "a" }),
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
        updatedAt: "2026-06-01T00:00:00Z",
        headline: text("Accident on the A1"),
      }),
      ev({
        id: "tt:9",
        provider: "road-conditions-tomtom",
        geometry: { type: "Point", coordinates: [13.405, 52.5003] },
        updatedAt: "2026-06-02T00:00:00Z",
        headline: text("Accident A1"),
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.provider).toBe("road-conditions-tomtom");
  });

  it("merges two sparsely-digitised overlapping lines (no shared/near vertices)", () => {
    // B overlaps A's eastern half offset ~22 m north; their vertices are >600 m
    // apart, so only vertex-to-SEGMENT distance catches the overlap.
    const out = dedupeRoadConditionEvents([
      ev({
        id: "a",
        ...works,
        headline: text("Roadworks on the A2"),
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
        ...works,
        headline: text("Roadworks A2"),
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
        ...works,
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
        ...works,
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

  describe("road guard", () => {
    it("does NOT merge co-located same-type situations on different named roads", () => {
      // ~7 m apart, identical generic headline (jaccard 1.0) — would merge on
      // geometry alone — but they name different roads (an interchange).
      const out = dedupeRoadConditionEvents([
        ev({ id: "a", ...works, headline: text("Roadworks"), roads: [{ ref: "A3" }] }),
        ev({
          id: "b",
          ...works,
          headline: text("Roadworks"),
          roads: [{ name: text("A44") }],
          geometry: { type: "Point", coordinates: [13.4001, 52.5] },
        }),
      ]);
      expect(out).toHaveLength(2);
    });

    it("still merges co-located same-type situations that share a road ref or name", () => {
      const out = dedupeRoadConditionEvents([
        ev({ id: "a", ...works, headline: text("Roadworks"), roads: [{ ref: "A 3" }] }),
        ev({
          id: "b",
          ...works,
          headline: text("Roadworks"),
          roads: [{ name: [{ lang: "de", text: "A3" }] }],
          geometry: { type: "Point", coordinates: [13.4001, 52.5] },
        }),
      ]);
      expect(out).toHaveLength(1);
    });

    it("still merges when one situation carries no road (NDW fallback)", () => {
      const out = dedupeRoadConditionEvents([
        ev({ id: "a", ...works, headline: text("Roadworks") }),
        ev({
          id: "b",
          ...works,
          headline: text("Roadworks"),
          roads: [{ ref: "A3" }],
          geometry: { type: "Point", coordinates: [13.4001, 52.5] },
        }),
      ]);
      expect(out).toHaveLength(1);
    });
  });

  describe("semantic guard", () => {
    const closure = { kind: "closure", type: "closure", headline: text("Closed road A1") };

    it("merges copies whose effects differ only in ids and source references", () => {
      const out = dedupeRoadConditionEvents([
        ev({ id: "a", ...closure, effects: [effect("a/1", "closure", { sourceRecordRef: "x" })] }),
        ev({ id: "b", ...closure, effects: [effect("b/7", "closure")] }),
      ]);
      expect(out).toHaveLength(1);
    });

    it("never merges different directions, validity or effect rules", () => {
      const pairs: Array<[Partial<RoadConditionEvent>, Partial<RoadConditionEvent>]> = [
        [{ direction: { value: "positive" } }, { direction: { value: "negative" } }],
        [
          { validity: { status: "active", end: "2026-10-01T00:00:00Z" } },
          { validity: { status: "active", end: "2026-10-02T00:00:00Z" } },
        ],
        [
          { effects: [effect("1", "closure", { scope: "road" })] },
          { effects: [effect("1", "closure", { scope: "ramp" })] },
        ],
        [
          {
            effects: [
              effect("1", "closure", {
                applicability: { kind: "classes", include: [{ class: "truck" }] },
              }),
            ],
          },
          {
            effects: [
              effect("1", "closure", {
                applicability: { kind: "classes", include: [{ class: "car" }] },
              }),
            ],
          },
        ],
      ];
      for (const [a, b] of pairs) {
        const out = dedupeRoadConditionEvents([
          ev({ id: "a", source: "a", ...closure, ...a }),
          ev({ id: "b", source: "b", ...closure, ...b }),
        ]);
        expect(out).toHaveLength(2);
      }
    });

    it("never merges a situation carrying restriction evidence", () => {
      const partial = [effect("1", "closure", { normalization: "partial" })];
      const out = dedupeRoadConditionEvents([
        ev({ id: "a", source: "a", ...closure, effects: partial }),
        ev({ id: "b", source: "b", ...closure, effects: partial }),
      ]);
      expect(out).toHaveLength(2);
    });
  });
});
