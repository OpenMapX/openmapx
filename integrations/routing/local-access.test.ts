import type { LngLat } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import {
  clearOfEndpoints,
  nearbyLines,
  planLocalAccess,
  routeUsesLocalAccessRoad,
} from "./local-access.js";

/** A street of about 136 m along latitude 52.437. */
const street: LngLat[] = [
  [13.485, 52.437],
  [13.487, 52.437],
];
/** Degrees of latitude per metre. */
const M = 1 / 111_320;
const north = (metres: number, lon = 13.486): LngLat => [lon, 52.437 + metres * M];
const far: LngLat = [13.3, 52.5];

describe("planLocalAccess", () => {
  it("lets an endpoint on the street snap onto it and reach it from its nearest point", () => {
    const plan = planLocalAccess([north(5), far], [street], []);
    expect(plan).toEqual({ origin: { snapOntoClosure: true, accessPoints: [north(0)] } });
  });

  it("plans the destination as well, and leaves an endpoint far from any such street alone", () => {
    const plan = planLocalAccess([far, north(400)], [street], []);
    expect(plan?.origin).toBeUndefined();
    expect(plan?.destination).toEqual({ snapOntoClosure: false, accessPoints: [north(0)] });
    expect(planLocalAccess([far, north(2_000)], [street], [])).toBeUndefined();
  });

  it("never snaps onto a closed road when a closure of every car lies as near", () => {
    const hard: LngLat[] = [north(40, 13.485), north(40, 13.487)];
    expect(planLocalAccess([north(30), far], [street], [hard])?.origin?.snapOntoClosure).toBe(
      false,
    );
  });

  it("offers the two nearest such streets, nearest first", () => {
    const second: LngLat[] = [north(300, 13.485), north(300, 13.487)];
    const third: LngLat[] = [north(600, 13.485), north(600, 13.487)];
    const plan = planLocalAccess([north(250), far], [third, street, second], []);
    const [nearest, next] = plan?.origin?.accessPoints ?? [];
    expect(nearest?.[1]).toBeCloseTo(north(300)[1], 6);
    expect(next).toEqual(north(0));
    expect(plan?.origin?.accessPoints).toHaveLength(2);
  });

  it("plans only the first and last waypoint", () => {
    const plan = planLocalAccess([far, north(5), far], [street], []);
    expect(plan).toBeUndefined();
  });
});

describe("clearOfEndpoints", () => {
  it("closes such a road unless an end lies on it", () => {
    expect(clearOfEndpoints(street, [far, north(800)])).toBe(true);
    expect(clearOfEndpoints(street, [far, north(50)])).toBe(false);
    expect(clearOfEndpoints(street, [north(50), far])).toBe(false);
  });
});

describe("nearbyLines", () => {
  it("keeps the roads within a kilometre of either end", () => {
    const distant: LngLat[] = [north(5_000, 13.485), north(5_000, 13.487)];
    expect(nearbyLines([far, north(400)], [street, distant])).toEqual([street]);
  });
});

describe("routeUsesLocalAccessRoad", () => {
  /** Metres east of the street's west end, on it. */
  const east = (metres: number): LngLat => [13.485 + metres / (111_320 * Math.cos(0.9152)), 52.437];

  it("finds a route that drives along such a street", () => {
    const route: LngLat[] = [north(0, 13.4855), north(1, 13.4865), north(200, 13.4865)];
    expect(routeUsesLocalAccessRoad(route, [street])).toBe(true);
  });

  it("ignores a route that only crosses it", () => {
    const route: LngLat[] = [north(-200), north(200)];
    expect(routeUsesLocalAccessRoad(route, [street])).toBe(false);
  });

  it("ignores a route crossing it with dense vertices at the junction", () => {
    const route: LngLat[] = [north(-200), north(-10), north(0), north(10), north(200)];
    expect(routeUsesLocalAccessRoad(route, [street])).toBe(false);
  });

  it("counts only one continuous run along it", () => {
    const route: LngLat[] = [east(10), east(22), north(100), east(50), east(62)];
    expect(routeUsesLocalAccessRoad(route, [street])).toBe(false);
  });
});
