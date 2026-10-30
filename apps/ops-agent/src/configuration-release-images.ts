/** Read-only local image verification. These observations are data, not a pull or lease. */
import {
  type ConfigurationReleaseDownloads,
  configurationReleaseDownloadSchema,
  configurationReleaseDownloadsSchema,
} from "@openmapx/core/ops";
import { z } from "zod";
import type { DockerRuntimeOptions } from "./docker-runtime";

const imageSchema = z.object({
  Id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  RepoDigests: z.array(configurationReleaseDownloadSchema.shape.reference).max(256),
  Os: z.string().max(32),
  Architecture: z.string().max(32),
  Variant: z.string().max(32).optional(),
});
export async function inspectConfigurationReleaseImages(input: {
  downloads: ConfigurationReleaseDownloads;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  signal: AbortSignal;
}) {
  const downloads = configurationReleaseDownloadsSchema.parse(input.downloads),
    [os, architecture] = downloads.platform.split("/"),
    observations = [];
  for (const image of downloads.images) {
    input.signal.throwIfAborted();
    const response = await input.execFile(
      "docker",
      ["image", "inspect", "--format", "{{json .}}", image.reference],
      {
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(15000)]),
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    input.signal.throwIfAborted();
    if (Buffer.byteLength(response.stdout) > 65536)
      throw Error("Release image observation capacity exceeded");
    const observed = imageSchema.parse(JSON.parse(response.stdout)),
      platformReference = `${image.reference.slice(0, image.reference.lastIndexOf("@"))}@${image.platformManifestDigest}`;
    if (
      observed.Os !== os ||
      observed.Architecture !== architecture ||
      (observed.Variant && !(architecture === "arm64" && observed.Variant === "v8")) ||
      !observed.RepoDigests.some(
        (reference) => reference === image.reference || reference === platformReference,
      )
    )
      throw Error("Checked release local image does not match its pinned platform");
    // Docker's local image ID is observed independently. An OCI index digest
    // or repository reference must never be substituted for that runtime ID.
    observations.push(
      Object.freeze({ image: image.image, reference: image.reference, imageId: observed.Id }),
    );
  }
  return Object.freeze(observations);
}
