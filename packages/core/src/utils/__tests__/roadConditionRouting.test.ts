import { describe, expect, it } from "vitest";
import { getRoadConditionRoutingDecision } from "../roadConditionRouting";
import { readRoadRestrictionDetails } from "../roadRestrictionDetails";

const now = Date.parse("2026-09-11T12:00:00Z");

import { event, publishedRestriction } from "./fixtures/roadCondition";

describe("road-condition routing evidence", () => {
  it("accepts a current, permitted complete binding until its source deadline", () => {
    expect(getRoadConditionRoutingDecision(event(), { evaluatedAt: now })).toEqual({
      eligible: true,
      reasons: [],
      validUntil: "2026-09-11T12:10:00.000Z",
    });
  });
  it.each(["ambiguous", "unresolved", "no_coverage", "obsolete", "unattempted"])(
    "withholds %s bindings",
    (status) => {
      const e = event();
      e.routingEvidence!.binding_status = status as "ambiguous";
      expect(getRoadConditionRoutingDecision(e, { evaluatedAt: now }).eligible).toBe(false);
    },
  );
  it("cannot use a stale binding for changed geometry", () => {
    const e = event();
    e.routingEvidence!.binding_revision = "old";
    expect(getRoadConditionRoutingDecision(e, { evaluatedAt: now }).reasons).toContain(
      "obsolete_binding",
    );
  });
  it("expires at the boundary even if the event has a later end date", () => {
    expect(getRoadConditionRoutingDecision(event(), { evaluatedAt: now + 600_000 }).eligible).toBe(
      false,
    );
  });
  it("checks evidence now and a future event at travel time separately", () => {
    const e = event();
    e.routingEvidence!.valid_from = "2026-09-12T10:00:00Z";
    e.routingEvidence!.valid_to = "2026-09-12T16:00:00Z";
    expect(
      getRoadConditionRoutingDecision(e, {
        evaluatedAt: now,
        travelAt: Date.parse("2026-09-12T12:00:00Z"),
      }).eligible,
    ).toBe(true);
  });
  it("rejects truck-only scope, denied parents and unknown grants", () => {
    const e = event();
    e.routingEvidence!.applicability = { kind: "classes", classes: ["truck"] };
    expect(getRoadConditionRoutingDecision(e, { evaluatedAt: now }).reasons).toContain(
      "unsupported_vehicle_scope",
    );
    expect(
      getRoadConditionRoutingDecision(event(), {
        evaluatedAt: now,
        disallowedSources: new Set(["fr"]),
      }).eligible,
    ).toBe(false);
    const unknown = event();
    unknown.routingEvidence!.rights.derived_redistribution = "unknown";
    expect(getRoadConditionRoutingDecision(unknown, { evaluatedAt: now }).reasons).toContain(
      "unverified_rights",
    );
  });
  it("keeps legacy observations display-only and rejects invalid time evidence", () => {
    const e = event();
    delete e.routingEvidence;
    expect(getRoadConditionRoutingDecision(e, { evaluatedAt: now }).eligible).toBe(false);
    const invalid = event();
    invalid.routingEvidence!.fresh_until = "bad";
    expect(getRoadConditionRoutingDecision(invalid, { evaluatedAt: now }).eligible).toBe(false);
  });
  it("fails closed without throwing for malformed runtime evidence", () => {
    for (const patch of [
      { segments: [null] },
      { reason_codes: "exact" },
      { rights: [] },
      { applicability: { kind: "all", raw: [1] } },
    ]) {
      const malformed = event();
      Object.assign(malformed.routingEvidence!, patch);
      expect(() => getRoadConditionRoutingDecision(malformed, { evaluatedAt: now })).not.toThrow();
      expect(getRoadConditionRoutingDecision(malformed, { evaluatedAt: now }).eligible).toBe(false);
    }
  });

  it("rejects any restriction evidence, including an all-vehicle claim", () => {
    const evaluatedAt = Date.parse("2026-09-11T12:00:00Z");
    const eligibleControl = event();
    expect(getRoadConditionRoutingDecision(eligibleControl, { evaluatedAt }).eligible).toBe(true);

    const unsupported = readRoadRestrictionDetails({ restrictionDetails: { schemaVersion: 2 } });
    expect(unsupported).toEqual({ restrictionDetailsUnsupported: true });
    expect(
      getRoadConditionRoutingDecision(
        { ...eligibleControl, ...unsupported, routingEligible: true },
        { evaluatedAt },
      ),
    ).toMatchObject({ eligible: false, reasons: ["vehicle_specific_restriction"] });

    const valid = readRoadRestrictionDetails({ restrictionDetails: publishedRestriction() });
    expect(valid.restrictionDetails).toBeDefined();
    expect(
      getRoadConditionRoutingDecision(
        // A legacy "all traffic" claim cannot override restriction evidence.
        { ...eligibleControl, ...valid },
        { evaluatedAt },
      ),
    ).toMatchObject({ eligible: false, reasons: ["vehicle_specific_restriction"] });

    // An empty-but-declared partial envelope is still evidence.
    const partial = readRoadRestrictionDetails({
      restrictionDetails: {
        ...publishedRestriction(),
        facts: [],
        vehicleScope: "unknown",
        completeness: "partial",
        issues: [{ code: "unsupported_type", factId: null, sourcePath: "restrictions[0]" }],
      },
    });
    expect(
      getRoadConditionRoutingDecision({ ...eligibleControl, ...partial }, { evaluatedAt }).eligible,
    ).toBe(false);
  });
});
