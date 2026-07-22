import { describe, expect, it } from "vitest";
import type { StreetLevelLink } from "../types/streetLevel";
import { bearingDegrees, directionSector, selectArrowLinks } from "./streetLevelLinks";

const ORIGIN: [number, number] = [2.352, 48.8573];

function link(overrides: Partial<StreetLevelLink> & { id: string }): StreetLevelLink {
  return {
    providerId: "panoramax",
    lngLat: ORIGIN,
    rel: "related",
    ...overrides,
  };
}

describe("bearingDegrees", () => {
  it("returns 0 due north", () => {
    expect(Math.round(bearingDegrees(ORIGIN, [2.352, 48.8583]))).toBe(0);
  });

  it("returns 90 due east", () => {
    expect(Math.round(bearingDegrees(ORIGIN, [2.353, 48.8573]))).toBe(90);
  });

  it("returns -90 due west", () => {
    expect(Math.round(bearingDegrees(ORIGIN, [2.351, 48.8573]))).toBe(-90);
  });

  it("corrects for longitude convergence at high latitude", () => {
    // At 60N a degree of longitude is half a degree of latitude on the ground.
    // Equal degree deltas must therefore NOT read as 45 degrees.
    const highLat: [number, number] = [10, 60];
    const bearing = bearingDegrees(highLat, [10.001, 60.001]);
    expect(bearing).toBeLessThan(45);
    expect(bearing).toBeGreaterThan(20);
  });
});

describe("directionSector", () => {
  it.each([
    [0, "N"],
    [29, "N"],
    [-29, "N"],
    [30, "ENE"],
    [89, "ENE"],
    [90, "ESE"],
    [149, "ESE"],
    [150, "S"],
    [-150, "S"],
    [180, "S"],
    [-30, "WNW"],
    [-89, "WNW"],
    [-90, "WSW"],
    [-149, "WSW"],
  ])("maps %i degrees to %s", (bearing, expected) => {
    expect(directionSector(bearing as number)).toBe(expected);
  });
});

describe("selectArrowLinks", () => {
  it("keeps at most one link per direction sector", () => {
    const arrows = selectArrowLinks(ORIGIN, [
      link({ id: "north-near", lngLat: [2.352, 48.8574] }),
      link({ id: "north-far", lngLat: [2.352, 48.8578] }),
    ]);
    expect(arrows).toHaveLength(1);
  });

  it("returns one arrow per distinct sector", () => {
    const arrows = selectArrowLinks(ORIGIN, [
      link({ id: "n", lngLat: [2.352, 48.8578] }),
      link({ id: "e", lngLat: [2.3526, 48.8574] }),
      link({ id: "w", lngLat: [2.3514, 48.8574] }),
    ]);
    expect(arrows).toHaveLength(3);
    expect(new Set(arrows.map((a) => a.sector)).size).toBe(3);
  });

  it("prefers next/prev over related in the same sector", () => {
    const arrows = selectArrowLinks(ORIGIN, [
      link({ id: "related", lngLat: [2.352, 48.8574], rel: "related" }),
      link({ id: "next", lngLat: [2.352, 48.8575], rel: "next" }),
    ]);
    expect(arrows).toHaveLength(1);
    expect(arrows[0]?.id).toBe("next");
  });

  it("prefers the nearer related link when captured the same day", () => {
    const arrows = selectArrowLinks(ORIGIN, [
      link({ id: "far", lngLat: [2.352, 48.8578], capturedAt: "2024-05-01T10:00:00Z" }),
      link({ id: "near", lngLat: [2.352, 48.8574], capturedAt: "2024-05-01T11:00:00Z" }),
    ]);
    expect(arrows[0]?.id).toBe("near");
  });

  it("prefers the more recent related link across different days", () => {
    const arrows = selectArrowLinks(ORIGIN, [
      link({ id: "near-old", lngLat: [2.352, 48.8574], capturedAt: "2020-01-01T10:00:00Z" }),
      link({ id: "far-new", lngLat: [2.352, 48.8578], capturedAt: "2024-05-01T10:00:00Z" }),
    ]);
    expect(arrows[0]?.id).toBe("far-new");
  });

  it("never returns more than six arrows", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      link({
        id: `l${i}`,
        lngLat: [2.352 + Math.sin(i) * 0.0004, 48.8573 + Math.cos(i) * 0.0004],
      }),
    );
    expect(selectArrowLinks(ORIGIN, many).length).toBeLessThanOrEqual(6);
  });

  it("drops links at the origin", () => {
    expect(selectArrowLinks(ORIGIN, [link({ id: "self", lngLat: ORIGIN })])).toEqual([]);
  });

  it("returns an empty array for no links", () => {
    expect(selectArrowLinks(ORIGIN, [])).toEqual([]);
  });
});
