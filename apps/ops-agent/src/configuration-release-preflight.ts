/** Resolve public release inputs from the agent's manifest cache. This is a
 * read-only preflight, not target ownership or permission to pull. */
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
  input.signal.throwIfAborted();
  const channel = services.releaseSelection();
  if (channel.kind === "local") throw new services.ReleaseChannelDisabledError();
  // A cached manifest is named by its digest, so it cannot change under this read.
  const release = readCheckedConfigurationRelease(input.infraDir, input.selection),
    downloads = await inspectConfigurationReleaseDownloads({
      release,
      execFile: input.execFile,
      signal: input.signal,
    });
  return configurationReleaseSnapshotSchema.parse({
    version: 1,
    releaseId: release.releaseId,
    manifestDigest: release.manifestDigest,
    imagePrefix: channel.imagePrefix,
    canonicalManifest: services.canonicalReleaseManifest(release.manifest),
    serviceImages: release.serviceImages,
    downloads,
  });
}

/** Re-checks a release that maintenance already froze, without the registry.
 * It confirms the channel still matches the snapshot and that every pinned
 * image is on the host, so an outage that starts after the images were
 * downloaded cannot fail a maintenance already in progress. */
export async function verifyFrozenConfigurationRelease(input: {
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
  input.signal.throwIfAborted();
  const channel = services.releaseSelection();
  if (channel.kind === "local" || channel.imagePrefix !== frozen.imagePrefix)
    throw Error("The configured release repository changed after the release was frozen");
  await inspectConfigurationReleaseImages({
    downloads: frozen.downloads,
    execFile: input.execFile,
    signal: input.signal,
  });
  return frozen;
}
