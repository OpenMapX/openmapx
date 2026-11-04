import { describe, expect, it } from "vitest";
import { migrationCompletionResult } from "./completion";

const application = {
  outcome: "committed" as const,
  revisionId: `cfg1_${"r".repeat(43)}`,
  enabledServiceIds: ["motis"],
  followUp: "complete" as const,
  cleanupFailed: false,
  publisherCleanupFailed: false,
  registryUpdateFailed: false,
};
describe("migration completion", () => {
  it("preserves captured disabled services and pending auth after a recovered apply", () => {
    expect(
      migrationCompletionResult({
        operationId: "original-job",
        application,
        steps: [
          { scope: "service-config", id: "disabled", status: "pending" },
          { scope: "service-secret", id: "motis", status: "pending" },
          { scope: "integration-config", id: "alpha", status: "pending" },
          { scope: "pending-auth", id: "registrationEnabled", status: "pending" },
        ],
        pendingServiceIds: ["disabled"],
      }),
    ).toEqual({
      operationId: "original-job",
      outcome: "partial",
      steps: [
        { scope: "service-config", id: "disabled", status: "pending" },
        { scope: "service-secret", id: "motis", status: "applied" },
        { scope: "integration-config", id: "alpha", status: "applied" },
        { scope: "pending-auth", id: "registrationEnabled", status: "pending" },
      ],
    });
  });
  it("does not infer activation when an older checkpoint omitted the captured classification", () => {
    expect(
      migrationCompletionResult({
        operationId: "original-job",
        application,
        steps: [{ scope: "service-secret", id: "disabled", status: "pending" }],
      }),
    ).toEqual({
      operationId: "original-job",
      outcome: "unknown",
      steps: [{ scope: "service-secret", id: "disabled", status: "unknown" }],
    });
  });
});
