import { describe, expect, it } from "vitest";
import {
  completeTrustedConfigurationApply,
  parseTrustedConfigurationApplyOutcome,
} from "./trusted-config-outcome";

describe("shared trusted configuration outcome", () => {
  it("preserves explicit transport uncertainty and refuses incomplete outcomes", () => {
    const value = parseTrustedConfigurationApplyOutcome({
      outcome: "unknown",
      reason: "transport_or_result",
      registryUpdateFailed: false,
    });
    expect(completeTrustedConfigurationApply(value)).toBe(false);
    expect(() =>
      parseTrustedConfigurationApplyOutcome({ ...value, secret: "not accepted" }),
    ).toThrow();
    expect(() => parseTrustedConfigurationApplyOutcome({ outcome: "committed" })).toThrow();
  });

  it("keeps the required settings a failed apply names, only beside its problem", () => {
    const failed = {
      outcome: "not_committed",
      reason: "failed",
      cleanupFailed: false,
      registryUpdateFailed: false,
      problem: "Required service settings have no value: ingest (API_TOKEN).",
      missingSettings: [{ serviceId: "ingest", keys: ["API_TOKEN"] }],
    };
    expect(parseTrustedConfigurationApplyOutcome(failed)).toEqual(failed);
    const { problem: _problem, ...withoutProblem } = failed;
    expect(() => parseTrustedConfigurationApplyOutcome(withoutProblem)).toThrow();
    expect(() =>
      parseTrustedConfigurationApplyOutcome({ ...failed, missingSettings: [{ serviceId: "x" }] }),
    ).toThrow();
  });
});
