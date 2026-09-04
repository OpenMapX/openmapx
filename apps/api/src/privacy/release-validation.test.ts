import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPrivacyReleaseValidationChecks } from "./release-validation.js";

describe("privacy release validation evidence", () => {
  it("accepts only machine checks bound to the exact source build fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmapx-release-validation-"));
    const path = join(root, "validation.json");
    const sourceBuildFingerprint = "a".repeat(64);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        sourceBuildFingerprint,
        validatedAt: "2026-09-05T12:00:00Z",
        checks: {
          translationsConsistent: true,
          openApiConsistent: true,
          policyConsistent: true,
        },
      }),
    );
    expect(await loadPrivacyReleaseValidationChecks(path, sourceBuildFingerprint)).toEqual({
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    });
    expect(await loadPrivacyReleaseValidationChecks(path, "b".repeat(64))).toEqual({
      translationsConsistent: false,
      openApiConsistent: false,
      policyConsistent: false,
    });
  });

  it("fails closed for a missing evidence file", async () => {
    expect(
      await loadPrivacyReleaseValidationChecks(
        "/definitely/missing/openmapx-validation.json",
        "a".repeat(64),
      ),
    ).toEqual({
      translationsConsistent: false,
      openApiConsistent: false,
      policyConsistent: false,
    });
  });
});
