import { describe, expect, it } from "vitest";
import { assertApprovalSeparation, type ReadinessApproval } from "./readiness.js";
import { privacyImplementationActorIds } from "./release-identity.js";

const approval: ReadinessApproval = {
  scope: "security-review",
  version: "review",
  approverUserId: "implementer",
  approverRole: "admin",
  decision: "approved",
  findingsDigest: null,
  reviewedAt: "2026-09-05T00:00:00Z",
  expiresAt: "2026-10-05T00:00:00Z",
};
describe("release approval independence", () => {
  it("requires explicit implementation owners rather than treating a deployment ID as a person", () => {
    expect(privacyImplementationActorIds({ OPENMAPX_DEPLOYMENT_ID: "deployment" })).toEqual([]);
    expect(
      privacyImplementationActorIds({
        PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS: "alice, bob,alice",
      }),
    ).toEqual(["alice", "bob"]);
    expect(
      privacyImplementationActorIds({
        PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS: "alice,\nmalformed",
      }),
    ).toEqual([]);
  });
  it("rejects self approval for every release scope", () => {
    for (const scope of ["legal-content", "dsar-process", "security-review"] as const) {
      expect(() => assertApprovalSeparation({ ...approval, scope }, "implementer")).toThrow(
        "separation",
      );
    }
  });
});
