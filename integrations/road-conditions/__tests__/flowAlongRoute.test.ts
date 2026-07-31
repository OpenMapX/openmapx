import { describe, expect, it } from "vitest";
import { parseRouteFlowBody, routeCorridorBboxes } from "../flowAlongRoute.js";

const M = 0.001 / 111.32;
const northRoute = (meters: number, steps = 40): [number, number][] =>
  Array.from(
    { length: steps + 1 },
    (_, i) => [8, 50 + (meters / steps) * i * M] as [number, number],
  );

describe("routeCorridorBboxes", () => {
  it("returns one padded box for a short route", () => {
    const boxes = routeCorridorBboxes(northRoute(1000));
    expect(boxes).toHaveLength(1);
    const [west, south, east, north] = boxes[0];
    expect(west).toBeLessThan(8);
    expect(east).toBeGreaterThan(8);
    expect(south).toBeLessThan(50);
    expect(north).toBeGreaterThan(50.008);
  });

  it("splits a long route into chunks", () => {
    expect(routeCorridorBboxes(northRoute(100_000)).length).toBeGreaterThanOrEqual(5);
  });

  it("covers every route point across the chunks", () => {
    const route = northRoute(60_000);
    const boxes = routeCorridorBboxes(route);
    for (const [lng, lat] of route) {
      const covered = boxes.some(([w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n);
      expect(covered).toBe(true);
    }
  });

  it("returns nothing for a degenerate route", () => {
    expect(routeCorridorBboxes([[8, 50]])).toEqual([]);
  });
});

describe("parseRouteFlowBody", () => {
  it("accepts a well-formed body", () => {
    expect(
      parseRouteFlowBody({
        routes: [
          {
            id: "r0",
            geometry: [
              [8, 50],
              [8, 50.01],
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "r0",
        geometry: [
          [8, 50],
          [8, 50.01],
        ],
      },
    ]);
  });

  it("rejects a non-object body", () => {
    expect(parseRouteFlowBody("nope")).toBeNull();
    expect(parseRouteFlowBody({ routes: {} })).toBeNull();
  });

  it("rejects out-of-domain coordinates", () => {
    expect(
      parseRouteFlowBody({
        routes: [
          {
            id: "r",
            geometry: [
              [8, 50],
              [8, 999],
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects a route with fewer than two points", () => {
    expect(parseRouteFlowBody({ routes: [{ id: "r", geometry: [[8, 50]] }] })).toBeNull();
  });

  it("rejects more routes than a directions result can hold", () => {
    const one = {
      id: "r",
      geometry: [
        [8, 50],
        [8, 50.01],
      ],
    };
    expect(parseRouteFlowBody({ routes: [one, one, one, one, one] })).toBeNull();
  });

  it("rejects a route whose points are too sparse for the chunk cap", () => {
    // Each hop is ~22.3 km (0.2° of longitude at the equator), over the 20 km
    // chunk length, so every hop starts its own chunk: 600 points → 599
    // chunks, past the 500-chunk cap — well within the 20,000-point limit,
    // so only the chunk cap can be rejecting this.
    const sparse: [number, number][] = Array.from({ length: 600 }, (_, i) => [-60 + i * 0.2, 0]);
    expect(parseRouteFlowBody({ routes: [{ id: "r", geometry: sparse }] })).toBeNull();
  });
});
