import {
  CONFIGURATION_RELEASE_IMAGE_NAMES,
  type ConfigurationReleaseDownloads,
} from "@openmapx/core/ops";
import { expect, it, vi } from "vitest";
import { inspectConfigurationReleaseImages } from "./configuration-release-images";

function downloads(): ConfigurationReleaseDownloads {
  return {
    version: 1,
    platform: "linux/amd64",
    declaredBytes: 7,
    images: CONFIGURATION_RELEASE_IMAGE_NAMES.map((image) => ({
      image,
      reference: `ghcr.io/openmapx/${image}@sha256:${"a".repeat(64)}`,
      platformManifestDigest: `sha256:${"b".repeat(64)}`,
      configDigest: `sha256:${"c".repeat(64)}`,
      declaredBytes: 1,
    })),
  };
}
function io(change: Record<string, unknown> = {}) {
  return vi.fn(async (_file: string, args: readonly string[]) => {
    expect(args.slice(0, 4)).toEqual(["image", "inspect", "--format", "{{json .}}"]);
    return {
      stdout: JSON.stringify({
        Id: `sha256:${"d".repeat(64)}`,
        RepoDigests: [args[4]],
        Os: "linux",
        Architecture: "amd64",
        ...change,
      }),
      stderr: "",
    };
  });
}
it("observes each exact immutable reference and retains the actual Docker ID separately", async () => {
  const execFile = io(),
    snapshot = downloads();
  const result = await inspectConfigurationReleaseImages({
    downloads: snapshot,
    execFile,
    signal: new AbortController().signal,
  });
  expect(result).toEqual(
    snapshot.images.map(({ image, reference }) => ({
      image,
      reference,
      imageId: `sha256:${"d".repeat(64)}`,
    })),
  );
  expect(execFile).toHaveBeenCalledTimes(7);
  expect(execFile.mock.calls.map(([, args]) => args[4])).toEqual(
    snapshot.images.map((v) => v.reference),
  );
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.every(Object.isFrozen)).toBe(true);
});
it("accepts the exact selected platform digest for a multi-platform repository pin", async () => {
  const snapshot = downloads();
  const execFile = io();
  execFile.mockImplementation(async (_file, args) => ({
    stdout: JSON.stringify({
      Id: `sha256:${"d".repeat(64)}`,
      RepoDigests: [`${args[4]!.slice(0, args[4]!.indexOf("@"))}@sha256:${"b".repeat(64)}`],
      Os: "linux",
      Architecture: "amd64",
    }),
    stderr: "",
  }));
  expect(
    await inspectConfigurationReleaseImages({
      downloads: snapshot,
      execFile,
      signal: new AbortController().signal,
    }),
  ).toHaveLength(7);
});
it.each([
  { RepoDigests: [] },
  { RepoDigests: [`ghcr.io/foreign/api@sha256:${"a".repeat(64)}`] },
  { RepoDigests: [`ghcr.io/openmapx/api@sha256:${"e".repeat(64)}`] },
  { Id: "image:latest" },
  { Os: "windows" },
  { Architecture: "arm64" },
])("refuses incompatible local image data before returning an accepted set: %j", async (change) => {
  await expect(
    inspectConfigurationReleaseImages({
      downloads: downloads(),
      execFile: io(change),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
});
it("propagates missing-image failure and stops before any further inspection", async () => {
  const execFile = io();
  execFile.mockRejectedValueOnce(Error("No such image"));
  await expect(
    inspectConfigurationReleaseImages({
      downloads: downloads(),
      execFile,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(execFile).toHaveBeenCalledTimes(1);
});
it("checks cancellation before and after external IO and bounds stdout", async () => {
  const controller = new AbortController(),
    execFile = io();
  controller.abort();
  await expect(
    inspectConfigurationReleaseImages({
      downloads: downloads(),
      execFile,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(execFile).not.toHaveBeenCalled();
  const after = new AbortController();
  execFile.mockImplementationOnce(async () => {
    after.abort();
    return { stdout: "{}", stderr: "" };
  });
  await expect(
    inspectConfigurationReleaseImages({ downloads: downloads(), execFile, signal: after.signal }),
  ).rejects.toThrow();
  execFile.mockResolvedValueOnce({ stdout: " ".repeat(65537), stderr: "" });
  await expect(
    inspectConfigurationReleaseImages({
      downloads: downloads(),
      execFile,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
});

it("checks the exact completed pull independently before moving to another image", async () => {
  const execFile = io();
  const input = {
    downloads: downloads(),
    execFile,
    signal: new AbortController().signal,
    image: "ops-agent" as const,
  };
  const result = await inspectConfigurationReleaseImages(input);
  expect(result).toEqual([
    {
      image: "ops-agent",
      reference: input.downloads.images[3]!.reference,
      imageId: `sha256:${"d".repeat(64)}`,
    },
  ]);
  expect(execFile).toHaveBeenCalledTimes(1);
});
