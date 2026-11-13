import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { releaseProvenance } from "../__fixtures__/release-provenance";
import {
  canonicalReleaseManifest,
  parseReleaseComposeSelection,
  parseReleaseManifest,
  type ReleaseManifest,
  releaseChannel,
  renderReleaseCompose,
  transitousToolsImageFromReleaseCompose,
  writeReleaseComposeArtifacts,
} from "../release-manifest";
import { releaseStatePaths } from "../release-state";

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
    "transitous-tools": `ghcr.io/openmapx/transitous-tools@${digest("f")}`,
  },
  ...releaseProvenance(),
};

describe("shared release manifest", () => {
  it("accepts a run-qualified mixed release and renders its exact reused digests", () => {
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
    const overlay = renderReleaseCompose(parsed);
    expect(overlay).toContain(`image: ${manifest.images.api}`);
    expect(overlay).toContain(`image: ${manifest.images["ops-agent"]}`);
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

  it("pins only the six release images and no privacy collector or validation evidence", () => {
    expect(Object.keys(manifest.images)).toHaveLength(6);
    const rendered = renderReleaseCompose(manifest);
    const overlay = load(rendered) as {
      services: Record<string, { environment?: Record<string, string>; configs?: unknown[] }>;
      configs?: unknown;
    };
    expect(overlay.configs).toBeUndefined();
    expect(overlay.services["app-api"]).toEqual({ image: manifest.images.api });
    expect(overlay.services["ops-agent"]).toEqual({ image: manifest.images["ops-agent"] });
    expect(rendered).not.toMatch(/privacy/i);
    expect(canonicalReleaseManifest(manifest)).not.toMatch(/privacy/i);
  });

  it("writes a private release overlay", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-release-artifacts-"));
    try {
      const overlayPath = join(
        root,
        "state",
        "ops-agent",
        "releases",
        "docker-compose.release.yml",
      );
      expect(writeReleaseComposeArtifacts(manifest, root)).toEqual({ overlayPath });
      expect(lstatSync(releaseStatePaths(root).directory).mode & 0o777).toBe(0o700);
      const overlay = openSync(overlayPath, "r");
      try {
        expect(fstatSync(overlay).mode & 0o777).toBe(0o600);
        expect(readFileSync(overlay, "utf8")).toBe(renderReleaseCompose(manifest));
      } finally {
        closeSync(overlay);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces the overlay atomically when another release is selected", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-release-artifacts-"));
    try {
      const { overlayPath } = writeReleaseComposeArtifacts(manifest, root);
      const next = { ...manifest, release: "def456" };
      writeReleaseComposeArtifacts(next, root);
      expect(readFileSync(overlayPath, "utf8")).toBe(renderReleaseCompose(next));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("round trips selected identity and six images, including quoted release IDs", () => {
    const selected = { ...manifest, release: "release-test" };
    const images = manifest.images;
    const rendered = renderReleaseCompose(selected);
    expect(parseReleaseComposeSelection(rendered)).toEqual({ release: selected.release, images });
    expect(transitousToolsImageFromReleaseCompose(rendered)).toBe(images["transitous-tools"]);
    expect(transitousToolsImageFromReleaseCompose("services: {}\n")).toBeNull();
    expect(rendered).not.toContain("ghcr.io/openmapx/docs");
  });

  it("reads legacy service pins without inventing a release identity", () => {
    expect(
      parseReleaseComposeSelection(`services:
  app-api:
    image: ${manifest.images.api}
`),
    ).toEqual({
      release: null,
      images: { api: manifest.images.api },
    });
    expect(() => parseReleaseComposeSelection("services: [")).toThrow();
    expect(() => parseReleaseComposeSelection("hello")).toThrow();
  });
});

it("does not attribute a modified service pin to stale release metadata", () => {
  const rendered = renderReleaseCompose(manifest).replace(
    `image: ${manifest.images.api}`,
    `image: ghcr.io/openmapx/api@${digest("0")}`,
  );
  const selected = parseReleaseComposeSelection(rendered);
  expect(selected.release).toBeNull();
  expect(selected.images.api).toBe(`ghcr.io/openmapx/api@${digest("0")}`);
});
