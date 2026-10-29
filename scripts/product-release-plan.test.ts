import { describe, expect, it } from "vitest";
import { fixture } from "./product-release.fixtures";
import { readProductReleaseConfig } from "./product-release-config.mjs";
import * as release from "./product-release-plan.mjs";

describe("named product candidate", () => {
  it("binds an eligible older producer without replacing it with current main", () => {
    const input = fixture();
    const candidate = release.planProductRelease(input);
    expect(candidate.manifest.release).toBe("v0.1.0-alpha.1");
    expect(candidate.manifest.images).toEqual(input.producerManifest.images);
    expect(candidate.manifest.product.sourceRelease).toBe(`${"a".repeat(40)}-123-2`);
    expect(release.candidateHash(candidate)).toBe(
      release.candidateHash(JSON.parse(release.canonicalCandidate(candidate))),
    );
    expect(candidate).not.toHaveProperty("createdAt");
  });
  it.each([
    "repository",
    "path",
    "head_branch",
    "head_sha",
    "run_attempt",
    "status",
    "conclusion",
    "event",
  ])("rejects ineligible producer %s", (field) => {
    const input = fixture();
    (input.run as Record<string, unknown>)[field] = field === "run_attempt" ? 3 : "untrusted";
    expect(() => release.planProductRelease(input)).toThrow();
  });
  it.each(["producer", "buildMetadata", "privacyReleaseValidation"])(
    "requires durable %s evidence",
    (field) => {
      const input = fixture();
      delete (input.producerManifest as Record<string, unknown>)[field];
      expect(() => release.planProductRelease(input)).toThrow();
    },
  );
  it("rejects skipped producer jobs and unapproved images", () => {
    const input = fixture();
    input.jobs[1].conclusion = "skipped";
    expect(() => release.planProductRelease(input)).toThrow();
    input.jobs[1].conclusion = "success";
    input.producerManifest.images.api = `evil.invalid/api@sha256:${"b".repeat(64)}`;
    expect(() => release.planProductRelease(input)).toThrow();
  });
  it.each(["0.1.0", "0.1.0-alpha.01", "1.2.3-beta.2;evil"])(
    "rejects unsupported version %s",
    (version) => {
      expect(() =>
        readProductReleaseConfig(JSON.stringify({ ...fixture().configuration, version })),
      ).toThrow();
    },
  );
  it("orders prerelease stages and counters numerically", () => {
    expect(release.compareProductVersions("v0.1.0-alpha.10", "v0.1.0-alpha.9")).toBeGreaterThan(0);
    expect(release.compareProductVersions("v0.1.0-beta.1", "v0.1.0-alpha.99")).toBeGreaterThan(0);
  });
});

it("requires the literal registry hostname rather than a regex wildcard match", () => {
  const input = fixture();
  input.producerManifest.images.api = `ghcrXio/openmapx/api@sha256:${"b".repeat(64)}`;
  expect(() => release.planProductRelease(input)).toThrow(/Unapproved api/);
});
