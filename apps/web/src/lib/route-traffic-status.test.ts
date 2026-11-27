import type { RoadConditionRouteImpact, Route, RoutingTrafficProof } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { type RoutingEngineLabels, routeTrafficStatus } from "./route-traffic-status";

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
const engines: RoutingEngineLabels = {
  "routing-proof": { name: "Proof Router", trafficProof: true },
  "routing-plain": { name: "Plain Router", trafficProof: false },
};
const status = (
  r: Route,
  assessment: RoadConditionRouteImpact | undefined,
  provider = "routing-proof",
  at = now,
  labels = engines,
) => routeTrafficStatus(r, assessment, provider, labels, at);

describe("route traffic evidence", () => {
  it("labels a route by the integration that produced it", () => {
    expect(
      routeTrafficStatus(
        { ...route, trafficProof: undefined },
        undefined,
        "routing-acme",
        { "routing-acme": { name: "Acme Router", trafficProof: true } },
        now,
      )?.source,
    ).toEqual({ integrationId: "routing-acme", name: "Acme Router", hosted: false });
  });
  it("verifies a traffic proof from any engine that declares proofs", () => {
    expect(
      routeTrafficStatus(
        route,
        impact,
        "routing-acme",
        { "routing-acme": { name: "Acme Router", trafficProof: true } },
        now,
      )?.application,
    ).toBe("verified");
  });
  it("does not verify a proof from an engine that declares none", () => {
    expect(
      routeTrafficStatus(
        route,
        impact,
        "routing-osrm",
        { "routing-osrm": { name: "OSRM", trafficProof: false } },
        now,
      )?.application,
    ).toBe("unverified");
  });
  it("falls back to the integration id, or no source, when the engine is not described", () => {
    expect(status(route, impact, "routing-gone")).toMatchObject({
      application: "unverified",
      source: { integrationId: "routing-gone", name: "routing-gone", hosted: false },
    });
    expect(routeTrafficStatus(route, impact, undefined, engines, now)?.source).toBeNull();
  });
  it("requires the matching server assessment as well as proof", () => {
    expect(status(route, impact)?.application).toBe("verified");
    expect(status(route, undefined)?.application).toBe("unverified");
    expect(status({ ...route, trafficProof: undefined }, impact)?.application).toBe("unverified");
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
    expect(status({ ...route, trafficProof }, impact)?.application).toBe("unverified");
  });
  it("expires either lease at its exact deadline", () => {
    expect(status(route, impact, "routing-proof", now + 30000)?.application).toBe("expired");
    expect(
      status(
        { ...route, trafficProof: { ...proof, validUntil: new Date(now).toISOString() } },
        impact,
      )?.application,
    ).toBe("expired");
  });
  it.each([
    { ...impact, evaluatedAt: new Date(now - 2000).toISOString() },
    { ...impact, evaluatedAt: new Date(now + 1).toISOString() },
    { ...impact, validUntil: new Date(now + 61000).toISOString() },
    { ...impact, reasons: ["graph_mismatch"] },
  ])("rejects contradictory assessment %j", (assessment) => {
    expect(status(route, assessment)?.application).toBe("unverified");
  });
  it("does not carry verification to another provider or hosted route", () => {
    expect(status(route, impact, "routing-plain")?.application).toBe("unverified");
    expect(status({ ...route, sourceIds: ["stadia-maps"] }, impact)).toMatchObject({
      application: "unverified",
      source: { integrationId: "routing-proof", name: "Proof Router", hosted: true },
    });
  });
  it("retains limited and failed assessment without verified claim", () => {
    expect(status(route, { ...impact, availability: "limited" })?.application).toBe("limited");
    expect(status(route, { ...impact, availability: "unavailable" })?.application).toBe(
      "unavailable",
    );
  });
  it("only labels motorized routes and matches motorcycle costing", () => {
    expect(status({ ...route, mode: "walking" }, impact)).toBeNull();
    expect(
      status(
        { ...route, mode: "motorcycle", trafficProof: { ...proof, costing: "motorcycle" } },
        impact,
      )?.application,
    ).toBe("verified");
  });
});
