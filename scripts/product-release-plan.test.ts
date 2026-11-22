import { describe, expect, it } from "vitest";
import { nth } from "./fixtures/nth";
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
  it.each(["producer", "buildMetadata"])("requires durable %s evidence", (field) => {
    const input = fixture();
    delete (input.producerManifest as Record<string, unknown>)[field];
    expect(() => release.planProductRelease(input)).toThrow();
  });
  it.each([
    undefined,
    null,
    "",
    "tomorrow",
    "2026-10-18",
    "2026-10-18T10:00Z",
    "2026-10-18T10:00:00",
    "2026-10-18T10:00:00+0200",
    "2026-10-18T24:00:00Z",
    "2026-02-31T12:00:00Z",
  ])("rejects build metadata whose cold-refresh date is %s", (coldRefreshedAt) => {
    const input = fixture();
    const images = input.producerManifest.buildMetadata.images as Record<
      string,
      Record<string, unknown>
    >;
    const api = images.api;
    if (!api) throw new Error("The fixture has no api build metadata");
    if (coldRefreshedAt === undefined) delete api.coldRefreshedAt;
    else api.coldRefreshedAt = coldRefreshedAt;
    expect(() => release.planProductRelease(input)).toThrow(
      "Missing actual build metadata for api",
    );
  });
  it.each(["2026-10-18T10:00:00Z", "2026-10-18T10:00:00.123456Z", "2026-10-18T12:00:00+02:00"])(
    "accepts a cold-refresh date of %s",
    (coldRefreshedAt) => {
      const input = fixture();
      const images = input.producerManifest.buildMetadata.images as Record<
        string,
        Record<string, unknown>
      >;
      const api = images.api;
      if (!api) throw new Error("The fixture has no api build metadata");
      api.coldRefreshedAt = coldRefreshedAt;
      expect(() => release.planProductRelease(input)).not.toThrow();
    },
  );
  it("rejects skipped producer jobs and unapproved images", () => {
    const input = fixture();
    const producer = nth(input.jobs, 1);
    producer.conclusion = "skipped";
    expect(() => release.planProductRelease(input)).toThrow();
    producer.conclusion = "success";
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

describe("readiness evidence", () => {
  const digest = `sha256:${"e".repeat(64)}`;
  function readinessFor(candidate: ReturnType<typeof release.planProductRelease>) {
    return {
      schemaVersion: 1,
      candidateHash: release.candidateHash(candidate),
      candidateManifestDigest: digest,
      environment: "synthetic fixture only",
      platform: "linux/amd64",
      testedAt: "2026-10-18T10:00:00Z",
      checks: Object.fromEntries(
        release.readinessChecks
          .filter((name: string) => name !== "upgrade")
          .map((name: string) => [
            name,
            { passed: true, evidence: `https://example.invalid/synthetic/${name}` },
          ]),
      ) as Record<string, { passed: boolean; evidence: string }>,
      limitations: ["Synthetic; no runtime acceptance"],
      immutableReleases: {
        enabled: true,
        repository: candidate.repository,
        candidateHash: release.candidateHash(candidate),
        checkedBy: "synthetic-owner",
        checkedAt: "2026-10-18T10:00:00Z",
        evidence: "https://example.invalid/synthetic/settings",
      },
    } as Record<string, unknown> & { checks: Record<string, unknown> };
  }

  it("needs no upgrade rehearsal for a clean-installation-only release", () => {
    const candidate = release.planProductRelease(fixture());
    expect(candidate.manifest.product.upgradeOrigins).toEqual([]);
    const readiness = readinessFor(candidate);
    expect(release.validateReadiness(readiness, candidate, digest)).toBe(readiness);
    expect(() =>
      release.validateReadiness({ ...readiness, upgradeOrigin: "prebaseline" }, candidate, digest),
    ).toThrow(/upgrade evidence/);
  });

  it("requires an upgrade rehearsal from a declared origin", () => {
    const input = fixture();
    input.configuration.upgradeOrigins = ["v0.1.0-alpha.1"];
    const candidate = release.planProductRelease(input);
    const readiness = readinessFor(candidate);
    expect(() => release.validateReadiness(readiness, candidate, digest)).toThrow(
      /upgrade evidence/,
    );
    readiness.upgradeOrigin = "v0.1.0-alpha.1";
    expect(() => release.validateReadiness(readiness, candidate, digest)).toThrow(
      "Missing rehearsal evidence: upgrade",
    );
    readiness.checks.upgrade = { passed: true, evidence: "https://example.invalid/upgrade" };
    expect(release.validateReadiness(readiness, candidate, digest)).toBe(readiness);
  });
});

it("requires the literal registry hostname rather than a regex wildcard match", () => {
  const input = fixture();
  input.producerManifest.images.api = `ghcrXio/openmapx/api@sha256:${"b".repeat(64)}`;
  expect(() => release.planProductRelease(input)).toThrow(/Unapproved api/);
});
