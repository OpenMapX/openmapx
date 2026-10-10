import { describe, expect, it } from "vitest";
import type { GantryModel, JunctionWay } from "../../types/junction";
import type { Route } from "../../types/routing";
import holz from "../__fixtures__/junction/a44-kreuz-holz-a46.json";
import fixture from "../__fixtures__/junction/a57-neuss-exit20.json";
import { findJunctionCandidates, findJunctionDecisionPoints } from "../junctionDetect";
import { mergeExitPanel, parseLaneTags, selectApproachWay, selectRampWay } from "../laneTags";

const a57Point = findJunctionDecisionPoints(fixture.route as unknown as Route)[0];

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

  it("takes the exit lane from the OSM turn tags when the engine sent no lanes", () => {
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
    expect(merged.panels.at(-1)!.lanes).toEqual([4]);
    expect(merged.activeLanes).toEqual([4]);
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

  it("spans every lane the OSM tags send toward the exit", () => {
    const model = parseLaneTags(
      {
        lanes: 4,
        destinationRefLanes: "A 1|A 1|A 2|A 2",
        turnLanes: "none|none|slight_right|right",
      },
      4,
    )!;
    const merged = mergeExitPanel(model, { ...a57Point, laneCount: undefined, activeLanes: [] });
    expect(merged.activeLanes).toEqual([2, 3]);
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
    expect(merged.panels.at(-1)!.lanes).toEqual([]);
  });

  it("appends the exit panel from the ramp tags and moves the active lanes", () => {
    const model = parseLaneTags(
      {
        lanes: 5,
        destinationRefLanes: "A 57|A 57|A 57|A 46|A 46",
      },
      5,
    )!;
    const merged = mergeExitPanel(model, a57Point, { destination: "Neuss-Zentrum" });
    expect(merged.panels.at(-1)).toEqual({
      lanes: [4],
      destinations: ["Neuss-Zentrum"],
      refs: [],
      symbols: [],
      isExit: true,
      exitNumber: "20",
    });
    expect(merged.activeLanes).toEqual([4]);
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
    const exitPanel = merged.panels.at(-1)!;
    expect(exitPanel.lanes).toEqual([]);
    expect(merged.activeLanes).toEqual([]);
  });

  it("does not guess a left lane when the engine counted a different carriageway", () => {
    const merged = mergeExitPanel(fourLaneModel, {
      ...a57Point,
      activeLanes: [0],
      side: "left",
    });
    expect(merged.panels.at(-1)!.lanes).toEqual([]);
    expect(merged.activeLanes).toEqual([]);
  });
});

describe("parseLaneTags edge cases", () => {
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

  it("keeps both left lanes toward A46 Neuss when their turn arrows agree", () => {
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
    expect(merged.activeLanes).toEqual([0, 1]);
    expect(merged.panels.find((panel) => panel.isExit)?.lanes).toEqual([0, 1]);
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
    expect(merged.panels[0].destinations).toEqual(["Düsseldorf", "Neuss"]);
  });

  it("reads composite OSM turn arrows when the exit direction agrees", () => {
    const model: GantryModel = {
      laneCount: 4,
      panels: [],
      activeLanes: [],
      laneTurns: ["none", "none", "through;slight_right", "slight_right"],
      source: "osm",
    };
    const merged = mergeExitPanel(model, { ...a57Point, laneCount: undefined, activeLanes: [] });
    expect(merged.activeLanes).toEqual([2, 3]);
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
    const point = findJunctionCandidates(holz.route as unknown as Route)[0];
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
  const point = findJunctionCandidates(holz.route as unknown as Route)[0];
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
    expect(result.panels.find((panel) => panel.isExit)?.lanes).toEqual([]);
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
    expect(result.laneSelectionReliable).toBe(true);
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
