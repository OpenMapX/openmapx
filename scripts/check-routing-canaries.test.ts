import { describe, expect, it } from "vitest";
import { type RoutingCanary, validateRoutingCanary } from "./check-routing-canaries";

const CANARY: RoutingCanary = {
  name: "control",
  waypoints: "0,0;1,1",
  minimumRoutes: 2,
  requireBaseline: true,
};

describe("validateRoutingCanary", () => {
  it("accepts multiple routes when baseline is greater than live duration", () => {
    expect(
      validateRoutingCanary(CANARY, {
        routes: [
          { duration: 600, baselineDuration: 620 },
          { duration: 700, baselineDuration: 710 },
        ],
      }),
    ).toEqual([]);
  });

  it("requires the configured minimum route count", () => {
    expect(
      validateRoutingCanary(CANARY, { routes: [{ duration: 600, baselineDuration: 620 }] }),
    ).toEqual(["control: expected at least 2 route(s), received 1"]);
  });

  it("rejects missing or invalid duration fields", () => {
    expect(
      validateRoutingCanary(CANARY, {
        routes: [
          { duration: 0, baselineDuration: null },
          { duration: Number.NaN, baselineDuration: -1 },
        ],
      }),
    ).toEqual([
      "control: route 1 has no finite baseline duration",
      "control: route 2 has no finite live duration",
      "control: route 2 has no finite baseline duration",
    ]);
  });
});
