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

describe("dedupeRoadConditionEvents across sources", () => {
  // Along Hofmühlenstraße, Dresden: a 300 m line and the 150 m section of it.
  const line = (from: number, to: number) => ({
    type: "LineString" as const,
    coordinates: [
      [13.7 + from * 0.0000142, 51.03],
      [13.7 + to * 0.0000142, 51.03],
    ],
  });
  const dated = (start: string, end: string) => ({ status: "active" as const, start, end });
  const autumn = dated("2026-10-05T22:00:00Z", "2026-11-13T23:00:00Z");
  const state = ev({
    id: "state",
    source: "de-sn-list-events",
    ...works,
    headline: text("Verlegung 110 KV - Leitungsbau", "de"),
    geometry: line(0, 300),
    validity: autumn,
  });

  it("folds a city's record into the state's record of the same works, the covering one surviving", () => {
    const city = ev({
      id: "city",
      source: "de-sn-dresden-events",
      kind: "closure",
      type: "closure",
      headline: text("Vollsperrung", "de"),
      geometry: line(0, 280),
      validity: dated("2026-10-05T22:00:00Z", "2026-11-13T22:59:00Z"),
    });
    expect(dedupeRoadConditionEvents([city, state])).toEqual([state]);
    expect(dedupeRoadConditionEvents([state, city])).toEqual([state]);
  });

  it("keeps a short element lying inside a long record of the same works", () => {
    const ramp = ev({
      id: "ramp",
      source: "de-autobahn-events",
      ...works,
      geometry: line(10, 60),
      validity: autumn,
    });
    expect(dedupeRoadConditionEvents([state, ramp])).toHaveLength(2);
  });

  it("keeps records whose dates differ, unless one end agrees and so do the headlines", () => {
    const later = (headline: string) =>
      ev({
        id: headline,
        source: "de-sn-dresden-events",
        ...works,
        headline: text(headline, "de"),
        geometry: line(0, 290),
        validity: dated("2026-10-19T22:00:00Z", "2026-11-13T23:00:00Z"),
      });
    expect(dedupeRoadConditionEvents([state, later("Verlegung 110 KV - Leitungsbau")])).toEqual([
      state,
    ]);
    expect(dedupeRoadConditionEvents([state, later("Kanalreinigung")])).toHaveLength(2);
  });

  it("keeps records of other kinds, of one source, or without dates", () => {
    const like = (over: Partial<RoadConditionEvent>) =>
      ev({
        id: "x",
        source: "de-sn-dresden-events",
        ...works,
        geometry: line(0, 300),
        validity: autumn,
        ...over,
      });
    expect(
      dedupeRoadConditionEvents([state, like({ kind: "congestion", type: "congestion" })]),
    ).toHaveLength(2);
    expect(
      dedupeRoadConditionEvents([
        state,
        like({ source: "de-sn-list-events", headline: text("Kanal", "de") }),
      ]),
    ).toHaveLength(2);
    expect(
      dedupeRoadConditionEvents([state, like({ validity: { status: "active" } })]),
    ).toHaveLength(2);
  });

  it("keeps the record with restriction evidence, and two such records apart", () => {
    const lanes = [effect("1", "closure", { normalization: "partial" })];
    const motorway = ev({
      id: "motorway",
      source: "de-autobahn-events",
      ...works,
      geometry: line(0, 290),
      validity: autumn,
      effects: lanes,
    });
    expect(dedupeRoadConditionEvents([state, motorway])).toEqual([motorway]);
    expect(dedupeRoadConditionEvents([{ ...state, effects: lanes }, motorway])).toHaveLength(2);
  });

  it("keeps the record stating effects, even when the other covers it", () => {
    const closed = ev({
      id: "closed",
      source: "de-be-berlin-events",
      ...works,
      geometry: line(0, 280),
      validity: autumn,
      effects: [effect("1", "closure")],
    });
    expect(dedupeRoadConditionEvents([state, closed])).toEqual([closed]);
  });

  it("folds two records stating the same kinds of effect, not different ones", () => {
    const closing = (id: string, source: string, kinds: ("closure" | "lane_restriction")[]) =>
      ev({
        id,
        source,
        kind: "closure",
        type: "closure",
        geometry: line(0, 290),
        validity: autumn,
        effects: kinds.map((k, i) => effect(`${id}${i}`, k)),
      });
    expect(
      dedupeRoadConditionEvents([
        closing("viz", "de-be-berlin-events", ["closure"]),
        closing("ab", "de-autobahn-events", ["closure"]),
      ]),
    ).toHaveLength(1);
    expect(
      dedupeRoadConditionEvents([
        closing("viz", "de-be-berlin-events", ["closure"]),
        closing("ab", "de-autobahn-events", ["lane_restriction"]),
      ]),
    ).toHaveLength(2);
  });

  it("keeps a night closure apart from the next night's", () => {
    const night = (id: string, source: string, start: string, end: string) =>
      ev({ id, source, ...works, geometry: line(0, 290), validity: dated(start, end) });
    expect(
      dedupeRoadConditionEvents([
        night("ab", "de-autobahn-events", "2026-10-28T20:00:00Z", "2026-10-29T04:00:00Z"),
        night("viz", "de-be-berlin-events", "2026-10-29T20:00:00Z", "2026-10-30T04:00:00Z"),
      ]),
    ).toHaveLength(2);
  });

  it("does not compare a record spanning more than about 50 km", () => {
    const wide = {
      type: "LineString" as const,
      coordinates: [
        [12, 50],
        [15, 51.5],
      ],
    };
    const out = dedupeRoadConditionEvents([
      { ...state, geometry: wide },
      ev({ id: "w", source: "de-sn-dresden-events", ...works, geometry: wide, validity: autumn }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps a point near another source's record on a crossing road", () => {
    const crossing = ev({
      id: "crossing",
      source: "de-sn-dresden-events",
      ...works,
      roads: [{ name: text("Kesselsdorfer Straße", "de") }],
      geometry: { type: "Point", coordinates: [13.7 + 100 * 0.0000142, 51.03] },
      validity: autumn,
    });
    expect(
      dedupeRoadConditionEvents([
        { ...state, roads: [{ name: text("Hofmühlenstraße", "de") }] },
        crossing,
      ]),
    ).toHaveLength(2);
  });
});

describe("dedupeRoadConditionEvents of one measure's sections", () => {
  it("keeps two sections that only meet at a junction apart", () => {
    const section = (id: string, from: number, to: number) =>
      ev({
        id,
        ...works,
        headline: text("Campuslinie - Bauphase 3", "de"),
        geometry: {
          type: "LineString",
          coordinates: [
            [13.7 + from * 0.0000142, 51.03],
            [13.7 + to * 0.0000142, 51.03],
          ],
        },
      });
    expect(dedupeRoadConditionEvents([section("a", 0, 250), section("b", 250, 500)])).toHaveLength(
      2,
    );
  });
});
