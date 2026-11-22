import { describe, expect, it } from "vitest";
import { releaseProvenance } from "../__fixtures__/release-provenance";
import {
  canonicalReleaseManifest,
  parseReleaseManifest,
  type ReleaseManifest,
  releaseChannel,
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

  it("carries the release's database migration head through parsing and canonical bytes", () => {
    const head = { tag: "0064_configuration_fence_drop_certificate", when: 1794754360788 };
    const withHead = { ...manifest, databaseMigrationHead: head };
    expect(parseReleaseManifest(JSON.stringify(withHead)).databaseMigrationHead).toEqual(head);
    expect(JSON.parse(canonicalReleaseManifest(withHead)).databaseMigrationHead).toEqual(head);
    expect(canonicalReleaseManifest(manifest)).not.toContain("databaseMigrationHead");
    for (const invalid of [
      { tag: "latest", when: 1 },
      { tag: head.tag, when: -1 },
      { tag: head.tag },
    ])
      expect(() =>
        parseReleaseManifest(JSON.stringify({ ...manifest, databaseMigrationHead: invalid })),
      ).toThrow(/databaseMigrationHead/);
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
