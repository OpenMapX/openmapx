import { describe, expect, it } from "vitest";
import { releaseProvenance } from "../__fixtures__/release-provenance";
import {
  canonicalReleaseManifest,
  parseReleaseManifest,
  RELEASE_STATE_EPOCH,
  type ReleaseManifest,
  ReleaseStateEpochError,
  releaseChannel,
  releaseManifestDigest,
  releaseServiceImages,
} from "../release-manifest";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const manifest: ReleaseManifest = {
  schemaVersion: 1,
  release: "abc123",
  images: {
    api: `ghcr.io/openmapx/api@${digest("a")}`,
    web: `ghcr.io/openmapx/web@${digest("b")}`,
    "data-manager": `ghcr.io/openmapx/data-manager@${digest("c")}`,
    "ops-agent": `ghcr.io/openmapx/ops-agent@${digest("d")}`,
    "transitous-runner": `ghcr.io/openmapx/transitous-runner@${digest("e")}`,
  },
  ...releaseProvenance(),
};

describe("shared release manifest", () => {
  it("accepts a run-qualified mixed release and keeps its exact reused digests", () => {
    const mixed = {
      ...manifest,
      release: `${"a".repeat(40)}-123-2`,
      buildMetadata: {
        version: 1,
        images: {
          api: {
            sourceRevision: "b".repeat(40),
            inputHash: "c".repeat(64),
            builtAt: "2026-09-05T12:00:00.000Z",
            coldRefreshedAt: "2026-09-05T12:00:00.000Z",
          },
        },
      },
    };
    const parsed = parseReleaseManifest(JSON.stringify(mixed));
    expect(parsed).toEqual(mixed);
    expect(releaseServiceImages(parsed).api).toBe(manifest.images.api);
    expect(releaseServiceImages(parsed)["ops-agent"]).toBe(manifest.images["ops-agent"]);
  });

  it("requires the release's database migration head and carries it into canonical bytes", () => {
    const head = { tag: "0064_configuration_fence_drop_certificate", when: 1794754360788 };
    const withHead = { ...manifest, databaseMigrationHead: head };
    expect(parseReleaseManifest(JSON.stringify(withHead)).databaseMigrationHead).toEqual(head);
    expect(JSON.parse(canonicalReleaseManifest(withHead)).databaseMigrationHead).toEqual(head);
    for (const invalid of [
      undefined,
      { tag: "latest", when: 1 },
      { tag: head.tag, when: -1 },
      { tag: head.tag },
    ])
      expect(() =>
        parseReleaseManifest(JSON.stringify({ ...manifest, databaseMigrationHead: invalid })),
      ).toThrow(/databaseMigrationHead/);
  });

  it("writes later top-level fields sorted by code unit, whatever order they arrive in", () => {
    const later = (fields: Record<string, unknown>) =>
      canonicalReleaseManifest(parseReleaseManifest(JSON.stringify({ ...manifest, ...fields })));
    // A later release that added `b`, then a still later one that added `a` and `Z`.
    const added = later({ b: 2, a: 1, Z: 0 });
    expect(added).toBe(later({ Z: 0, a: 1, b: 2 }));
    expect(Object.keys(JSON.parse(added)).slice(-3)).toEqual(["Z", "a", "b"]);
    expect(releaseManifestDigest(JSON.parse(added) as ReleaseManifest)).toBe(
      releaseManifestDigest(parseReleaseManifest(added)),
    );
  });

  it("refuses a release of another state epoch with a message the operator can act on", () => {
    expect(RELEASE_STATE_EPOCH).toBe(1);
    expect(JSON.parse(canonicalReleaseManifest(manifest)).stateEpoch).toBe(RELEASE_STATE_EPOCH);
    for (const invalid of [undefined, 0, 1.5, "1"])
      expect(() =>
        parseReleaseManifest(JSON.stringify({ ...manifest, stateEpoch: invalid })),
      ).toThrow(/stateEpoch/);
    let refused: unknown;
    try {
      parseReleaseManifest(JSON.stringify({ ...manifest, stateEpoch: 2 }));
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ReleaseStateEpochError);
    expect((refused as Error).message).toBe(
      "Release abc123 uses installation state epoch 2, and this installation uses epoch 1. It cannot be applied in place; follow that release's notes to install it fresh.",
    );
  });

  it("reads display metadata loosely, so a later release may change it", () => {
    const later = {
      ...manifest,
      release: "v1.0.0",
      producer: {
        repository: "openmapx/openmapx",
        workflowPath: ".github/workflows/release.yml",
        event: "workflow_dispatch",
        signer: { kind: "sigstore" },
      },
      buildMetadata: { version: 2, images: {}, sbom: "attached" },
      product: {
        version: "1.0.0",
        compatibility: { platforms: ["linux/amd64", "linux/arm64"] },
        channel: "stable",
      },
    };
    const parsed = parseReleaseManifest(JSON.stringify(later));
    expect(parsed).toEqual(later);
    expect(JSON.parse(canonicalReleaseManifest(parsed))).toMatchObject({
      producer: later.producer,
      buildMetadata: later.buildMetadata,
      product: later.product,
    });
    for (const [field, value] of [
      ["producer", "openmapx"],
      ["buildMetadata", null],
      ["product", { version: "1.0" }],
    ] as const)
      expect(() => parseReleaseManifest(JSON.stringify({ ...later, [field]: value }))).toThrow(
        field,
      );
    expect(() =>
      parseReleaseManifest(JSON.stringify({ ...later, product: { version: "1.0.1" } })),
    ).toThrow(/product version/);
  });

  it("keeps a top-level field a later release adds, so the stored copy keeps its digest", () => {
    const later = { ...manifest, signing: { z: 1, a: "sigstore" }, channel: "stable" };
    const parsed = parseReleaseManifest(JSON.stringify(later));
    const canonical = canonicalReleaseManifest(parsed);
    expect(JSON.parse(canonical)).toMatchObject({
      channel: "stable",
      signing: { a: "sigstore", z: 1 },
    });
    expect(canonical.indexOf('"channel"')).toBeLessThan(canonical.indexOf('"signing"'));
    const reread = parseReleaseManifest(canonical);
    expect(canonicalReleaseManifest(reread)).toBe(canonical);
    expect(releaseManifestDigest(reread)).toBe(releaseManifestDigest(parsed));
  });

  it("parses an approved manifest and rejects tag references", () => {
    expect(parseReleaseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(() =>
      parseReleaseManifest(
        JSON.stringify({
          ...manifest,
          images: { ...manifest.images, api: "ghcr.io/openmapx/api:latest" },
        }),
      ),
    ).toThrow(/images\.api/);
  });

  it("pins only the five release images and no privacy collector or validation evidence", () => {
    expect(Object.keys(manifest.images)).toHaveLength(5);
    expect(Object.keys(releaseServiceImages(manifest))).toHaveLength(5);
    expect(canonicalReleaseManifest(manifest)).not.toMatch(/privacy/i);
  });
});

describe("release channel", () => {
  it("defaults to the OpenMapX registry and derives the approved prefix from an override", () => {
    expect(releaseChannel(undefined)).toMatchObject({
      kind: "enabled",
      manifestImage: "ghcr.io/openmapx/release-manifest:main",
      imagePrefix: "ghcr.io/openmapx",
    });
    expect(releaseChannel("preview", "registry.example.org/fork/release-manifest")).toMatchObject({
      kind: "enabled",
      manifestImage: "registry.example.org/fork/release-manifest:preview",
      imagePrefix: "registry.example.org/fork",
    });
    expect(releaseChannel("local")).toEqual({ kind: "disabled" });
    expect(() => releaseChannel("release-manifest")).toThrow();
  });

  it("validates manifest images against the configured prefix", () => {
    const forked = {
      ...manifest,
      images: Object.fromEntries(
        Object.entries(manifest.images).map(([name, image]) => [
          name,
          image.replace("ghcr.io/openmapx", "registry.example.org/fork"),
        ]),
      ),
    };
    expect(parseReleaseManifest(JSON.stringify(forked), "registry.example.org/fork")).toEqual(
      forked,
    );
    expect(() => parseReleaseManifest(JSON.stringify(forked))).toThrow(
      "not an approved immutable reference under ghcr.io/openmapx",
    );
    expect(() =>
      parseReleaseManifest(JSON.stringify(manifest), "registry.example.org/fork"),
    ).toThrow(/not an approved/);
  });
});

describe("release lockfile image contract and selection", () => {
  it.each([`ghcr.io/openmapx/docs@${digest("1")}`, "ghcr.io/openmapx/docs:latest"])(
    "strips unrelated image fields from parsed and canonical releases (%s)",
    (docs) => {
      const input = { ...manifest, images: { ...manifest.images, docs, unrelated: null } };
      expect(parseReleaseManifest(JSON.stringify(input))).toEqual(manifest);
      expect(canonicalReleaseManifest(input)).toBe(JSON.stringify(manifest));
    },
  );
});
