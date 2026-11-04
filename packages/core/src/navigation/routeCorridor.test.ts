import { describe, expect, it } from "vitest";
import { isNearRoute, ROUTE_CORRIDOR_METERS } from "./routeCorridor";
import { prepareRouteMatcher } from "./routeMatcher";

// A west–east route along latitude 50 (about 7 km long).
const route = prepareRouteMatcher([
  [6.0, 50.0],
  [6.1, 50.0],
]);
// 0.001° of latitude ≈ 111 m.
const north = (metres: number) => 50 + metres / 111_320;

describe("isNearRoute", () => {
  it("keeps events on and beside the route", () => {
    expect(isNearRoute({ type: "Point", coordinates: [6.05, 50.0] }, route)).toBe(true);
    expect(isNearRoute({ type: "Point", coordinates: [6.05, north(600)] }, route)).toBe(true);
  });

  it("drops events further away", () => {
    expect(
      isNearRoute(
        { type: "Point", coordinates: [6.05, north(ROUTE_CORRIDOR_METERS + 500)] },
        route,
      ),
    ).toBe(false);
    // Beyond the route's end, not just beside it.
    expect(isNearRoute({ type: "Point", coordinates: [6.2, 50.0] }, route)).toBe(false);
  });

  it("keeps a line that only touches the corridor", () => {
    const line = {
      type: "LineString" as const,
      coordinates: Array.from({ length: 100 }, (_, i) => [6.05, north(5000 - i * 50)]),
    };
    expect(isNearRoute(line, route)).toBe(true);
  });

  it("keeps a long line crossing the route between distant vertices", () => {
    const crossing = {
      type: "LineString" as const,
      coordinates: [
        [6.05, north(-20_000)],
        [6.05, north(20_000)],
      ],
    };
    expect(isNearRoute(crossing, route)).toBe(true);
  });

  it("keeps an area the route runs through even with every edge far away", () => {
    const area = {
      type: "Polygon" as const,
      coordinates: [
        [
          [5.9, north(-20_000)],
          [6.2, north(-20_000)],
          [6.2, north(20_000)],
          [5.9, north(20_000)],
          [5.9, north(-20_000)],
        ],
      ],
    };
    expect(isNearRoute(area, route)).toBe(true);
    const elsewhere = {
      type: "Polygon" as const,
      coordinates: [
        [
          [7.0, 51.0],
          [7.1, 51.0],
          [7.1, 51.1],
          [7.0, 51.0],
        ],
      ],
    };
    expect(isNearRoute(elsewhere, route)).toBe(false);
  });

  it("treats missing or empty geometry as not near", () => {
    expect(isNearRoute(null, route)).toBe(false);
    expect(isNearRoute({ type: "MultiPoint", coordinates: [] }, route)).toBe(false);
  });
});
