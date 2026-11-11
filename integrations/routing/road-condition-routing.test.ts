import { describe, expect, it } from "vitest";
import {
  boundEvent,
  effect,
  firstEffect,
  roadConditionEvent,
} from "./__tests__/support/road-condition.js";
import { assessRoadConditionForRoute } from "./road-condition-routing.js";

const NOW = Date.parse("2026-09-12T12:00:00Z");

const context = {
  evaluatedAt: NOW,
  travelAt: NOW,
  mode: "driving" as const,
  sharedTrafficApplied: false,
};

/** The Fintraffic weight limit as OpenConditions reads it: partially normalised. */
const weightLimit = effect("GUID50451433/dimension_limit", "dimension_limit", {
  dimension: "gross_weight",
  value: { value: 26, unit: "t" },
  operator: "lte",
  meaning: "maximum_permitted",
  normalization: "partial",
});

describe("assessRoadConditionForRoute", () => {
  it("refuses raw geometry fallback for graph evidence without a proven engine receipt", () => {
    const event = boundEvent();
    expect(assessRoadConditionForRoute(event, firstEffect(event), context)).toEqual({
      disposition: "ignore",
      reasons: ["unverified_engine_application"],
      validUntil: "2026-09-12T12:05:00.000Z",
    });
  });

  it("uses a proven current shared-traffic receipt only for motorised immediate routing", () => {
    const event = boundEvent();
    const closure = firstEffect(event);
    expect(
      assessRoadConditionForRoute(event, closure, { ...context, sharedTrafficApplied: true }),
    ).toEqual({
      disposition: "shared-traffic",
      reasons: [],
      validUntil: "2026-09-12T12:05:00.000Z",
    });

    expect(
      assessRoadConditionForRoute(event, closure, {
        ...context,
        travelAt: NOW + 60_000,
        sharedTrafficApplied: true,
      }).reasons,
    ).toContain("unsupported_future_shared_traffic");
    expect(
      assessRoadConditionForRoute(event, closure, {
        ...context,
        mode: "cycling",
        sharedTrafficApplied: true,
      }).reasons,
    ).toContain("unsupported_mode");
  });

  it("does not fall back to geometry for an effect its evidence-publishing provider left unbound", () => {
    const unbound = effect("oc:1/speed_limit", "speed_limit", {
      limit: { value: 60, unit: "km/h" },
    });
    const event = boundEvent();
    event.effects.push(unbound);
    expect(assessRoadConditionForRoute(event, unbound, context)).toEqual({
      disposition: "ignore",
      reasons: ["missing_routing_evidence"],
      validUntil: null,
    });
  });

  it("never lets the raw geometry of a situation without routing evidence bind a route", () => {
    const unbound = roadConditionEvent();
    expect(assessRoadConditionForRoute(unbound, firstEffect(unbound), context)).toEqual({
      disposition: "ignore",
      reasons: ["missing_routing_evidence"],
      validUntil: null,
    });
  });

  it.each([
    ["a partially normalised weight limit", weightLimit],
    [
      "a closure for unknown vehicles",
      effect("oc:1/closure", "closure", { applicability: { kind: "unknown" } }),
    ],
    [
      "a lorry closure",
      effect("oc:1/closure", "closure", {
        applicability: { kind: "classes", include: [{ class: "truck" }] },
      }),
    ],
  ])("ignores %s whatever the engine claims", (_name, fx) => {
    const event = boundEvent({}, fx);
    expect(
      assessRoadConditionForRoute(event, fx, { ...context, sharedTrafficApplied: true }),
    ).toEqual({
      disposition: "ignore",
      reasons: ["vehicle_specific_restriction"],
      validUntil: null,
    });
  });

  it("reads restriction evidence before the missing routing evidence of its situation", () => {
    const unbound = roadConditionEvent({ effects: [weightLimit] });
    expect(assessRoadConditionForRoute(unbound, weightLimit, context)).toEqual({
      disposition: "ignore",
      reasons: ["vehicle_specific_restriction"],
      validUntil: null,
    });
  });

  it("leaves a closure that names cars outright unbound without routing evidence", () => {
    const carClosure = effect("test:1/closure", "closure", {
      applicability: { kind: "classes", include: [{ class: "car" }] },
    });
    const unbound = roadConditionEvent({ effects: [carClosure] });
    expect(assessRoadConditionForRoute(unbound, carClosure, context)).toEqual({
      disposition: "ignore",
      reasons: ["missing_routing_evidence"],
      validUntil: null,
    });
  });

  it.each(["cycling", "walking"] as const)(
    "lets a closure that names only cars leave a %s route alone",
    (mode) => {
      const carClosure = effect("test:1/closure", "closure", {
        applicability: { kind: "classes", include: [{ class: "car" }] },
      });
      const unbound = roadConditionEvent({ effects: [carClosure] });
      expect(assessRoadConditionForRoute(unbound, carClosure, { ...context, mode })).toEqual({
        disposition: "ignore",
        reasons: ["vehicle_specific_restriction"],
        validUntil: null,
      });
    },
  );

  it.each([
    ["closure", {}],
    ["speed_limit", { limit: { value: 60, unit: "km/h" } }],
  ] as const)("routes a %s that names cars outright through shared traffic", (kind, fields) => {
    const cars = { kind: "classes" as const, include: [{ class: "car" as const }] };
    const fx = effect(`oc:1/${kind}`, kind, { ...fields, applicability: cars });
    const event = boundEvent({}, fx, { applicability: cars });
    expect(
      assessRoadConditionForRoute(event, fx, { ...context, sharedTrafficApplied: true })
        .disposition,
    ).toBe("shared-traffic");
  });

  it("judges each effect against its own evidence", () => {
    const event = boundEvent({}, effect("oc:1/closure"), { effect_id: "oc:1/other" });
    expect(
      assessRoadConditionForRoute(event, firstEffect(event), {
        ...context,
        sharedTrafficApplied: true,
      }).reasons,
    ).toEqual(["invalid_routing_evidence"]);
  });
});
