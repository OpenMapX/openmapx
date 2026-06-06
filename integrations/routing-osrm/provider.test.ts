import { describe, expect, it } from "vitest";
import { transformOsrmStep } from "./provider.js";

const osrmStep = {
  distance: 120,
  duration: 30,
  name: "Main St",
  maneuver: { type: "turn", modifier: "right", location: [0, 0] as [number, number] },
  geometry: {
    type: "LineString" as const,
    coordinates: [
      [0, 0],
      [0.001, 0],
    ] as [number, number][],
  },
  intersections: [
    {
      lanes: [
        { valid: false, indications: ["left"] },
        { valid: true, indications: ["straight"] },
      ],
    },
  ],
  annotation: { maxspeed: [{ speed: 50, unit: "km/h" }] },
};

describe("transformOsrmStep", () => {
  it("carries maneuver type/modifier", () => {
    const s = transformOsrmStep(osrmStep);
    expect(s.maneuver).toEqual({ type: "turn", modifier: "right" });
  });

  it("carries lanes from the first intersection with lanes", () => {
    const s = transformOsrmStep(osrmStep);
    expect(s.lanes).toEqual([
      { indications: ["left"], valid: false },
      { indications: ["straight"], valid: true },
    ]);
  });

  it("captures valid_indication as the active lane indication", () => {
    const s = transformOsrmStep({
      ...osrmStep,
      intersections: [
        {
          lanes: [
            { valid: false, indications: ["left"] },
            { valid: true, indications: ["straight", "right"], valid_indication: "right" },
          ],
        },
      ],
    });
    expect(s.lanes?.[1]).toEqual({
      indications: ["straight", "right"],
      valid: true,
      active: "right",
    });
    // Invalid lane without a valid_indication carries no `active`.
    expect(s.lanes?.[0].active).toBeUndefined();
  });

  it("carries speed limit in km/h", () => {
    const s = transformOsrmStep(osrmStep);
    expect(s.speedLimit).toBe(50);
  });

  it("converts mph speed limits to km/h", () => {
    const s = transformOsrmStep({
      ...osrmStep,
      annotation: { maxspeed: [{ speed: 30, unit: "mph" }] },
    });
    expect(s.speedLimit).toBe(48); // 30 * 1.609 ≈ 48
  });

  it("omits lanes and speed limit when not provided", () => {
    const s = transformOsrmStep({
      distance: 10,
      duration: 5,
      name: "Side St",
      maneuver: { type: "depart", location: [0, 0] as [number, number] },
      geometry: {
        type: "LineString" as const,
        coordinates: [[0, 0]] as [number, number][],
      },
    });
    expect(s.lanes).toBeUndefined();
    expect(s.speedLimit).toBeUndefined();
    expect(s.maneuver).toEqual({ type: "depart", modifier: undefined });
  });

  it("skips maxspeed entries flagged unknown", () => {
    const s = transformOsrmStep({
      ...osrmStep,
      annotation: { maxspeed: [{ unknown: true }, { speed: 70, unit: "km/h" }] },
    });
    expect(s.speedLimit).toBe(70);
  });
});
