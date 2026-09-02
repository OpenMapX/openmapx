import { describe, expect, it } from "vitest";
import { concatenateRoutes } from "../route-concat.js";
import type { Route, RouteStep } from "../types.js";

function step(instruction: string): RouteStep {
  return { instruction, distance: 100, duration: 60, coordinates: [] };
}

function route(overrides: Partial<Route> & { geometry: [number, number][] }): Route {
  return {
    distance: 1000,
    duration: 600,
    legs: [
      {
        distance: 1000,
        duration: 600,
        geometry: overrides.geometry,
        steps: [step("go")],
      },
    ],
    steps: [step("go")],
    mode: "driving",
    ...overrides,
  };
}

describe("concatenateRoutes", () => {
  it("returns the single route untouched", () => {
    const only = route({
      geometry: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(concatenateRoutes([only])).toBe(only);
  });

  it("drops the duplicated join coordinate", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
      }),
    ]);
    expect(merged.geometry).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("keeps a coordinate that is not an exact join", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
      }),
      route({
        geometry: [
          [1.0001, 1],
          [2, 2],
        ],
      }),
    ]);
    expect(merged.geometry).toHaveLength(4);
  });

  it("sums distance and duration and concatenates legs and steps", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        distance: 1000,
        duration: 600,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        distance: 2500,
        duration: 900,
      }),
    ]);
    expect(merged.distance).toBe(3500);
    expect(merged.duration).toBe(1500);
    expect(merged.legs).toHaveLength(2);
    expect(merged.steps).toHaveLength(2);
  });

  it("keeps segmentSpeedLimits aligned to the joined geometry", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        segmentSpeedLimits: [50, 70],
      }),
      route({
        geometry: [
          [2, 2],
          [3, 3],
        ],
        segmentSpeedLimits: [null],
      }),
    ]);
    expect(merged.geometry).toHaveLength(4);
    expect(merged.segmentSpeedLimits).toEqual([50, 70, null]);
    expect(merged.segmentSpeedLimits).toHaveLength(merged.geometry.length - 1);
  });

  it("omits segmentSpeedLimits when any leg lacks them", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        segmentSpeedLimits: [50],
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
      }),
    ]);
    expect(merged.segmentSpeedLimits).toBeUndefined();
  });

  it("sums baselineDuration only when every leg reports one", () => {
    const both = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        baselineDuration: 500,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        baselineDuration: 800,
      }),
    ]);
    expect(both.baselineDuration).toBe(1300);

    const partial = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        baselineDuration: 500,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
      }),
    ]);
    expect(partial.baselineDuration).toBeUndefined();
  });

  it("joins elevation only when every leg samples at the same interval", () => {
    const same = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        elevation: [10, 20],
        elevationInterval: 30,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        elevation: [20, 40],
        elevationInterval: 30,
      }),
    ]);
    expect(same.elevation).toEqual([10, 20, 20, 40]);
    expect(same.elevationInterval).toBe(30);

    const mixed = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        elevation: [10, 20],
        elevationInterval: 30,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        elevation: [20, 40],
        elevationInterval: 60,
      }),
    ]);
    expect(mixed.elevation).toBeUndefined();
    expect(mixed.elevationInterval).toBeUndefined();
  });

  it("keeps the first leg's summary and mode", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        summary: "via A57",
        mode: "driving",
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        summary: "via B9",
      }),
    ]);
    expect(merged.summary).toBe("via A57");
    expect(merged.mode).toBe("driving");
  });
});
