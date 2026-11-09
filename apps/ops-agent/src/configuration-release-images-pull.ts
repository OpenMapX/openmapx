/** Downloads a checked release's images before an update begins any maintenance.
 * Registry access and credentials stay with the operations agent. A registry
 * outage therefore fails the update while every service still runs the old
 * release; once maintenance has started, nothing is downloaded. */
import { type ConfigurationReleaseDownloads, OPS_KIND_POLICIES } from "@openmapx/core/ops";
import { inspectConfigurationReleaseImages } from "./configuration-release-images";
import { preflightConfigurationRelease } from "./configuration-release-preflight";
import type { DockerRuntimeOptions } from "./docker-runtime";
import type { OpsRuntime } from "./runtime";

type ExecFile = NonNullable<DockerRuntimeOptions["execFile"]>;

/** Makes every pinned image present locally and returns the observed Docker IDs.
 * An image already present with its pinned digest and platform is not pulled
 * again. After a pull, a missing or different image is a failure. */
export async function pullConfigurationReleaseImages(input: {
  downloads: ConfigurationReleaseDownloads;
  execFile: ExecFile;
  signal: AbortSignal;
  emitLog?(stream: "stdout" | "stderr", message: string): void;
}) {
  const images: {
    image: ConfigurationReleaseDownloads["images"][number]["image"];
    imageId: string;
  }[] = [];
  for (const entry of input.downloads.images) {
    input.signal.throwIfAborted();
    const inspect = () =>
      inspectConfigurationReleaseImages({
        downloads: input.downloads,
        image: entry.image,
        execFile: input.execFile,
        signal: input.signal,
      });
    let observed = await inspect().then(
      ([value]) => value,
      () => undefined,
    );
    input.signal.throwIfAborted();
    if (!observed) {
      input.emitLog?.("stdout", `Pulling the ${entry.image} image`);
      await input.execFile(
        "docker",
        ["image", "pull", "--platform", input.downloads.platform, entry.reference],
        {
          signal: input.signal,
          timeout: OPS_KIND_POLICIES["release.images.pull"].timeoutMs,
          maxBuffer: 1024 * 1024,
        },
      );
      observed = (await inspect())[0];
      if (!observed) throw Error("Pulled release image is unavailable");
    }
    images.push({ image: entry.image, imageId: observed.imageId });
  }
  return { images };
}

export function installConfigurationReleaseImagesRuntime(
  runtime: OpsRuntime,
  options: { infraDir: string; execFile: ExecFile },
): void {
  runtime["release.images.pull"] = async (operation, context) => {
    const release = await preflightConfigurationRelease({
      infraDir: options.infraDir,
      selection: { releaseId: operation.releaseId, manifestDigest: operation.manifestDigest },
      execFile: options.execFile,
      signal: context.signal,
    });
    return pullConfigurationReleaseImages({
      downloads: release.downloads,
      execFile: options.execFile,
      signal: context.signal,
      emitLog: context.emitLog,
    });
  };
}
