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

  it("keeps a provider that publishes no evidence on the explicit limited geometry path", () => {
    const legacy = roadConditionEvent({ provider: "road-conditions-legacy", source: "legacy" });
    expect(
      assessRoadConditionForRoute(legacy, firstEffect(legacy), {
        ...context,
        allowLegacyGeometry: true,
      }),
    ).toEqual({
      disposition: "legacy-geometry",
      reasons: ["legacy_geometry_unverified"],
      validUntil: null,
    });
  });

  it("does not fall back to geometry for an effect its evidence-publishing provider left unbound", () => {
    const unbound = effect("oc:1/speed_limit", "speed_limit", {
      limit: { value: 60, unit: "km/h" },
    });
    const event = boundEvent();
    event.effects.push(unbound);
    expect(
      assessRoadConditionForRoute(event, unbound, { ...context, allowLegacyGeometry: true }),
    ).toEqual({
      disposition: "ignore",
      reasons: ["missing_routing_evidence"],
      validUntil: null,
    });
  });

  it("refuses the geometry path without explicit permission", () => {
    const legacy = roadConditionEvent();
    expect(assessRoadConditionForRoute(legacy, firstEffect(legacy), context)).toEqual({
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

  it("ignores restriction evidence on the legacy-geometry path as well", () => {
    const legacy = roadConditionEvent({ effects: [weightLimit] });
    expect(
      assessRoadConditionForRoute(legacy, weightLimit, { ...context, allowLegacyGeometry: true })
        .disposition,
    ).toBe("ignore");
  });

  it("keeps the geometry of a closure that names cars outright", () => {
    const carClosure = effect("test:1/closure", "closure", {
      applicability: { kind: "classes", include: [{ class: "car" }] },
    });
    const legacy = roadConditionEvent({ effects: [carClosure] });
    expect(
      assessRoadConditionForRoute(legacy, carClosure, { ...context, allowLegacyGeometry: true })
        .disposition,
    ).toBe("legacy-geometry");
  });

  it("still applies an unconditional closure with valid evidence", () => {
    const event = boundEvent();
    expect(
      assessRoadConditionForRoute(event, firstEffect(event), {
        ...context,
        sharedTrafficApplied: true,
      }).disposition,
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
