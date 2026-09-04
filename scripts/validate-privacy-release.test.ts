import { describe, expect, it, vi } from "vitest";
import { validatePrivacyRelease } from "./validate-privacy-release.mjs";

describe("privacy release validation evidence", () => {
  it("rejects evidence when source changes while checks run", async () => {
    const fingerprints = ["a".repeat(64), "b".repeat(64)];
    const runCheck = vi.fn(async () => true);

    await expect(
      validatePrivacyRelease({
        fingerprint: async () => fingerprints.shift() ?? "b".repeat(64),
        runCheck,
      }),
    ).rejects.toThrow("source changed while validation was running");
    expect(runCheck).toHaveBeenCalledTimes(3);
  });

  it("returns exact evidence only after all checks pass on unchanged source", async () => {
    const result = await validatePrivacyRelease({
      fingerprint: async () => "c".repeat(64),
      runCheck: async () => true,
    });

    expect(result.sourceBuildFingerprint).toBe("c".repeat(64));
    expect(result.checks).toEqual({
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    });
  });
});
