import { describe, expect, it } from "vitest";
import type { GantryModel, JunctionWay } from "../../types/junction";
import type { Route } from "../../types/routing";
import fixture from "../__fixtures__/junction/a57-neuss-exit20.json";
import { findJunctionDecisionPoints } from "../junctionDetect";
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

  it("falls back to the outermost lane when neither the engine nor OSM says", () => {
    const model = parseLaneTags({ lanes: 5, destinationRefLanes: "A 57|A 57|A 57|A 46|A 46" }, 5)!;
    const merged = mergeExitPanel(model, { ...a57Point, laneCount: undefined, activeLanes: [] });
    expect(merged.activeLanes).toEqual([4]);
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

  it("maps the exit panel to the outermost right lane when the model is narrower", () => {
    const merged = mergeExitPanel(fourLaneModel, { ...a57Point, activeLanes: [4] }, undefined);
    const exitPanel = merged.panels.at(-1)!;
    expect(exitPanel.lanes).toEqual([3]);
    expect(merged.activeLanes).toEqual([3]);
  });

  it("maps the exit panel to lane 0 on the left side", () => {
    const merged = mergeExitPanel(fourLaneModel, {
      ...a57Point,
      activeLanes: [0],
      side: "left",
    });
    expect(merged.panels.at(-1)!.lanes).toEqual([0]);
    expect(merged.activeLanes).toEqual([0]);
  });
});

describe("parseLaneTags edge cases", () => {
  it("tolerates a trailing empty lane value", () => {
    const model = parseLaneTags({ lanes: 3, destinationRefLanes: "A 57|A 46|" }, 3)!;
    expect(model.panels).toHaveLength(2);
    expect(model.panels[0].refs).toEqual(["A 57"]);
  });

  it("returns null when the lanes tag disagrees", () => {
    expect(
      parseLaneTags({ lanes: 4, destinationRefLanes: "A 57|A 57|A 46|A 46|A 46" }, 5),
    ).toBeNull();
  });

  it("does not invent destinations for lanes the tag leaves out", () => {
    expect(parseLaneTags({ lanes: 5, destinationRefLanes: "A 57|A 57|A 46|A 46" }, 5)).toBeNull();
    // The same short list is rejected when only the engine knows the lane count.
    expect(parseLaneTags({ destinationRefLanes: "A 57|A 57|A 46|A 46" }, 5)).toBeNull();
  });

  it("returns null with only turn:lanes and no destination tags", () => {
    expect(
      parseLaneTags({ lanes: 5, turnLanes: "none|none|none|none|slight_right" }, 5),
    ).toBeNull();
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
