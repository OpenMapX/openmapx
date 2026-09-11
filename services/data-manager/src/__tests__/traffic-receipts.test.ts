import { describe, expect, it } from "vitest";
import { buildTrafficReceipts } from "../jobs/traffic/receipts.js";
import { event } from "./fixtures/road-condition.js";

describe("actuation receipts", () => {
  it("requires every mapped span, an accepted writer result and fresh evidence", () => {
    const e = event();
    const conditions = [
      {
        id: e.id,
        source: e.source,
        routingEvidence: e.routingEvidence,
        originKind: "feed",
        routingEligible: true,
      },
    ] as Parameters<typeof buildTrafficReceipts>[0]["conditions"];
    const options = {
      conditions,
      overrides: new Map([
        [
          "2:1:0",
          {
            closed: true as const,
            observationId: e.id,
            contributorIds: [e.id],
            edge: { level: 2, tile: 1, index: 0, forward: true },
          },
        ],
      ]),
      appliedObservationIds: [e.id],
      graphGeneration: "host-graph",
      policyRevision: "policy-1",
      validUntil: "2026-09-11T12:01:00Z",
      evaluatedAt: Date.parse("2026-09-11T12:00:00Z"),
    };
    expect(buildTrafficReceipts(options)[0]).toMatchObject({
      observationId: e.id,
      complete: true,
      policyRevision: "policy-1",
      edgeKeys: ["2:1:0"],
    });
    expect(buildTrafficReceipts({ ...options, appliedObservationIds: [] })).toEqual([]);
    expect(
      buildTrafficReceipts({ ...options, evaluatedAt: Date.parse("2026-09-11T12:02:00Z") }),
    ).toEqual([]);
  });
});
