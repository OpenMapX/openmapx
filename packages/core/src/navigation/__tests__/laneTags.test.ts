import { describe, expect, it } from "vitest";
import type { GantryModel, JunctionWay } from "../../types/junction";
import type { Route } from "../../types/routing";
import holz from "../__fixtures__/junction/a44-kreuz-holz-a46.json";
import fixture from "../__fixtures__/junction/a57-neuss-exit20.json";
import { findJunctionCandidates, findJunctionDecisionPoints } from "../junctionDetect";
import { mergeExitPanel, parseLaneTags, selectApproachWay, selectRampWay } from "../laneTags";

// Legacy tag-only calls have no geometry contract; matching is tested separately below.
const a57Point = {
  ...findJunctionDecisionPoints(fixture.route as unknown as Route)[0],
  approachTrace: undefined,
};

function way(partial: Partial<JunctionWay>): JunctionWay {
  return {
    wayId: 1,
    highway: "motorway",
    bearing: 283,
    endDistanceMeters: 50,
    startDistanceMeters: 0,
    tags: {},
    ...partial,
  };
}

describe("parseLaneTags on fixture way 314653469", () => {
  it("groups adjacent lanes into A 57 and A 46 panels", () => {
    const model = parseLaneTags(
      {
        lanes: 5,
        destinationLanes:
          "Krefeld;Düsseldorf Nord;Büttgen|Krefeld;Düsseldorf Nord;Büttgen|Krefeld;Düsseldorf Nord;Büttgen|Heinsberg;Aachen;Neuss-Holzheim|Heinsberg;Aachen;Neuss-Holzheim",
        destinationRefLanes: "A 57|A 57|A 57|A 46|A 46",
        turnLanes: "none|none|none|none|slight_right",
      },
      5,
    )!;
    expect(model.laneCount).toBe(5);
    expect(model.panels).toHaveLength(2);
    expect(model.panels[0].lanes).toEqual([0, 1, 2]);
    expect(model.panels[0].refs).toEqual(["A 57"]);
    expect(model.panels[0].destinations).toEqual(["Krefeld", "Düsseldorf Nord", "Büttgen"]);
    expect(model.panels[0].turn).toBeUndefined();
    expect(model.panels[1].lanes).toEqual([3, 4]);
    expect(model.panels[1].refs).toEqual(["A 46"]);
    expect(model.panels[1].destinations).toEqual(["Heinsberg", "Aachen", "Neuss-Holzheim"]);
    // The slight_right is not uniform across the panel, so no turn token.
    expect(model.panels[1].turn).toBeUndefined();
  });

  it("withholds turn-only assignment without branch correspondence", () => {
    const model = parseLaneTags(
      {
        lanes: 5,
        destinationRefLanes: "A 57|A 57|A 57|A 46|A 46",
        turnLanes: "none|none|none|none|slight_right",
      },
      5,
    )!;
    // Stadia's hosted Valhalla sends no lanes at all; OSM names the exit lane.
    const noEngineLanes = { ...a57Point, laneCount: undefined, activeLanes: [] };
    const merged = mergeExitPanel(model, noEngineLanes, { destination: "Neuss-Zentrum" });
    expect(merged.panels.every((panel) => !panel.isExit)).toBe(true);
    expect(merged.activeLanes).toEqual([]);
  });

  it("folds the exit into the board that already covers the exit lane", () => {
    // Way 314653466: lane 4 has its own board. Appending a second exit board
    // over the same lane lights two boards for one decision.
    const model = parseLaneTags(
      {
        lanes: 5,
        destinationLanes:
          "|||Heinsberg;Aachen;Neuss-Holzheim|Heinsberg;Aachen;Neuss-Holzheim;Neuss-Zentrum",
        destinationRefLanes: "A 57|A 57|A 57|A 46|A 46;Neuss-Zentrum",
        turnLanes: "none|none|none|none|slight_right",
      },
      5,
    )!;
    const merged = mergeExitPanel(
      model,
      { ...a57Point, laneCount: undefined, activeLanes: [] },
      {
        destination: "Neuss-Zentrum",
      },
    );
    expect(merged.panels.filter((panel) => panel.isExit)).toHaveLength(1);
    expect(merged.panels).toHaveLength(model.panels.length);
    const exitPanel = merged.panels.at(-1)!;
    expect(exitPanel.lanes).toEqual([4]);
    expect(exitPanel.exitNumber).toBe("20");
    expect(exitPanel.destinations).toContain("Neuss-Zentrum");
    expect(exitPanel.destinations).toContain("Heinsberg");
    // Each text once across the whole board, however the ways were tagged.
    const texts = [...exitPanel.refs, ...exitPanel.destinations];
    expect(texts.filter((text) => text === "Neuss-Zentrum")).toHaveLength(1);
  });

  it("reads a place name tagged into destination:ref as a destination", () => {
    // Way 314653466 carries "Neuss-Zentrum" in `destination:ref:lanes`; a road
    // ref always has a number, a town never does.
    const model = parseLaneTags({ lanes: 2, destinationRefLanes: "A 46|A 46;Neuss-Zentrum" }, 2)!;
    expect(model.panels.at(-1)!.refs).toEqual(["A 46"]);
    expect(model.panels.at(-1)!.destinations).toEqual(["Neuss-Zentrum"]);
  });

  it("withholds same-side arrows without a matching route destination", () => {
    const model = parseLaneTags(
      {
        lanes: 4,
        destinationRefLanes: "A 1|A 1|A 2|A 2",
        turnLanes: "none|none|slight_right|right",
      },
      4,
    )!;
    const merged = mergeExitPanel(model, { ...a57Point, laneCount: undefined, activeLanes: [] });
    expect(merged.activeLanes).toEqual([]);
  });

  it("keeps the engine's lanes when it sent them", () => {
    const model = parseLaneTags(
      {
        lanes: 5,
        destinationRefLanes: "A 57|A 57|A 57|A 46|A 46",
        // Mis-tagged: OSM says lane 0 exits, the engine says lane 4.
        turnLanes: "slight_right|none|none|none|none",
      },
      5,
    )!;
    const merged = mergeExitPanel(model, { ...a57Point, laneCount: 5, activeLanes: [4] });
    expect(merged.activeLanes).toEqual([4]);
  });

  it("withholds the lane recommendation when neither the engine nor OSM says", () => {
    const model = parseLaneTags({ lanes: 5, destinationRefLanes: "A 57|A 57|A 57|A 46|A 46" }, 5)!;
    const merged = mergeExitPanel(model, { ...a57Point, laneCount: undefined, activeLanes: [] });
    expect(merged.laneSelectionReliable).toBe(false);
    expect(merged.activeLanes).toEqual([]);
    expect(merged.panels.every((panel) => !panel.isExit)).toBe(true);
  });

  it("keeps the route title and preferred lanes separate from the physical boards", () => {
    const model = parseLaneTags(
      {
        lanes: 5,
        destinationRefLanes: "A 57|A 57|A 57|A 46|A 46",
      },
      5,
    )!;
    const merged = mergeExitPanel(model, a57Point, { destination: "Neuss-Zentrum" });
    expect(merged.selectedRoute).toMatchObject({
      destinations: ["Neuss-Zentrum"],
      refs: [],
      exitNumber: "20",
    });
    expect(merged.panels).toHaveLength(2);
    expect(merged.panels.at(-1)?.lanes).toEqual([3, 4]);
    expect(merged.activeLanes).toEqual([4]);
  });

  it.each([
    { roadNames: ["A 111", "E 26"], refs: ["A 111", "E 26"], destinations: [] },
    { roadNames: ["Main Street"], refs: [], destinations: ["Main Street"] },
  ])("uses engine road names for an otherwise empty selected title: $roadNames", (expected) => {
    const model = parseLaneTags({ lanes: 4, destinationLanes: "none|none|Other|Other" }, 4)!;
    const merged = mergeExitPanel(model, {
      ...a57Point,
      sign: undefined,
      roadNames: expected.roadNames,
      laneCount: 4,
      activeLanes: [0, 1],
    });
    expect(merged.selectedRoute).toMatchObject({
      refs: expected.refs,
      destinations: expected.destinations,
    });
    expect(merged.panels).toHaveLength(1);
    expect(merged.panels[0].lanes).toEqual([2, 3]);
    expect(merged.activeLanes).toEqual([0, 1]);
  });

  it("yields three panels for way 314653466 without the ramp", () => {
    const model = parseLaneTags(
      {
        lanes: 5,
        destinationLanes:
          "|||Heinsberg;Aachen;Neuss-Holzheim|Heinsberg;Aachen;Neuss-Holzheim;Neuss-Zentrum",
        destinationRefLanes: "A 57|A 57|A 57|A 46|A 46;Neuss-Zentrum",
      },
      5,
    )!;
    expect(model.panels).toHaveLength(3);
    expect(model.panels[2].destinations).toEqual([
      "Heinsberg",
      "Aachen",
      "Neuss-Holzheim",
      "Neuss-Zentrum",
    ]);
    // The town tagged into `destination:ref:lanes` is a destination, not a ref.
    expect(model.panels[2].refs).toEqual(["A 46"]);
    expect(model.panels[2].isExit).toBe(false);
  });
});

describe("parseLaneTags lane-count mismatches", () => {
  const fourLaneModel: GantryModel = {
    laneCount: 4,
    panels: [
      { lanes: [0, 1, 2, 3], destinations: ["Köln"], refs: ["A 57"], symbols: [], isExit: false },
    ],
    activeLanes: [],
    source: "osm",
  };

  it("withholds engine lane indices when the model is narrower", () => {
    const merged = mergeExitPanel(fourLaneModel, { ...a57Point, activeLanes: [4] }, undefined);
    expect(merged.panels.every((panel) => !panel.isExit)).toBe(true);
    expect(merged.activeLanes).toEqual([]);
  });

  it("does not guess a left lane when the engine counted a different carriageway", () => {
    const merged = mergeExitPanel(fourLaneModel, {
      ...a57Point,
      activeLanes: [0],
      side: "left",
    });
    expect(merged.panels.every((panel) => !panel.isExit)).toBe(true);
    expect(merged.activeLanes).toEqual([]);
  });
});

describe("parseLaneTags edge cases", () => {
  it("filters lane destination sentinels and repeated reference aliases", () => {
    const model = parseLaneTags({
      lanes: 4,
      destinationLanes: "none|none|Target|Target",
      destinationRefLanes: "||A6;A 6|A6;A 6",
    })!;
    expect(model.panels).toHaveLength(1);
    expect(model.panels[0].destinations).toEqual(["Target"]);
    expect(model.panels[0].refs).toEqual(["A6"]);
  });
  it("withholds non-number exit tokens while preserving alphanumeric exits", () => {
    const model = parseLaneTags({ lanes: 2 })!;
    expect(
      mergeExitPanel(model, {
        ...a57Point,
        sign: { exitNumbers: ["ramp"], exitToward: ["Target"] },
      }).panels[0].exitNumber,
    ).toBeUndefined();
    expect(
      mergeExitPanel(model, { ...a57Point, sign: { exitNumbers: ["77b"], exitToward: ["Target"] } })
        .panels[0].exitNumber,
    ).toBe("77b");
  });
  it("tolerates a trailing empty lane value", () => {
    const model = parseLaneTags({ lanes: 3, destinationRefLanes: "A 57|A 46|" }, 3)!;
    expect(model.panels).toHaveLength(2);
    expect(model.panels[0].refs).toEqual(["A 57"]);
  });

  it("retains lane geometry when a destination list disagrees with it", () => {
    const model = parseLaneTags({ lanes: 4, destinationRefLanes: "A 57|A 57|A 46|A 46|A 46" }, 5);
    expect(model?.laneCount).toBe(4);
    expect(model?.panels).toEqual([]);
  });

  it("does not invent destinations for lanes the tag leaves out", () => {
    expect(
      parseLaneTags({ lanes: 5, destinationRefLanes: "A 57|A 57|A 46|A 46" }, 5)?.panels,
    ).toEqual([]);
    expect(parseLaneTags({ destinationRefLanes: "A 57|A 57|A 46|A 46" }, 5)?.panels).toEqual([]);
  });

  it("retains a turn-only approach for matching the exit lanes", () => {
    const model = parseLaneTags({ lanes: 5, turnLanes: "none|none|none|none|slight_right" }, 5);
    expect(model?.laneCount).toBe(5);
    expect(model?.panels).toEqual([]);
    expect(model?.laneTurns).toEqual(["none", "none", "none", "none", "slight_right"]);
  });

  it("withholds two left arrows when their route branch is not evidenced", () => {
    const model = parseLaneTags({
      lanes: 4,
      turnLanes: "slight_left|slight_left|slight_right|slight_right",
    });
    expect(model).not.toBeNull();
    const merged = mergeExitPanel(
      model!,
      {
        ...a57Point,
        side: "left",
        laneCount: undefined,
        activeLanes: [],
        sign: { exitBranches: ["A 46"], exitToward: ["Düsseldorf", "Neuss"] },
      },
      { lanes: 2, destination: "Düsseldorf;Neuss", destinationRef: "A 46" },
    );
    expect(merged.laneCount).toBe(4);
    expect(merged.activeLanes).toEqual([]);
    expect(merged.panels.find((panel) => panel.isExit)?.lanes).toEqual([]);
  });

  it("uses both lanes whose destination board names the selected A44 branch", () => {
    const model = parseLaneTags({
      lanes: 4,
      destinationRefLanes: "A 4|A 4|A 44|A 44",
      destinationLanes: "Köln|Köln|Düsseldorf;Liège|Düsseldorf;Liège",
    })!;
    const merged = mergeExitPanel(
      model,
      {
        ...a57Point,
        side: "right",
        laneCount: undefined,
        activeLanes: [],
        sign: { exitBranches: ["A 44"], exitToward: ["Düsseldorf", "Liège"] },
      },
      { lanes: 2, destination: "Düsseldorf;Liège", destinationRef: "A44" },
    );
    expect(merged.activeLanes).toEqual([2, 3]);
  });

  it("disambiguates branches with the same motorway number by destination and turns", () => {
    const model = parseLaneTags({
      lanes: 4,
      destinationRefLanes: "A46|A46|A46|A46",
      destinationLanes: "Neuss|Neuss|Düsseldorf|Düsseldorf",
      turnLanes: "slight_left|slight_left|slight_right|slight_right",
    })!;
    const merged = mergeExitPanel(
      model,
      {
        ...a57Point,
        side: "left",
        laneCount: undefined,
        activeLanes: [],
        sign: { exitBranches: ["A46"], exitToward: ["Neuss"] },
      },
      { lanes: 2, destinationRef: "A46", destination: "Neuss" },
    );
    expect(merged.activeLanes).toEqual([0, 1]);
  });

  it("does not treat a shared motorway reference as evidence for every lane of a smaller branch", () => {
    const model = parseLaneTags({ lanes: 4, destinationRefLanes: "A46|A46|A46|A46" });
    if (!model) throw new Error("Missing lane model");
    const merged = mergeExitPanel(
      model,
      {
        ...a57Point,
        side: "left",
        laneCount: undefined,
        activeLanes: [],
        sign: { exitBranches: ["A46"], exitToward: ["Neuss"] },
      },
      { lanes: 2, destinationRef: "A46", destination: "Neuss" },
    );
    expect(merged.laneSelectionReliable).toBe(false);
    expect(merged.activeLanes).toEqual([]);
  });

  it("keeps the lane count and arrows without inventing destination panels", () => {
    const model = parseLaneTags({ lanes: 4, turnLanes: "none|none|slight_right|slight_right" });
    expect(model).toMatchObject({
      laneCount: 4,
      panels: [],
      laneTurns: ["none", "none", "slight_right", "slight_right"],
    });
  });

  it("retains a lane count even without destination or turn tags", () => {
    expect(parseLaneTags({ lanes: 3 })).toMatchObject({
      laneCount: 3,
      panels: [],
      activeLanes: [],
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unusable lane count %s",
    (lanes) => {
      expect(parseLaneTags({ lanes })).toBeNull();
    },
  );

  it("does not choose the opposite side when OSM and the maneuver disagree", () => {
    const model: GantryModel = {
      laneCount: 4,
      panels: [],
      activeLanes: [],
      laneTurns: ["none", "none", "slight_right", "slight_right"],
      source: "osm",
    };
    const merged = mergeExitPanel(
      model,
      { ...a57Point, side: "left", laneCount: undefined, activeLanes: [] },
      { lanes: 2, destination: "Düsseldorf;Neuss", destinationRef: "A 46" },
    );
    expect(merged.activeLanes).toEqual([]);
    expect(merged.panels[0].lanes).toEqual([]);
    expect(merged.panels[0].destinations).toEqual(["Neuss-Zentrum"]);
  });

  it("retains composite arrows without guessing the selected movement", () => {
    const model: GantryModel = {
      laneCount: 4,
      panels: [],
      activeLanes: [],
      laneTurns: ["none", "none", "through;slight_right", "slight_right"],
      source: "osm",
    };
    const merged = mergeExitPanel(model, { ...a57Point, laneCount: undefined, activeLanes: [] });
    expect(merged.activeLanes).toEqual([]);
  });

  it("attaches destination:symbol:lanes to its lane", () => {
    const model = parseLaneTags(
      {
        lanes: 5,
        destinationRefLanes: "A 57|A 57|A 46|A 46|A 46",
        destinationSymbolLanes: "||airport||",
      },
      5,
    )!;
    expect(model.panels[1].symbols).toEqual(["airport"]);
  });
});

describe("way selection", () => {
  it("prefers a way whose bearing and lane count match over a reverse carriageway", () => {
    const candidates: JunctionWay[] = [
      way({ wayId: 2, bearing: 355, endDistanceMeters: 10, tags: { lanes: 5 } }),
      way({ wayId: 1, bearing: 285, endDistanceMeters: 100, tags: { lanes: 5 } }),
    ];
    expect(selectApproachWay(candidates, a57Point)?.wayId).toBe(1);
  });

  it("keeps only _link ramps that start at the split within 60 degrees of the after bearing", () => {
    const ramps: JunctionWay[] = [
      way({ wayId: 3, highway: "motorway_link", bearing: 300, startDistanceMeters: 4 }),
      way({ wayId: 4, highway: "motorway_link", bearing: 200, startDistanceMeters: 2 }),
      // The Krefeld on-ramp merging 370 m upstream heads the route's way too.
      way({ wayId: 5, highway: "motorway_link", bearing: 268, startDistanceMeters: 372 }),
      way({ wayId: 6, highway: "motorway", bearing: 300, startDistanceMeters: 0 }),
    ];
    const selected = selectRampWay(ramps, a57Point);
    expect(selected.map((r) => r.wayId)).toEqual([3]);
  });

  it("orders several qualifying ramps by their start distance", () => {
    const ramps: JunctionWay[] = [
      way({ wayId: 7, highway: "motorway_link", bearing: 295, startDistanceMeters: 40 }),
      way({ wayId: 8, highway: "motorway_link", bearing: 305, startDistanceMeters: 3 }),
    ];
    expect(selectRampWay(ramps, a57Point).map((r) => r.wayId)).toEqual([8, 7]);
  });
});

describe("outgoing branch destination boards", () => {
  it("retains both Kreuz Holz destinations without assigning incoming lanes", () => {
    const point = {
      ...findJunctionCandidates(holz.route as unknown as Route)[0],
      approachTrace: undefined,
    };
    const model = parseLaneTags(holz.lookup.approach[0].tags)!;
    const gantry = mergeExitPanel(model, point, holz.lookup.ramps[0].tags, {
      ways: holz.lookup.outgoing,
    });
    expect(gantry.panels.map((panel) => panel.destinations)).toEqual([
      ["Düsseldorf", "Neuss"],
      ["Heinsberg", "Venlo", "Mönchengladbach"],
    ]);
    expect(gantry.branches?.map((branch) => branch.laneCount)).toEqual([2, 2]);
    expect(gantry.activeLanes).toEqual([]);
    expect(gantry.panels.every((panel) => panel.lanes.length === 0)).toBe(true);
  });
});

describe("connected branch route evidence", () => {
  it("withholds another carriageway's boards and destination-derived lane advice", () => {
    const model = parseLaneTags({ lanes: 2, destinationLanes: "Other|Target" })!;
    const result = mergeExitPanel(
      model,
      {
        ...a57Point,
        laneCount: undefined,
        activeLanes: [],
        laneGuidance: undefined,
        approachTrace: [
          [0, 0],
          [0, 0.001],
        ],
        sign: { exitToward: ["Target"] },
      },
      undefined,
      {
        ways: [],
        approach: way({
          geometry: [
            [1, 1],
            [1, 1.001],
          ],
          tags: { lanes: 2 },
        }),
      },
    );
    expect(result.laneGuidance?.state).toBe("unknown");
    expect(result.activeLanes).toEqual([]);
    expect(result.panels.every((panel) => panel.lanes.length === 0)).toBe(true);
    expect(result.panels.some((panel) => panel.destinations.includes("Other"))).toBe(false);
    expect(result.selectedRoute?.destinations).toEqual(["Target"]);
  });
  it("does not transfer engine lane indices to a parallel same-count carriageway", () => {
    const model = parseLaneTags({ lanes: 2 })!;
    const point = {
      ...a57Point,
      laneCount: 2,
      activeLanes: [0],
      approachTrace: [
        [0, 0],
        [0, 0.001],
      ] as [number, number][],
      laneGuidance: {
        lanes: [
          { indications: ["left"], valid: true, preferred: true },
          { indications: ["through"], valid: false, preferred: false },
        ],
        usableLanes: [0],
        preferredLanes: [0],
        state: "known" as const,
      },
    };
    const result = mergeExitPanel(model, point, undefined, {
      ways: [],
      approach: way({
        geometry: [
          [0.0002, 0],
          [0.0002, 0.001],
        ],
        tags: { lanes: 2 },
      }),
    });
    expect(result.laneSelectionReliable).toBe(false);
    expect(result.laneGuidance).toEqual(point.laneGuidance);
    expect(result.panels.every((panel) => panel.lanes.length === 0)).toBe(true);
  });
  it("does not replace explicit engine rejection with OSM lane acceptance", () => {
    const model = parseLaneTags({ lanes: 2, destinationLanes: "Target|Other" })!;
    const result = mergeExitPanel(model, {
      ...a57Point,
      laneCount: 2,
      activeLanes: [],
      sign: { exitToward: ["Target"] },
      laneGuidance: {
        lanes: [
          { indications: ["left"], valid: false },
          { indications: ["through"], valid: false },
        ],
        usableLanes: [],
        preferredLanes: [],
        state: "known",
      },
    });
    expect(result.activeLanes).toEqual([]);
    expect(result.laneSelectionReliable).toBe(false);
  });
  it("withholds conflicting engine and per-lane destination assignments", () => {
    const model = parseLaneTags({ lanes: 2, destinationLanes: "Other|Target" })!;
    const result = mergeExitPanel(model, {
      ...a57Point,
      laneCount: 2,
      activeLanes: [0],
      sign: { exitToward: ["Target"] },
      laneGuidance: {
        lanes: [
          { indications: ["left"], valid: true, preferred: true },
          { indications: ["through"], valid: false, preferred: false },
        ],
        usableLanes: [0],
        preferredLanes: [0],
        state: "known",
      },
    });
    expect(result.activeLanes).toEqual([]);
    expect(result.laneEvidence).toBe("conflict");
  });
  it("cannot select a contradictory road reference just because the destination matches", () => {
    const model = parseLaneTags({ lanes: 3 })!;
    const result = mergeExitPanel(
      model,
      { ...a57Point, sign: { exitBranches: ["A1"], exitToward: ["Target"] } },
      undefined,
      {
        ways: [
          way({ wayId: 11, tags: { destinationRef: "A2", destination: "Target" } }),
          way({ wayId: 12, tags: { destinationRef: "A1", destination: "Next" } }),
        ],
      },
    );
    expect(result.branches?.some((branch) => branch.selected)).toBe(false);
  });
  it("uses the specifically evidenced target lane rather than all arrows on that side", () => {
    const model = parseLaneTags({
      lanes: 3,
      turnLanes: "left|slight_left|through",
      destinationLanes: "Other|Target|Straight",
    })!;
    const result = mergeExitPanel(model, {
      ...a57Point,
      side: "left",
      laneCount: undefined,
      activeLanes: [],
      sign: { exitToward: ["Target"] },
    });
    expect(result.activeLanes).toEqual([1]);
  });
  it("does not claim branch correspondence from side arrows alone", () => {
    const model = parseLaneTags({ lanes: 3, turnLanes: "left|slight_left|through" })!;
    const result = mergeExitPanel(model, {
      ...a57Point,
      side: "left",
      laneCount: undefined,
      activeLanes: [],
      sign: { exitToward: ["Target"] },
    });
    expect(result.activeLanes).toEqual([]);
    expect(result.laneSelectionReliable).toBe(false);
  });
  it("preserves an unknown gap between otherwise equal destination boards", () => {
    expect(
      parseLaneTags({ lanes: 3, destinationLanes: "Target||Target" })?.panels.map((p) => p.lanes),
    ).toEqual([[0], [2]]);
  });
  it("uses the directed post-maneuver path to distinguish identical labels", () => {
    const model = parseLaneTags({ lanes: 2 })!;
    const result = mergeExitPanel(
      model,
      {
        ...a57Point,
        point: [0, 0],
        departureTrace: [
          [0.001, 0],
          [0.002, 0],
        ],
        sign: { exitBranches: ["A1"] },
      },
      undefined,
      {
        ways: [
          way({
            wayId: 11,
            bearing: 90,
            geometry: [
              [0, 0],
              [0.003, 0],
            ],
            tags: { destinationRef: "A1" },
          }),
          way({
            wayId: 12,
            bearing: 0,
            geometry: [
              [0, 0],
              [0, 0.003],
            ],
            tags: { destinationRef: "A1" },
          }),
        ],
      },
    );
    expect(
      result.branches?.filter((branch) => branch.selected).map((branch) => branch.wayId),
    ).toEqual([11]);
  });
  const point = {
    ...findJunctionCandidates(holz.route as unknown as Route)[0],
    approachTrace: undefined,
  };
  const model = parseLaneTags(holz.lookup.approach[0].tags)!;
  const roads: JunctionWay[] = holz.lookup.outgoing;

  it("selects the routed branch independent of response order", () => {
    for (const ways of [roads, [...roads].reverse()]) {
      const result = mergeExitPanel(model, point, undefined, { ways });
      expect(
        result.branches?.filter((branch) => branch.selected).map((branch) => branch.wayId),
      ).toEqual([168452743]);
    }
  });

  it("can select the non-link motorway continuation by its destination", () => {
    const result = mergeExitPanel(
      model,
      {
        ...point,
        sign: {
          exitBranches: ["A 46", "A 61"],
          exitToward: ["Heinsberg", "Venlo"],
        },
      },
      undefined,
      { ways: roads },
    );
    expect(
      result.branches?.filter((branch) => branch.selected).map((branch) => branch.wayId),
    ).toEqual([971245022]);
  });

  it("withholds branch selection when shared refs do not distinguish directions", () => {
    const result = mergeExitPanel(
      model,
      { ...point, sign: { exitBranches: ["A 46"] } },
      undefined,
      { ways: roads },
    );
    expect(result.branches?.some((branch) => branch.selected)).toBe(false);
    expect(result.panels.some((panel) => panel.isExit && panel.branchWayId === undefined)).toBe(
      true,
    );
  });

  it("does not assign all incoming lanes to an unresolved same-ref branch", () => {
    const laneModel = parseLaneTags({ lanes: 4, destinationRefLanes: "A46|A46|A46|A46" })!;
    const result = mergeExitPanel(
      laneModel,
      { ...point, sign: { exitBranches: ["A46"] } },
      undefined,
      { ways: roads },
    );
    expect(result.branches?.some((branch) => branch.selected)).toBe(false);
    expect(result.activeLanes).toEqual([]);
    expect(result.laneSelectionReliable).toBe(false);
    expect(result.panels.every((panel) => !panel.isExit)).toBe(true);
  });

  it("does not infer incoming lanes from shared refs when the selected branch has no count", () => {
    const laneModel = parseLaneTags({ lanes: 4, destinationRefLanes: "A46|A46|A46|A46" })!;
    const ways = roads.map((road) => ({ ...road, tags: { ...road.tags, lanes: undefined } }));
    const result = mergeExitPanel(laneModel, point, undefined, { ways });
    expect(result.branches?.find((branch) => branch.selected)?.wayId).toBe(168452743);
    expect(result.activeLanes).toEqual([]);
    expect(result.laneSelectionReliable).toBe(false);
  });

  it("keeps destination evidence for the selected subset of incoming lanes at a connected fork", () => {
    const laneModel = parseLaneTags({
      lanes: 4,
      destinationRefLanes: "A46|A46|A46|A46",
      destinationLanes: "Neuss|Neuss|Heinsberg|Heinsberg",
    })!;
    const result = mergeExitPanel(laneModel, point, undefined, { ways: roads });
    expect(result.activeLanes).toEqual([0, 1]);
    expect(result.laneSelectionReliable).toBe(false);
  });

  it("preserves the engine board when the routed branch lacks OSM destinations", () => {
    const ways = roads.map((road) =>
      road.wayId === 168452743 ? { ...road, tags: { lanes: 2 } } : road,
    );
    const result = mergeExitPanel(
      model,
      { ...point, sign: { ...point.sign, exitNumbers: ["16"] } },
      undefined,
      { ways },
    );
    expect(
      result.panels.some(
        (panel) => panel.destinations.includes("Neuss") && panel.exitNumber === "16",
      ),
    ).toBe(true);
    expect(result.panels.some((panel) => panel.destinations.includes("Heinsberg"))).toBe(true);
    expect(result.branches?.some((branch) => branch.selected)).toBe(false);
  });

  it("copies the engine exit number onto the selected branch board", () => {
    const result = mergeExitPanel(
      model,
      { ...point, sign: { ...point.sign, exitNumbers: ["16"] } },
      undefined,
      { ways: roads },
    );
    expect(result.panels.find((panel) => panel.branchWayId === 168452743)?.exitNumber).toBe("16");
  });

  it("uses engine destinations on a branch identified by its unique ref", () => {
    const ways = roads.map((road) =>
      road.wayId === 168452743
        ? { ...road, tags: { lanes: 2, destinationRef: "A 46" } }
        : { ...road, tags: { ...road.tags, destinationRef: "A 61" } },
    );
    const result = mergeExitPanel(model, point, undefined, { ways });
    expect(result.panels.find((panel) => panel.branchWayId === 168452743)?.destinations).toEqual([
      "Düsseldorf",
      "Neuss",
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "does not fabricate branch geometry for unusable lane count %s",
    (lanes) => {
      const ways = roads.map((road) => ({ ...road, tags: { ...road.tags, lanes } }));
      expect(
        mergeExitPanel(model, point, undefined, { ways }).branches?.every(
          (branch) => branch.laneCount === undefined,
        ),
      ).toBe(true);
    },
  );

  it("retains per-lane boards and separate outgoing labels", () => {
    const laneModel = parseLaneTags({ lanes: 4, destinationLanes: "X|X|Y|Y" })!;
    const result = mergeExitPanel(laneModel, point, undefined, { ways: roads });
    expect(result.panels.some((panel) => panel.destinations.includes("X"))).toBe(true);
    expect(result.branches?.find((branch) => branch.wayId === 971245022)).toMatchObject({
      destinations: ["Heinsberg", "Venlo", "Mönchengladbach"],
    });
  });
});

it("keeps physical board wording separate from the route-specific title", () => {
  const model = parseLaneTags({
    lanes: 2,
    destinationLanes: "North|South",
    destinationRefLanes: "A1|A2",
  })!;
  const result = mergeExitPanel(model, {
    stepIndex: 1,
    kind: "exit",
    side: "right",
    point: [0, 0],
    alongMeters: 100,
    approachBearing: 90,
    divergenceDeg: 20,
    laneCount: 2,
    activeLanes: [1],
    sign: { exitBranches: ["A2"], exitToward: ["South-Centre"] },
  });
  expect(result.panels.find((panel) => panel.lanes.includes(1))?.destinations).toEqual(["South"]);
  expect(result.selectedRoute?.destinations).toEqual(["South-Centre"]);
});

it("does not turn an explicit lane-evidence conflict into an OSM recommendation", () => {
  const model = parseLaneTags({
    lanes: 2,
    destinationLanes: "North|South",
    destinationRefLanes: "A1|A2",
  })!;
  const result = mergeExitPanel(model, {
    stepIndex: 1,
    kind: "exit",
    side: "right",
    point: [0, 0],
    alongMeters: 100,
    approachBearing: 90,
    divergenceDeg: 20,
    laneCount: 2,
    activeLanes: [],
    laneGuidance: {
      lanes: [
        { indications: [], valid: false, preferred: true },
        { indications: [], valid: false },
      ],
      usableLanes: [],
      preferredLanes: [],
      state: "conflict",
    },
    sign: { exitBranches: ["A2"] },
  });
  expect(result.laneGuidance?.state).toBe("conflict");
  expect(result.activeLanes).toEqual([]);
  expect(result.laneSelectionReliable).toBe(false);
});

it("keeps initially usable lanes separate from a narrower destination span", () => {
  const model = parseLaneTags({
    lanes: 2,
    destinationLanes: "North|South",
    destinationRefLanes: "A1|A2",
  })!;
  const result = mergeExitPanel(model, {
    stepIndex: 1,
    kind: "exit",
    side: "right",
    point: [0, 0],
    alongMeters: 100,
    approachBearing: 90,
    divergenceDeg: 20,
    laneCount: 2,
    activeLanes: [0, 1],
    laneGuidance: {
      lanes: [
        { indications: [], valid: true },
        { indications: [], valid: true },
      ],
      usableLanes: [0, 1],
      preferredLanes: [],
      state: "known",
    },
    sign: { exitBranches: ["A2"] },
  });
  expect(result.laneGuidance?.state).toBe("known");
  expect(result.laneGuidance?.usableLanes).toEqual([0, 1]);
  expect(result.laneGuidance?.preferredLanes).toEqual([]);
});
