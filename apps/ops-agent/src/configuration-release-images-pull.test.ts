import {
  CONFIGURATION_RELEASE_IMAGE_NAMES,
  type ConfigurationReleaseDownloads,
} from "@openmapx/core/ops";
import { expect, it, vi } from "vitest";
import { pullConfigurationReleaseImages } from "./configuration-release-images-pull";

const downloads: ConfigurationReleaseDownloads = {
  version: 1,
  platform: "linux/amd64",
  declaredBytes: CONFIGURATION_RELEASE_IMAGE_NAMES.length,
  images: CONFIGURATION_RELEASE_IMAGE_NAMES.map((image) => ({
    image,
    reference: `ghcr.io/openmapx/${image}@sha256:${"a".repeat(64)}`,
    platformManifestDigest: `sha256:${"b".repeat(64)}`,
    configDigest: `sha256:${"c".repeat(64)}`,
    declaredBytes: 1,
  })),
};
const imageId = (reference: string) => `sha256:${reference.length.toString(16).padStart(64, "d")}`;

/** A Docker host whose local images are exactly the references in `local`. */
function host(local: Set<string>, registryDown = false) {
  const pulled: string[] = [];
  const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
    if (args[0] === "image" && args[1] === "inspect") {
      const reference = args[4] as string;
      if (!local.has(reference)) throw Error("No such image");
      return {
        stdout: JSON.stringify({
          Id: imageId(reference),
          RepoDigests: [reference],
          Os: "linux",
          Architecture: "amd64",
        }),
        stderr: "",
      };
    }
    if (args[0] === "image" && args[1] === "pull") {
      if (registryDown) throw Error("registry unavailable");
      expect(args.slice(2, 4)).toEqual(["--platform", "linux/amd64"]);
      pulled.push(args[4] as string);
      local.add(args[4] as string);
      return { stdout: "", stderr: "" };
    }
    throw Error(`Unexpected Docker call: ${args.join(" ")}`);
  });
  return { execFile, pulled };
}
const run = (docker: ReturnType<typeof host>) =>
  pullConfigurationReleaseImages({
    downloads,
    execFile: docker.execFile,
    signal: new AbortController().signal,
  });

it("pulls only the images that are not already present and returns every Docker ID", async () => {
  const present = downloads.images.slice(0, 3).map((value) => value.reference),
    docker = host(new Set(present));

  const result = await run(docker);

  expect(docker.pulled).toEqual(downloads.images.slice(3).map((value) => value.reference));
  expect(result.images).toEqual(
    downloads.images.map((value) => ({
      image: value.image,
      imageId: imageId(value.reference),
    })),
  );
});

it("pulls nothing when every image is already present with its pinned digest", async () => {
  const docker = host(new Set(downloads.images.map((value) => value.reference)));

  await run(docker);

  expect(docker.pulled).toEqual([]);
});

it("fails on a registry outage without reporting a partial set as pulled", async () => {
  const docker = host(new Set(), true);

  await expect(run(docker)).rejects.toThrow("registry unavailable");

  expect(docker.pulled).toEqual([]);
  expect(docker.execFile.mock.calls.filter(([, args]) => args[1] === "pull")).toHaveLength(1);
});

it("fails when a pulled image still does not match its pin", async () => {
  const docker = host(new Set());
  docker.execFile.mockImplementation(async (_file, args) => {
    if (args[1] === "inspect") throw Error("No such image");
    return { stdout: "", stderr: "" };
  });

  await expect(run(docker)).rejects.toThrow();
});

it("stops before any effect when the operation is already canceled", async () => {
  const docker = host(new Set()),
    controller = new AbortController();
  controller.abort();

  await expect(
    pullConfigurationReleaseImages({
      downloads,
      execFile: docker.execFile,
      signal: controller.signal,
    }),
  ).rejects.toThrow();

  expect(docker.execFile).not.toHaveBeenCalled();
});
