/** Bounded public registry metadata. These records never supply host authority. */
import { z } from "zod";
import {
  RELEASE_PINNED_SERVICE_IDS,
  type ReleasePinnedServiceId,
} from "../services/core-service-ids";
import { configurationHandoffModeSchema } from "./configuration-handoff-records";
export const CONFIGURATION_RELEASE_IMAGE_NAMES = [
  "api",
  "web",
  "data-manager",
  "ops-agent",
  "transitous-runner",
] as const;
export const CONFIGURATION_RELEASE_IMAGE_BYTES = 8 * 1024 ** 3;
export const CONFIGURATION_RELEASE_TOTAL_BYTES = 32 * 1024 ** 3;
export const configurationReleasePlatformSchema = z.enum(["linux/amd64", "linux/arm64"]);
export const configurationReleaseDownloadSchema = z.strictObject({
  image: z.enum(CONFIGURATION_RELEASE_IMAGE_NAMES),
  reference: z
    .string()
    .max(512)
    .regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/),
  platformManifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  configDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  declaredBytes: z.number().int().nonnegative().safe().max(CONFIGURATION_RELEASE_IMAGE_BYTES),
});
export const configurationReleaseDownloadsSchema = z
  .strictObject({
    version: z.literal(1),
    platform: configurationReleasePlatformSchema,
    images: z
      .array(configurationReleaseDownloadSchema)
      .length(CONFIGURATION_RELEASE_IMAGE_NAMES.length),
    declaredBytes: z.number().int().nonnegative().safe().max(CONFIGURATION_RELEASE_TOTAL_BYTES),
  })
  .superRefine((value, context) => {
    if (
      value.images.some(
        (image, index) => image.image !== CONFIGURATION_RELEASE_IMAGE_NAMES[index],
      ) ||
      value.images.reduce((sum, image) => sum + image.declaredBytes, 0) !== value.declaredBytes
    )
      context.addIssue({ code: "custom", message: "Inconsistent release download metadata" });
  });
export type ConfigurationReleaseDownloads = z.infer<typeof configurationReleaseDownloadsSchema>;
export const configurationReleaseSelectionSchema = configurationHandoffModeSchema.options[1].omit({
  kind: true,
});
/** The image each pinned service runs, keyed by service ID. */
export const configurationReleaseServiceImagesSchema = z.strictObject(
  Object.fromEntries(
    RELEASE_PINNED_SERVICE_IDS.map((id) => [
      id,
      configurationReleaseDownloadSchema.shape.reference,
    ]),
  ) as Record<ReleasePinnedServiceId, typeof configurationReleaseDownloadSchema.shape.reference>,
);
export const configurationReleaseForwardSchema = configurationReleaseSelectionSchema.extend({
  version: z.literal(1),
  serviceImages: configurationReleaseServiceImagesSchema,
  downloads: configurationReleaseDownloadsSchema,
});
