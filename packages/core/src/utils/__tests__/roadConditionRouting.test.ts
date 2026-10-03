import { describe, expect, it } from "vitest";
import { getRoadConditionRoutingDecision } from "../roadConditionRouting";
import { closure, effect, event, evidence } from "./fixtures/roadCondition";

const now = Date.parse("2026-09-11T12:00:00Z");

describe("road-condition routing evidence", () => {
  it("accepts a current, permitted complete binding until its source deadline", () => {
    expect(getRoadConditionRoutingDecision(event(), closure(), { evaluatedAt: now })).toEqual({
      eligible: true,
      reasons: [],
      validUntil: "2026-09-11T12:10:00.000Z",
    });
  });

  it.each(["ambiguous", "unresolved", "no_coverage", "obsolete", "unattempted"])(
    "withholds %s bindings",
    (status) => {
      const e = event();
      e.routingEvidence!["fr1/closure"]!.binding_status = status as "ambiguous";
      expect(getRoadConditionRoutingDecision(e, closure(e), { evaluatedAt: now }).eligible).toBe(
        false,
      );
    },
  );

  it("cannot use a binding of an earlier revision", () => {
    const e = event();
    e.routingEvidence!["fr1/closure"]!.binding_revision = 2;
    expect(getRoadConditionRoutingDecision(e, closure(e), { evaluatedAt: now }).reasons).toContain(
      "obsolete_binding",
    );
  });

  it("expires at the boundary even if the situation has a later end date", () => {
    expect(
      getRoadConditionRoutingDecision(event(), closure(), { evaluatedAt: now + 600_000 }).eligible,
    ).toBe(false);
  });

  it("checks evidence now and a future situation at travel time separately", () => {
    const e = event();
    e.routingEvidence!["fr1/closure"]!.valid_from = "2026-09-12T10:00:00Z";
    e.routingEvidence!["fr1/closure"]!.valid_to = "2026-09-12T16:00:00Z";
    expect(
      getRoadConditionRoutingDecision(e, closure(e), {
        evaluatedAt: now,
        travelAt: Date.parse("2026-09-12T12:00:00Z"),
      }).eligible,
    ).toBe(true);
  });

  it("rejects class-scoped evidence, denied parents and unknown grants", () => {
    const e = event();
    e.routingEvidence!["fr1/closure"]!.applicability = {
      kind: "classes",
      include: [{ class: "truck" }],
    };
    expect(getRoadConditionRoutingDecision(e, closure(e), { evaluatedAt: now }).reasons).toContain(
      "unsupported_vehicle_scope",
    );
    expect(
      getRoadConditionRoutingDecision(event(), closure(), {
        evaluatedAt: now,
        disallowedSources: new Set(["fr"]),
      }).eligible,
    ).toBe(false);
    const unknown = event();
    unknown.routingEvidence!["fr1/closure"]!.rights.derived_redistribution = "unknown";
    expect(
      getRoadConditionRoutingDecision(unknown, closure(unknown), { evaluatedAt: now }).reasons,
    ).toContain("unverified_rights");
  });

  it("routes a closure for cars outright as it routes one for all traffic", () => {
    const cars = { kind: "classes" as const, include: [{ class: "car" as const }] };
    const rule = effect("fr1/closure", "closure", { applicability: cars });
    const e = { ...event(), effects: [rule] };
    e.routingEvidence!["fr1/closure"]!.applicability = cars;
    expect(getRoadConditionRoutingDecision(e, rule, { evaluatedAt: now }).eligible).toBe(true);
  });

  it("routes an effect only on its own evidence, of this situation and this kind", () => {
    const e = event();
    delete e.routingEvidence;
    expect(getRoadConditionRoutingDecision(e, closure(e), { evaluatedAt: now }).reasons).toEqual([
      "missing_routing_evidence",
    ]);
    const other = event();
    other.routingEvidence = { "fr1/closure": { ...evidence(), record_id: "oc:situation:fr:fr2" } };
    expect(
      getRoadConditionRoutingDecision(other, closure(other), { evaluatedAt: now }).reasons,
    ).toEqual(["invalid_routing_evidence"]);
    const kind = event();
    kind.routingEvidence = { "fr1/closure": evidence("fr1/closure", "speed_limit") };
    expect(
      getRoadConditionRoutingDecision(kind, closure(kind), { evaluatedAt: now }).eligible,
    ).toBe(false);
  });

  it("routes a crowd situation only once its evidence made it routing-eligible", () => {
    const crowd = { ...event(), origin: "crowd" as const, evidence: { state: "reported" } };
    expect(
      getRoadConditionRoutingDecision(crowd, closure(crowd), { evaluatedAt: now }).reasons,
    ).toContain("unconfirmed_origin");
    const corroborated = {
      ...crowd,
      evidence: { state: "corroborated", routingEligible: true },
    };
    expect(
      getRoadConditionRoutingDecision(corroborated, closure(corroborated), { evaluatedAt: now })
        .eligible,
    ).toBe(true);
  });

  it("needs a transition instant to route an effect that recurs", () => {
    const e = event();
    e.effects = [
      effect("fr1/closure", "closure", {
        validity: {
          status: "active",
          periods: [{ startTime: "22:00", duration: "PT6H", scheduleTimezone: "Europe/Paris" }],
        },
      }),
    ];
    expect(getRoadConditionRoutingDecision(e, closure(e), { evaluatedAt: now }).reasons).toContain(
      "unsupported_schedule",
    );
  });

  it("fails closed without throwing for malformed runtime evidence", () => {
    for (const patch of [
      { segments: [null] },
      { reason_codes: "exact" },
      { rights: [] },
      { applicability: { kind: "all", raw: [1] } },
      { record_revision: "3" },
      { fresh_until: "bad" },
    ]) {
      const malformed = event();
      Object.assign(malformed.routingEvidence!["fr1/closure"]!, patch);
      const decide = () =>
        getRoadConditionRoutingDecision(malformed, closure(malformed), { evaluatedAt: now });
      expect(decide).not.toThrow();
      expect(decide().eligible).toBe(false);
    }
  });

  it("never routes restriction evidence or a vehicle rule, whatever the evidence claims", () => {
    for (const rule of [
      effect("fr1/closure", "closure", { applicability: { kind: "unknown" } }),
      effect("fr1/closure", "closure", { normalization: "partial" }),
      effect("fr1/closure", "closure", {
        applicability: { kind: "classes", include: [{ class: "hgv" }] },
      }),
      effect("fr1/closure", "dimension_limit", {
        dimension: "gross_weight",
        value: { value: 26000, unit: "kg" },
        operator: "lte",
        meaning: "maximum_permitted",
      }),
    ]) {
      const e = { ...event(), effects: [rule] };
      expect(getRoadConditionRoutingDecision(e, rule, { evaluatedAt: now })).toMatchObject({
        eligible: false,
        reasons: ["vehicle_specific_restriction"],
      });
    }
  });
});
