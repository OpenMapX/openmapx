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
    const schematic = buildJunctionSchematic(engineGantry, mirrored);
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
});
