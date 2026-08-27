import { describe, expect, it } from "vitest";
import {
  parseReleaseManifest,
  type ReleaseManifest,
  releaseChannel,
  renderReleaseCompose,
  transitousToolsImageFromReleaseCompose,
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
    "transitous-tools": `ghcr.io/openmapx/transitous-tools@${digest("f")}`,
    docs: `ghcr.io/openmapx/docs@${digest("1")}`,
  },
};

describe("shared release manifest", () => {
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

  it("round-trips the transitous-tools pin through the rendered overlay", () => {
    const overlay = renderReleaseCompose(manifest);
    expect(transitousToolsImageFromReleaseCompose(overlay)).toBe(
      manifest.images["transitous-tools"],
    );
    expect(transitousToolsImageFromReleaseCompose("services: {}\n")).toBeNull();
    expect(overlay).toContain(`image: ${manifest.images["ops-agent"]}`);
    expect(overlay).toContain(`image: ${manifest.images["transitous-runner"]}`);
  });
});

describe("release channel", () => {
  it("defaults to the OpenMapX registry and derives the approved prefix from an override", () => {
    expect(releaseChannel(undefined)).toEqual({
      kind: "enabled",
      manifestImage: "ghcr.io/openmapx/release-manifest:latest",
      imagePrefix: "ghcr.io/openmapx",
    });
    expect(releaseChannel("registry.example.org/fork/release-manifest:stable")).toEqual({
      kind: "enabled",
      manifestImage: "registry.example.org/fork/release-manifest:stable",
      imagePrefix: "registry.example.org/fork",
    });
    expect(releaseChannel("")).toEqual({ kind: "disabled" });
    expect(() => releaseChannel("release-manifest")).toThrow(/registry/);
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
    expect(() => parseReleaseManifest(JSON.stringify(forked))).toThrow(/ghcr\.io\/openmapx/);
    expect(() =>
      parseReleaseManifest(JSON.stringify(manifest), "registry.example.org/fork"),
    ).toThrow(/not an approved/);
  });
});
