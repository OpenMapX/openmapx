/** Resolve public release inputs under the actual private release-store lock.
 * This is a read-only preflight, not target ownership or permission to pull. */
import { join } from "node:path";
import { canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import {
  type ConfigurationReleaseSnapshot,
  configurationReleaseSnapshotSchema,
} from "../../../packages/core/src/build-artifacts/configuration-release-snapshot";
import { readCheckedConfigurationRelease } from "./configuration-release";
import { inspectConfigurationReleaseDownloads } from "./configuration-release-downloads";
import { inspectConfigurationReleaseImages } from "./configuration-release-images";
import type { DockerRuntimeOptions } from "./docker-runtime";

export async function preflightConfigurationRelease(input: {
  infraDir: string;
  selection: { releaseId: string; manifestDigest: string };
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  signal: AbortSignal;
}) {
  const lock = await services.acquireReleaseStoreLock(
    services.releaseStatePaths(input.infraDir).store,
  );
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

/** Re-checks a release that maintenance already froze, without the registry.
 * It confirms the checked release and channel still match the snapshot and that
 * every pinned image is on the host, so an outage that starts after the images
 * were downloaded cannot fail a maintenance already in progress. */
export async function verifyFrozenConfigurationRelease(input: {
  infraDir: string;
  selection: { releaseId: string; manifestDigest: string };
  frozen: ConfigurationReleaseSnapshot;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  signal: AbortSignal;
}) {
  const frozen = configurationReleaseSnapshotSchema.parse(input.frozen);
  if (
    frozen.releaseId !== input.selection.releaseId ||
    frozen.manifestDigest !== input.selection.manifestDigest
  )
    throw Error("Frozen release does not match the selection");
  const lock = await services.acquireReleaseStoreLock(
    services.releaseStatePaths(input.infraDir).store,
  );
  try {
    input.signal.throwIfAborted();
    const release = readCheckedConfigurationRelease(input.infraDir, input.selection),
      channel = services.releaseSelection();
    if (
      channel.kind === "local" ||
      channel.imagePrefix !== frozen.imagePrefix ||
      services.canonicalReleaseManifest(release.manifest) !== frozen.canonicalManifest ||
      canonicalJson(release.serviceImages) !== canonicalJson(frozen.serviceImages)
    )
      throw Error("Checked release changed after it was frozen");
    await inspectConfigurationReleaseImages({
      downloads: frozen.downloads,
      execFile: input.execFile,
      signal: input.signal,
    });
    return frozen;
  } finally {
    lock.release();
  }
}
