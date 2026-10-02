import { describe, expect, it } from "vitest";
import { buildTrafficReceipts } from "../jobs/traffic/receipts.js";
import { boundCondition, speedLimit } from "./fixtures/road-condition.js";

const edge = { level: 2, tile: 1, index: 0, forward: true };

function options(condition = boundCondition()) {
  return {
    conditions: [condition],
    overrides: new Map([
      [
        "2:1:0",
        condition.effect.kind === "closure"
          ? {
              closed: true as const,
              observationId: condition.id,
              contributorIds: [condition.id],
              edge,
            }
          : {
              closed: false as const,
              capKph: 40,
              observationId: condition.id,
              contributorIds: [condition.id],
              edge,
            },
      ],
    ]),
    appliedObservationIds: [condition.id],
    graphGeneration: "host-graph",
    policyRevision: "policy-1",
    validUntil: "2026-09-11T12:01:00Z",
    evaluatedAt: Date.parse("2026-09-11T12:00:00Z"),
  };
}

describe("actuation receipts", () => {
  it("requires every mapped span, an accepted writer result and fresh evidence", () => {
    const c = boundCondition();
    expect(buildTrafficReceipts(options(c))[0]).toMatchObject({
      observationId: c.id,
      observationRevision: "1",
      sourceId: "fr",
      sourceGraphGeneration: "g1",
      effect: "closure",
      complete: true,
      policyRevision: "policy-1",
      edgeKeys: ["2:1:0"],
      intendedSpans: c.routingEvidence.segments,
    });
    expect(buildTrafficReceipts({ ...options(c), appliedObservationIds: [] })).toEqual([]);
    expect(
      buildTrafficReceipts({ ...options(c), evaluatedAt: Date.parse("2026-09-11T12:02:00Z") }),
    ).toEqual([]);
  });

  it("keys a receipt by effect and names the effect the writer applied", () => {
    const cap = boundCondition({}, speedLimit(40));
    expect(cap.id).toBe("oc:situation:fr:1#fr1/speed_limit");
    expect(buildTrafficReceipts(options(cap))[0]).toMatchObject({
      observationId: cap.id,
      effect: "speed_cap",
    });
  });

  it("issues no receipt for an effect whose evidence no longer routes", () => {
    const c = boundCondition();
    c.routingEvidence = { ...c.routingEvidence, binding_revision: 2 };
    expect(buildTrafficReceipts(options(c))).toEqual([]);
  });
});
