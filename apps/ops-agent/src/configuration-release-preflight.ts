/** Resolve public release inputs under the actual private release-store lock.
 * This is a read-only preflight, not target ownership or permission to pull. */
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { configurationReleaseSnapshotSchema } from "../../../packages/core/src/build-artifacts/configuration-release-snapshot";
import { readCheckedConfigurationRelease } from "./configuration-release";
import { inspectConfigurationReleaseDownloads } from "./configuration-release-downloads";
import type { DockerRuntimeOptions } from "./docker-runtime";

export async function preflightConfigurationRelease(input: {
  infraDir: string;
  selection: { releaseId: string; manifestDigest: string };
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  signal: AbortSignal;
}) {
  const lock = await services.acquireReleaseStoreLock(join(input.infraDir, ".ops-agent-releases"));
  try {
    input.signal.throwIfAborted();
    const release = readCheckedConfigurationRelease(input.infraDir, input.selection),
      downloads = await inspectConfigurationReleaseDownloads({
        release,
        execFile: input.execFile,
        signal: input.signal,
      }),
      current = readCheckedConfigurationRelease(input.infraDir, input.selection),
      channel = services.releaseSelection();
    if (
      channel.kind === "local" ||
      services.canonicalReleaseManifest(current.manifest) !==
        services.canonicalReleaseManifest(release.manifest)
    )
      throw Error("Checked release changed during preflight");
    return configurationReleaseSnapshotSchema.parse({
      version: 1,
      releaseId: release.releaseId,
      manifestDigest: release.manifestDigest,
      imagePrefix: channel.imagePrefix,
      canonicalManifest: services.canonicalReleaseManifest(release.manifest),
      serviceImages: release.serviceImages,
      downloads,
    });
  } finally {
    lock.release();
  }
}
