import { describe, expect, it } from "vitest";
import * as releases from "../release-manifest";

const digest = `sha256:${"a".repeat(64)}`;
describe("explicit release selection", () => {
  it.each(["main", "preview", "v0.1.0-alpha.1", digest])(
    "resolves %s in the configured namespace",
    (selector) => {
      expect(
        releases.normalizeReleaseSelection(selector, "registry.example/team/release-manifest"),
      ).toMatchObject({
        kind: selector.startsWith("v")
          ? "version"
          : selector.startsWith("sha256:")
            ? "digest"
            : selector,
        manifestImage: `registry.example/team/release-manifest${selector.startsWith("sha256:") ? "@" : ":"}${selector}`,
        imagePrefix: "registry.example/team",
      });
    },
  );
  it("defaults to main and permits only explicit local opt-out", () => {
    expect(releases.normalizeReleaseSelection()).toMatchObject({
      kind: "main",
      manifestImage: "ghcr.io/openmapx/release-manifest:main",
    });
    expect(releases.normalizeReleaseSelection("local")).toEqual({ kind: "local" });
  });
  it.each(["", "latest", "stable", "v0.1.0", "v0.1.0-alpha.01", "main;whoami", "sha256:bad"])(
    "rejects unsupported selector %j",
    (selector) => {
      expect(() => releases.normalizeReleaseSelection(selector)).toThrow();
    },
  );
  it.each([
    "ghcr.io/team/release-manifest:main",
    "https://registry.example/team/release-manifest",
    "ghcr.io/team/../release-manifest",
    "ghcr.io/team/other",
  ])("rejects ambiguous repository %s", (repository) => {
    expect(() => releases.normalizeReleaseSelection("preview", repository)).toThrow();
  });
  it("freezes one pull digest and rejects missing or ambiguous output", () => {
    expect(
      releases.releaseDigestFromPull(`Digest: ${digest}\nStatus: Downloaded newer image`),
    ).toBe(digest);
    expect(() => releases.releaseDigestFromPull("downloaded")).toThrow();
    expect(() =>
      releases.releaseDigestFromPull(`Digest: ${digest}\nDigest: sha256:${"b".repeat(64)}`),
    ).toThrow();
  });
});

const manifest = {
  schemaVersion: 1 as const,
  release: `${"a".repeat(40)}-123`,
  images: Object.fromEntries(
    releases.RELEASE_IMAGE_NAMES.map((name) => [name, `ghcr.io/openmapx/${name}@${digest}`]),
  ) as releases.ReleaseManifest["images"],
  privacyReleaseValidation: {
    version: 1 as const,
    sourceBuildFingerprint: "b".repeat(64),
    validatedAt: "2026-10-18T10:00:00Z",
    checks: {
      translationsConsistent: true as const,
      openApiConsistent: true as const,
      policyConsistent: true as const,
    },
  },
};
it("retains producer and actual reused image metadata in canonical authority", () => {
  const input = {
    ...manifest,
    producer: {
      repository: "OpenMapX/openmapx",
      workflowPath: ".github/workflows/ci.yml" as const,
      sourceRevision: "a".repeat(40),
      runId: 123,
      runAttempt: 1,
      event: "push" as const,
    },
    buildMetadata: {
      version: 1 as const,
      images: {
        api: {
          sourceRevision: "c".repeat(40),
          inputHash: "d".repeat(64),
          builtAt: "2026-10-17T10:00:00Z",
        },
      },
    },
  };
  expect(
    JSON.parse(
      releases.canonicalReleaseManifest(releases.parseReleaseManifest(JSON.stringify(input))),
    ),
  ).toEqual(input);
  expect(
    releases.canonicalReleaseManifest(releases.parseReleaseManifest(JSON.stringify(manifest))),
  ).toBe(JSON.stringify(manifest));
});
it("rejects selected named versions when the registry returns a different release", () => {
  expect(() =>
    releases.validateResolvedSelection(
      releases.normalizeReleaseSelection("v0.1.0-alpha.1"),
      manifest,
      digest,
    ),
  ).toThrow(/version/);
  expect(() =>
    releases.validateResolvedSelection(
      releases.normalizeReleaseSelection(`sha256:${"b".repeat(64)}`),
      manifest,
      digest,
    ),
  ).toThrow(/digest/);
});

it("keeps producerless legacy build metadata from changing a previously stored canonical identity", () => {
  const legacy = {
    ...manifest,
    buildMetadata: {
      version: 1 as const,
      images: {
        api: {
          sourceRevision: "c".repeat(40),
          inputHash: "d".repeat(64),
          builtAt: "2026-10-17T10:00:00Z",
        },
      },
    },
  };
  // The previous serializer stored these bytes, omitting then non-authoritative metadata.
  expect(
    releases.canonicalReleaseManifest(releases.parseReleaseManifest(JSON.stringify(legacy))),
  ).toBe(JSON.stringify(manifest));
});
