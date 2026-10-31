/** Read-only Docker/OCI metadata preflight; no image pull or target acquisition.
 * Shapes follow Docker manifest inspect and OCI image index/manifest descriptors:
 * https://docs.docker.com/reference/cli/docker/manifest/
 * https://github.com/opencontainers/image-spec/blob/main/manifest.md */
import {
  CONFIGURATION_RELEASE_IMAGE_BYTES,
  CONFIGURATION_RELEASE_IMAGE_NAMES,
  type ConfigurationReleaseDownloads,
  configurationReleaseDownloadsSchema,
  configurationReleasePlatformSchema,
} from "@openmapx/core/ops";
import { z } from "zod";
import type { CheckedConfigurationRelease } from "./configuration-release";
import type { DockerRuntimeOptions } from "./docker-runtime";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/),
  descriptor = z.object({
    digest,
    size: z.number().int().nonnegative().safe().max(CONFIGURATION_RELEASE_IMAGE_BYTES),
  }),
  manifestSchema = z.object({
    schemaVersion: z.literal(2),
    config: descriptor.extend({
      size: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024),
    }),
    layers: z.array(descriptor).max(2048),
    manifests: z.never().optional(),
  }),
  indexSchema = z.object({
    schemaVersion: z.literal(2),
    manifests: z
      .array(
        descriptor.extend({
          platform: z
            .object({
              os: z.string().max(32),
              architecture: z.string().max(32),
              variant: z.string().max(32).optional(),
            })
            .optional(),
        }),
      )
      .min(1)
      .max(256),
    config: z.never().optional(),
    layers: z.never().optional(),
  });

export async function inspectConfigurationReleaseDownloads(input: {
  release: CheckedConfigurationRelease;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  signal: AbortSignal;
}): Promise<ConfigurationReleaseDownloads> {
  const run = async (args: readonly string[]) => {
    input.signal.throwIfAborted();
    const result = await input.execFile("docker", args, {
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(15000)]),
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    input.signal.throwIfAborted();
    if (Buffer.byteLength(result.stdout) > 1024 * 1024)
      throw Error("Release metadata capacity exceeded");
    return result.stdout;
  };
  const observed = (await run(["info", "--format", "{{.OSType}}/{{.Architecture}}"])).trim(),
    platform = configurationReleasePlatformSchema.parse(
      observed === "linux/x86_64"
        ? "linux/amd64"
        : observed === "linux/aarch64"
          ? "linux/arm64"
          : observed,
    ),
    [os, architecture] = platform.split("/"),
    images = [];
  for (const image of CONFIGURATION_RELEASE_IMAGE_NAMES) {
    const reference = input.release.manifest.images[image];
    let body: unknown = JSON.parse(await run(["manifest", "inspect", reference])),
      platformManifestDigest = digest.parse(reference.slice(reference.lastIndexOf("@") + 1));
    if (body && typeof body === "object" && Object.hasOwn(body, "manifests")) {
      const index = indexSchema.parse(body),
        matches = index.manifests.filter(
          (item) =>
            item.platform?.os === os &&
            item.platform.architecture === architecture &&
            (item.platform.variant === undefined ||
              (architecture === "arm64" && item.platform.variant === "v8")),
        );
      if (matches.length !== 1) throw Error("Release platform is unavailable or ambiguous");
      platformManifestDigest = matches[0]!.digest;
      const selected = `${reference.slice(0, reference.lastIndexOf("@"))}@${platformManifestDigest}`;
      body = JSON.parse(await run(["manifest", "inspect", selected]));
    }
    const manifest = manifestSchema.parse(body),
      declaredBytes =
        manifest.config.size + manifest.layers.reduce((sum, layer) => sum + layer.size, 0);
    if (manifest.config.size < 1) throw Error("Release image configuration is empty");
    images.push({
      image,
      reference,
      platformManifestDigest,
      configDigest: manifest.config.digest,
      declaredBytes,
    });
  }
  // Declared config/layer blob bytes, not an assertion about Docker's
  // unpacked filesystem size. Actual pulled images still require verification.
  const snapshot = configurationReleaseDownloadsSchema.parse({
    version: 1,
    platform,
    images,
    declaredBytes: images.reduce((sum, image) => sum + image.declaredBytes, 0),
  });
  snapshot.images.forEach(Object.freeze);
  Object.freeze(snapshot.images);
  return Object.freeze(snapshot);
}
