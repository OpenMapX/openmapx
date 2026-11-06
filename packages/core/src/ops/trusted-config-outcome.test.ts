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
      publisherCleanupFailed: false,
      registryUpdateFailed: false,
    });
    expect(completeTrustedConfigurationApply(value)).toBe(false);
    expect(() =>
      parseTrustedConfigurationApplyOutcome({ ...value, secret: "not accepted" }),
    ).toThrow();
    expect(() => parseTrustedConfigurationApplyOutcome({ outcome: "committed" })).toThrow();
  });
});
