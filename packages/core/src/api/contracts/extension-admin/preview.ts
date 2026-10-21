import z from "zod/v4";
import { adminExtensionSecurityRatingSchema, adminExtensionTrustSchema } from "./common";

export const adminExtensionInstallRequestSchema = z
  .strictObject({
    id: z.string().optional(),
    manifestUrl: z.string().optional(),
    hostPortConfirmation: z.string().optional(),
  })
  .refine(
    (input) => Boolean(input.id || input.manifestUrl),
    "Either id or manifestUrl is required",
  );
// Confirmation is opaque input; the installer owns comparison/authorization.
export const adminExtensionUpdateRequestSchema = z
  .strictObject({
    hostPortConfirmation: z.string().optional(),
  })
  .optional();
export const adminExtensionInstallPreviewSchema = z.strictObject({
  extension: z.strictObject({ id: z.string(), name: z.string(), version: z.string() }),
  sourceTrust: adminExtensionTrustSchema,
  services: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      version: z.string(),
      repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/),
      hostPorts: z.array(
        z.strictObject({
          host: z.number().int().min(1).max(65535),
          container: z.number().int().min(1).max(65535),
          protocol: z.enum(["tcp", "udp"]),
          bindAddress: z.string(),
        }),
      ),
      securityRating: adminExtensionSecurityRatingSchema,
    }),
  ),
  requiresHostPortConfirmation: z.boolean(),
  confirmation: z.string().regex(/^[a-f0-9]{64}$/),
});

export type AdminExtensionInstallRequest = z.infer<typeof adminExtensionInstallRequestSchema>;
export type AdminExtensionUpdateRequest = z.infer<typeof adminExtensionUpdateRequestSchema>;
export type AdminExtensionInstallPreview = z.infer<typeof adminExtensionInstallPreviewSchema>;
