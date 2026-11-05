import { describe, expect, it } from "vitest";
import { imageStagePlatform, immutableImageStageReference } from "../image-stage";

const descriptor = (digest: string, architecture = "amd64", os = "linux", variant?: string) => ({
  Descriptor: {
    digest,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    platform: { architecture, os, ...(variant ? { variant } : {}) },
  },
});
const digest = `sha256:${"a".repeat(64)}`;
describe("immutable image cache staging", () => {
  it("selects the Docker daemon platform without retaining a mutable tag", () => {
    expect(
      immutableImageStageReference(
        "valkey/valkey:9.1.2-alpine",
        [descriptor(`sha256:${"b".repeat(64)}`, "arm64"), descriptor(digest)],
        imageStagePlatform("linux/x86_64\n"),
      ),
    ).toBe(`docker.io/valkey/valkey@${digest}`);
  });
  it("normalizes default registries, ports, latest and already pinned images", () => {
    const platform = imageStagePlatform("linux/amd64");
    expect(immutableImageStageReference("redis", descriptor(digest), platform)).toBe(
      `docker.io/library/redis@${digest}`,
    );
    expect(
      immutableImageStageReference(
        "registry.example.test:5000/team/image:tag",
        descriptor(digest),
        platform,
      ),
    ).toBe(`registry.example.test:5000/team/image@${digest}`);
    expect(immutableImageStageReference(`example/image@${digest}`, null, platform)).toBe(
      `docker.io/example/image@${digest}`,
    );
  });
  it("selects ARM variants exactly and rejects ambiguous platform manifests", () => {
    expect(imageStagePlatform("linux/armv7l")).toEqual({
      os: "linux",
      architecture: "arm",
      variant: "v7",
    });
    expect(
      immutableImageStageReference(
        "example/image:tag",
        [
          descriptor(digest, "arm", "linux", "v7"),
          descriptor(`sha256:${"b".repeat(64)}`, "arm", "linux", "v6"),
        ],
        imageStagePlatform("linux/armv7l"),
      ),
    ).toBe(`docker.io/example/image@${digest}`);
    expect(() =>
      immutableImageStageReference(
        "example/image:tag",
        [descriptor(digest), descriptor(`sha256:${"b".repeat(64)}`)],
        imageStagePlatform("linux/amd64"),
      ),
    ).toThrow(/ambiguous/i);
  });
  it.each([
    null,
    {},
    [],
    descriptor(digest, "s390x"),
    descriptor("not-a-digest"),
    {
      Descriptor: {
        digest,
        mediaType: "unknown",
        platform: { os: "linux", architecture: "amd64" },
      },
    },
  ])("refuses malformed or incompatible remote metadata %j", (metadata) => {
    expect(() =>
      immutableImageStageReference(
        "example/image:tag",
        metadata,
        imageStagePlatform("linux/amd64"),
      ),
    ).toThrow();
  });
  it("bounds descriptor count and rejects invalid Docker platform text", () => {
    expect(() =>
      immutableImageStageReference(
        "redis:latest",
        Array.from({ length: 129 }, () => descriptor(digest)),
        imageStagePlatform("linux/amd64"),
      ),
    ).toThrow();
    for (const value of ["", "linux/amd64/extra/four", "linux/amd64\n--flag", "../amd64"])
      expect(() => imageStagePlatform(value)).toThrow();
  });
});
