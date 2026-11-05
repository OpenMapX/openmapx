import { describe, expect, it } from "vitest";
import type {
  JunctionDecisionPoint,
  JunctionLookupResult,
  JunctionWay,
} from "../../types/junction";
import { resolveLaneGuidance } from "../lanes";
import * as laneTags from "../laneTags";

const point: JunctionDecisionPoint = {
  stepIndex: 1,
  kind: "fork",
  side: "left",
  point: [0, 0.001],
  alongMeters: 100,
  approachBearing: 0,
  divergenceDeg: -20,
  laneCount: 2,
  activeLanes: [],
  approachTrace: [
    [0, 0],
    [0, 0.001],
  ],
  sign: { exitBranches: ["A 1"], exitToward: ["Target"] },
};
function way(patch: Partial<JunctionWay> = {}): JunctionWay {
  return {
    wayId: 1,
    highway: "motorway",
    bearing: 0,
    endDistanceMeters: 0,
    startDistanceMeters: 100,
    geometry: [
      [0, 0],
      [0, 0.001],
    ],
    tags: {
      lanes: 2,
      turnLanes: "through|slight_right",
      destinationLanes: "Target|Other",
      destinationRefLanes: "A1|A2",
    },
    ...patch,
  };
}
function lookup(approach = way()): JunctionLookupResult {
  return { index: 0, onMotorway: true, approach: [approach], ramps: [] };
}

describe("approach lane evidence", () => {
  it("uses a matched carriageway's per-lane destinations", () => {
    expect(laneTags.resolveApproachLaneGuidance(lookup(), point)).toMatchObject({
      preferredLanes: [0],
      usableLanes: [0],
      state: "known",
      source: "osm",
    });
  });
  it("keeps an unknown gap between equal destinations", () => {
    const result = laneTags.resolveApproachLaneGuidance(
      lookup(
        way({
          tags: { lanes: 3, destinationLanes: "Target||Target", destinationRefLanes: "A1||A1" },
        }),
      ),
      { ...point, laneCount: 3 },
    );
    expect(result?.preferredLanes).toEqual([0, 2]);
  });
  it.each(["Target", "Target|Other|Extra"])(
    "ignores malformed per-lane lists: %s",
    (destinationLanes) => {
      expect(
        laneTags.resolveApproachLaneGuidance(
          lookup(way({ tags: { lanes: 2, destinationLanes } })),
          point,
        )?.state,
      ).toBe("unknown");
    },
  );
  it("does not borrow destinations from a parallel carriageway", () => {
    const result = laneTags.resolveApproachLaneGuidance(
      lookup(
        way({
          geometry: [
            [0.0002, 0],
            [0.0002, 0.001],
          ],
        }),
      ),
      point,
    );
    expect(result).toBeUndefined();
  });
  it("does not borrow lanes from the opposite direction", () => {
    expect(
      laneTags.resolveApproachLaneGuidance(
        lookup(
          way({
            bearing: 180,
            geometry: [
              [0, 0.001],
              [0, 0],
            ],
          }),
        ),
        point,
      ),
    ).toBeUndefined();
  });
  it("does not transfer engine indices onto a different lane count", () => {
    const laneGuidance = resolveLaneGuidance([
      { indications: ["left"], valid: true, preferred: true },
      { indications: ["right"], valid: false },
    ]);
    const result = laneTags.resolveApproachLaneGuidance(
      lookup(
        way({
          tags: {
            lanes: 3,
            destinationLanes: "Other|Other|Target",
            destinationRefLanes: "A2|A2|A1",
          },
        }),
      ),
      { ...point, laneGuidance, activeLanes: [0] },
    );
    expect(result?.usableLanes).toEqual([2]);
    expect(result?.source).toBe("osm");
  });
  it("preserves explicit engine rejection instead of guessing acceptance", () => {
    const laneGuidance = resolveLaneGuidance([
      { indications: ["through"], valid: false },
      { indications: ["right"], valid: false },
    ]);
    expect(
      laneTags.resolveApproachLaneGuidance(lookup(), { ...point, laneGuidance }),
    ).toMatchObject({ usableLanes: [], preferredLanes: [], source: "engine" });
  });
  it("withholds conflicting engine and destination evidence", () => {
    const laneGuidance = resolveLaneGuidance([
      { indications: ["through"], valid: false },
      { indications: ["right"], valid: true, preferred: true },
    ]);
    expect(
      laneTags.resolveApproachLaneGuidance(lookup(), { ...point, laneGuidance, activeLanes: [1] }),
    ).toMatchObject({ state: "conflict", usableLanes: [], preferredLanes: [] });
  });
  it("keeps initially usable lanes distinct from preferred lanes", () => {
    const laneGuidance = resolveLaneGuidance([
      { indications: ["through"], valid: true },
      { indications: ["right"], valid: true },
    ]);
    expect(
      laneTags.resolveApproachLaneGuidance(lookup(), {
        ...point,
        laneGuidance,
        activeLanes: [0, 1],
      }),
    ).toMatchObject({ usableLanes: [0, 1], preferredLanes: [], source: "engine" });
  });
  it("withholds every lane when engine preference contradicts engine rejection", () => {
    const laneGuidance = resolveLaneGuidance([
      { indications: ["through"], valid: false, preferred: true },
      { indications: ["right"], valid: true },
    ]);
    const result = laneTags.resolveApproachLaneGuidance(lookup(), { ...point, laneGuidance });
    expect(result?.state).toBe("conflict");
    expect(result?.lanes.some((lane) => lane.valid === true)).toBe(false);
  });
  it("ignores destination evidence when one of its lane lists has a different length", () => {
    const result = laneTags.resolveApproachLaneGuidance(
      lookup(
        way({
          tags: {
            lanes: 2,
            destinationLanes: "Target",
            destinationRefLanes: "A1|A2",
          },
        }),
      ),
      point,
    );
    expect(result?.preferredLanes).toEqual([]);
  });
  it("does not infer lane selection from arrow direction alone", () => {
    expect(
      laneTags.resolveApproachLaneGuidance(
        lookup(way({ tags: { lanes: 2, turnLanes: "left|right" } })),
        point,
      ),
    ).toMatchObject({ state: "unknown", preferredLanes: [] });
  });
  it("does not assign all incoming lanes to an unresolved same-ref branch", () => {
    const result = lookup(way({ tags: { lanes: 2, destinationRefLanes: "A1|A1" } }));
    result.outgoing = [
      way({ wayId: 11, tags: { destinationRef: "A1", destination: "Target" } }),
      way({ wayId: 12, tags: { destinationRef: "A1", destination: "Other" } }),
    ];
    expect(laneTags.resolveApproachLaneGuidance(result, point)?.preferredLanes).toEqual([]);
  });
  it("does not use a nearer unconnected ramp to select lanes", () => {
    const result = lookup(
      way({ tags: { lanes: 2, destinationLanes: "Target|Other", destinationRefLanes: "A1|A2" } }),
    );
    result.outgoing = [
      way({ wayId: 11, tags: { destinationRef: "A1", destination: "Elsewhere" } }),
      way({ wayId: 12, tags: { destinationRef: "A2", destination: "Other" } }),
    ];
    expect(laneTags.resolveApproachLaneGuidance(result, point)?.preferredLanes).toEqual([]);
  });
});

describe("laneDestinationsAt", () => {
  it("can read a same-count link carrying the route into a split", () => {
    expect(
      laneTags.laneDestinationsAt(
        { approach: [], ramps: [way({ highway: "motorway_link" })] },
        point,
      ),
    ).toEqual([
      { destinations: ["Target"], refs: ["A1"] },
      { destinations: ["Other"], refs: ["A2"] },
    ]);
  });
  it("requires the engine lane count and legal approach direction", () => {
    expect(laneTags.laneDestinationsAt(lookup(), { ...point, laneCount: 3 })).toBeUndefined();
    expect(
      laneTags.laneDestinationsAt(lookup(way({ endDistanceMeters: -10 })), point),
    ).toBeUndefined();
  });
});

describe("way selection", () => {
  const westPoint = {
    ...point,
    approachBearing: 283,
    divergenceDeg: 17,
    laneCount: 5,
    approachTrace: undefined,
  };
  it("prefers a way whose bearing and lane count match over a reverse carriageway", () => {
    const candidates: JunctionWay[] = [
      way({ wayId: 2, bearing: 355, endDistanceMeters: 10, tags: { lanes: 5 } }),
      way({ wayId: 1, bearing: 285, endDistanceMeters: 100, tags: { lanes: 5 } }),
    ];
    expect(laneTags.selectApproachWay(candidates, westPoint)?.wayId).toBe(1);
  });

  it("keeps only _link ramps that start at the split within 60 degrees of the after bearing", () => {
    const ramps: JunctionWay[] = [
      way({ wayId: 3, highway: "motorway_link", bearing: 300, startDistanceMeters: 4 }),
      way({ wayId: 4, highway: "motorway_link", bearing: 200, startDistanceMeters: 2 }),
      // The Krefeld on-ramp merging 370 m upstream heads the route's way too.
      way({ wayId: 5, highway: "motorway_link", bearing: 268, startDistanceMeters: 372 }),
      way({ wayId: 6, highway: "motorway", bearing: 300, startDistanceMeters: 0 }),
    ];
    const selected = laneTags.selectRampWay(ramps, westPoint);
    expect(selected.map((r) => r.wayId)).toEqual([3]);
  });

  it("orders several qualifying ramps by their start distance", () => {
    const ramps: JunctionWay[] = [
      way({ wayId: 7, highway: "motorway_link", bearing: 295, startDistanceMeters: 40 }),
      way({ wayId: 8, highway: "motorway_link", bearing: 305, startDistanceMeters: 3 }),
    ];
    expect(laneTags.selectRampWay(ramps, westPoint).map((r) => r.wayId)).toEqual([8, 7]);
  });
});
