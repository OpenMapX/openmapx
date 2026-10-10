import type { RoadConditionRouteImpact, Route, RoutingTrafficProof } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { routeTrafficStatus } from "./route-traffic-status";

const now = Date.parse("2026-10-07T02:00:00Z");
export const proof: RoutingTrafficProof = {
  schemaVersion: 1,
  requestId: "request-one",
  writeId: "write-one",
  graphGeneration: "graph-one",
  engineBootId: "boot-one",
  endpoint: "route",
  costing: "auto",
  evaluatedAt: new Date(now - 1000).toISOString(),
  validUntil: new Date(now + 60000).toISOString(),
};
export const route: Route = {
  mode: "driving",
  duration: 2000,
  distance: 10000,
  geometry: [],
  legs: [],
  steps: [],
  trafficProof: proof,
};
export const impact: RoadConditionRouteImpact = {
  availability: "current",
  reasons: [],
  evaluatedAt: new Date(now).toISOString(),
  validUntil: new Date(now + 30000).toISOString(),
};

describe("route traffic evidence", () => {
  it("requires the matching server assessment as well as proof", () => {
    expect(routeTrafficStatus(route, impact, "routing-valhalla", now)?.application).toBe(
      "verified",
    );
    expect(routeTrafficStatus(route, undefined, "routing-valhalla", now)?.application).toBe(
      "unverified",
    );
    expect(
      routeTrafficStatus({ ...route, trafficProof: undefined }, impact, "routing-valhalla", now)
        ?.application,
    ).toBe("unverified");
  });
  it.each([
    { schemaVersion: 2 },
    { requestId: "" },
    { writeId: " " },
    { graphGeneration: "x".repeat(257) },
    { engineBootId: "" },
    { endpoint: "matrix" },
    { costing: "motorcycle" },
    { evaluatedAt: new Date(now + 1).toISOString() },
    { evaluatedAt: "invalid" },
    { validUntil: "invalid" },
  ])("rejects invalid proof %j", (invalid) => {
    const trafficProof = { ...proof, ...invalid } as RoutingTrafficProof;
    expect(
      routeTrafficStatus({ ...route, trafficProof }, impact, "routing-valhalla", now)?.application,
    ).toBe("unverified");
  });
  it("expires either lease at its exact deadline", () => {
    expect(routeTrafficStatus(route, impact, "routing-valhalla", now + 30000)?.application).toBe(
      "expired",
    );
    expect(
      routeTrafficStatus(
        { ...route, trafficProof: { ...proof, validUntil: new Date(now).toISOString() } },
        impact,
        "routing-valhalla",
        now,
      )?.application,
    ).toBe("expired");
  });
  it.each([
    { ...impact, evaluatedAt: new Date(now - 2000).toISOString() },
    { ...impact, evaluatedAt: new Date(now + 1).toISOString() },
    { ...impact, validUntil: new Date(now + 61000).toISOString() },
    { ...impact, reasons: ["graph_mismatch"] },
  ])("rejects contradictory assessment %j", (assessment) => {
    expect(routeTrafficStatus(route, assessment, "routing-valhalla", now)?.application).toBe(
      "unverified",
    );
  });
  it("does not carry verification to another provider or hosted route", () => {
    expect(routeTrafficStatus(route, impact, "routing-osrm", now)?.application).toBe("unverified");
    expect(
      routeTrafficStatus({ ...route, sourceIds: ["stadia-maps"] }, impact, "routing-valhalla", now),
    ).toMatchObject({ application: "unverified", source: "hostedValhalla" });
  });
  it("retains limited and failed assessment without verified claim", () => {
    expect(
      routeTrafficStatus(route, { ...impact, availability: "limited" }, "routing-valhalla", now)
        ?.application,
    ).toBe("limited");
    expect(
      routeTrafficStatus(route, { ...impact, availability: "unavailable" }, "routing-valhalla", now)
        ?.application,
    ).toBe("unavailable");
  });
  it("only labels motorized routes and matches motorcycle costing", () => {
    expect(
      routeTrafficStatus({ ...route, mode: "walking" }, impact, "routing-valhalla", now),
    ).toBeNull();
    expect(
      routeTrafficStatus(
        { ...route, mode: "motorcycle", trafficProof: { ...proof, costing: "motorcycle" } },
        impact,
        "routing-valhalla",
        now,
      )?.application,
    ).toBe("verified");
  });
});
