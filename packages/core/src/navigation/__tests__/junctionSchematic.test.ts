import { describe, expect, it } from "vitest";
import type { GantryModel, JunctionDecisionPoint } from "../../types/junction";
import type { Route } from "../../types/routing";
import fixture from "../__fixtures__/junction/a57-neuss-exit20.json";
import { findJunctionDecisionPoints } from "../junctionDetect";
import { buildJunctionSchematic } from "../junctionSchematic";

const a57Route = fixture.route as unknown as Route;
const a57Point = findJunctionDecisionPoints(a57Route)[0];

const engineGantry: GantryModel = {
  laneCount: 5,
  panels: [
    {
      lanes: [4],
      destinations: ["Neuss-Zentrum"],
      refs: [],
      symbols: [],
      isExit: true,
      exitNumber: "20",
    },
  ],
  activeLanes: [4],
  source: "engine",
};

describe("buildJunctionSchematic", () => {
  it("draws five lane bands, the exit panel anchor and a right-side ramp for the fixture", () => {
    const schematic = buildJunctionSchematic(engineGantry, a57Point);
    expect(schematic.width).toBe(320);
    expect(schematic.height).toBe(140);
    expect(schematic.lanePolygons).toHaveLength(5);
    expect(schematic.panelAnchors).toHaveLength(1);
    const anchor = schematic.panelAnchors[0];
    // The rightmost lane's top span: the lanes run across the top edge.
    expect(anchor.x).toBeGreaterThan(320 * 0.6);
    expect(schematic.rampPath.length).toBeGreaterThan(0);
    // The ramp's far end pulls to the right half of the viewBox.
    const rampXs = [...schematic.rampPath.matchAll(/[\d.]+/g)].map(Number);
    expect(Math.max(...rampXs)).toBeGreaterThan(160);
  });

  it("lights the lanes of the gantry it draws, not the engine's", () => {
    // OSM tags four lanes at the gantry and names the rightmost as the exit;
    // the engine counted five and marked its fifth.
    const osmGantry: GantryModel = {
      ...engineGantry,
      laneCount: 4,
      panels: [{ ...engineGantry.panels[0], lanes: [3] }],
      activeLanes: [3],
      source: "osm",
    };
    const schematic = buildJunctionSchematic(osmGantry, { ...a57Point, activeLanes: [4] });
    expect(schematic.lanePolygons).toHaveLength(4);
    expect(schematic.activeLanes).toEqual([3]);
  });

  it("lights OSM's exit lanes where the engine sent no lanes", () => {
    const osmGantry: GantryModel = { ...engineGantry, activeLanes: [3, 4], source: "osm" };
    const schematic = buildJunctionSchematic(osmGantry, { ...a57Point, activeLanes: [] });
    expect(schematic.activeLanes).toEqual([3, 4]);
  });

  it("mirrors the ramp to the left for a left-side exit", () => {
    const mirrored: JunctionDecisionPoint = { ...a57Point, side: "left" };
    const schematic = buildJunctionSchematic({ ...engineGantry, activeLanes: [0] }, mirrored);
    const right = buildJunctionSchematic(engineGantry, a57Point);
    // Mirroring flips the ramp to the other half of the carriageway.
    expect(schematic.rampPath).not.toBe(right.rampPath);
    const xs = [...schematic.rampPath.matchAll(/[\d.]+/g)].map(Number);
    expect(Math.max(...xs)).toBeLessThanOrEqual(160 + 1e-9);
  });

  it("clamps the ramp angle to 8..45 degrees", () => {
    const shallow = buildJunctionSchematic(engineGantry, { ...a57Point, divergenceDeg: 3 });
    const steep = buildJunctionSchematic(engineGantry, { ...a57Point, divergenceDeg: 90 });
    const normal = buildJunctionSchematic(engineGantry, a57Point);
    // A 3° ramp and a 90° ramp clamp to the same two geometries.
    expect(shallow.rampPath).not.toBe(normal.rampPath);
    expect(steep.rampPath).not.toBe(normal.rampPath);
    expect(shallow.rampPath).toBe(
      buildJunctionSchematic(engineGantry, { ...a57Point, divergenceDeg: 0 }).rampPath,
    );
  });

  it("is deterministic across calls", () => {
    expect(buildJunctionSchematic(engineGantry, a57Point)).toEqual(
      buildJunctionSchematic(engineGantry, a57Point),
    );
  });

  it("draws the full width of a confirmed two-lane branch above the lane bands", () => {
    const schematic = buildJunctionSchematic(
      { ...engineGantry, laneCount: 4, activeLanes: [2, 3] },
      a57Point,
    );
    // The top of four bands spans x=100..220; lanes 2 and 3 occupy x=160..220.
    expect(schematic.rampPath).toMatch(/^M 160\.0 58\.8 L 220\.0 58\.8 /);
  });

  it("mirrors a two-lane branch on the left", () => {
    const schematic = buildJunctionSchematic(
      { ...engineGantry, laneCount: 4, activeLanes: [0, 1] },
      { ...a57Point, side: "left" },
    );
    expect(schematic.rampPath).toMatch(/^M 100\.0 58\.8 L 160\.0 58\.8 /);
  });

  it.each([[], [0, 3], [1, 2]].map((activeLanes) => ({ activeLanes })))(
    "withholds branch geometry for unconfirmed or disjoint exit lanes $activeLanes",
    ({ activeLanes }) => {
      const schematic = buildJunctionSchematic(
        { ...engineGantry, laneCount: 4, activeLanes },
        a57Point,
      );
      expect(schematic.lanePolygons).toHaveLength(4);
      expect(schematic.rampPath).toBe("");
    },
  );

  it("still produces valid paths for a one-lane model", () => {
    const oneLane: GantryModel = {
      laneCount: 1,
      panels: [
        { lanes: [0], destinations: ["Neuss-Zentrum"], refs: [], symbols: [], isExit: true },
      ],
      activeLanes: [0],
      source: "engine",
    };
    const schematic = buildJunctionSchematic(oneLane, a57Point);
    expect(schematic.lanePolygons).toHaveLength(1);
    expect(schematic.rampPath.length).toBeGreaterThan(0);
  });

  it("does not invent carriageway geometry for a sign-only model", () => {
    const schematic = buildJunctionSchematic(
      { ...engineGantry, laneCount: 0, activeLanes: [] },
      a57Point,
    );
    expect(schematic.laneCount).toBe(0);
    expect(schematic.lanePolygons).toEqual([]);
    expect(schematic.throughPath).toBe("");
    expect(schematic.rampPath).toBe("");
  });
});

describe("connected outgoing branch roads", () => {
  it("draws two two-lane roads across a neutral split without lighting incoming lanes", () => {
    const schematic = buildJunctionSchematic(
      {
        ...engineGantry,
        laneCount: 4,
        activeLanes: [],
        branches: [
          { wayId: 1, bearing: 352, laneCount: 2, selected: true },
          { wayId: 2, bearing: 357, laneCount: 2, selected: false },
        ],
      },
      a57Point,
    );
    expect(schematic.lanePolygons).toHaveLength(4);
    expect(schematic.activeLanes).toEqual([]);
    expect(schematic.rampPath).toBe("");
    expect(schematic.branches?.map((branch) => branch.selected)).toEqual([true, false]);
    const vertices = (path: string) =>
      [...path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((match) => ({
        x: Number(match[1]),
        y: Number(match[2]),
      }));
    const incomingTop = Math.min(
      ...schematic.lanePolygons.flatMap(vertices).map((vertex) => vertex.y),
    );
    const roads = schematic.branches ?? [];
    const outgoingBottom = Math.max(
      ...roads.flatMap((road) => vertices(road.path)).map((vertex) => vertex.y),
    );
    // Lane markings stop on either side of a broad neutral junction area.
    expect(incomingTop - outgoingBottom).toBeGreaterThanOrEqual(20);
    expect(schematic.branches?.map((branch) => branch.lanePolygons.length)).toEqual([2, 2]);
    for (const road of roads) {
      expect(road.path).toMatch(/Z$/);
      const bottom = vertices(road.path).filter((vertex) => vertex.y === outgoingBottom);
      const roadWidth =
        Math.max(...bottom.map((vertex) => vertex.x)) -
        Math.min(...bottom.map((vertex) => vertex.x));
      expect(roadWidth).toBeGreaterThanOrEqual(50);
      const laneStarts = road.lanePolygons.map((polygon) =>
        vertices(polygon).filter((vertex) => vertex.y === outgoingBottom),
      );
      expect(laneStarts[0]).not.toEqual(laneStarts[1]);
    }
  });
  it("keeps an unknown branch count unknown", () => {
    const schematic = buildJunctionSchematic(
      {
        ...engineGantry,
        branches: [
          { wayId: 1, bearing: 352, selected: true },
          { wayId: 2, bearing: 357, laneCount: 2, selected: false },
        ],
      },
      a57Point,
    );
    expect(schematic.branches?.[0].lanePolygons).toEqual([]);
  });
});

it("keeps three forward-facing branch roads within the viewBox", () => {
  const schematic = buildJunctionSchematic(
    {
      ...engineGantry,
      branches: [
        { wayId: 1, bearing: 340, laneCount: 1, selected: false },
        { wayId: 2, bearing: 350, laneCount: 2, selected: true },
        { wayId: 3, bearing: 10, selected: false },
      ],
    },
    a57Point,
  );
  for (const road of schematic.branches ?? []) {
    expect(road.path).toMatch(/Z$/);
    const numbers = [...road.path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    expect(
      numbers.every(
        (value, index) =>
          value >= 0 && value <= (index % 2 === 0 ? schematic.width : schematic.height),
      ),
    ).toBe(true);
  }
  expect(schematic.branches?.[2].lanePolygons).toEqual([]);
});
