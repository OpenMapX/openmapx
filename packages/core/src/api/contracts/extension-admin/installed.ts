import z from "zod/v4";
import { adminTimestampSchema } from "../admin";
import {
  adminExtensionComponentKindSchema,
  adminExtensionSecurityRatingSchema,
  adminExtensionTrustSchema,
} from "./common";

export const adminExtensionInstalledSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  sourceTrust: adminExtensionTrustSchema,
  installedVersion: z.string(),
  sourceUrl: z.string().nullable(),
  installedAt: adminTimestampSchema,
  updatedAt: adminTimestampSchema,
  components: z.array(
    z.strictObject({
      kind: adminExtensionComponentKindSchema,
      componentId: z.string(),
      enabled: z.boolean().optional(),
      securityRating: adminExtensionSecurityRatingSchema.optional(),
    }),
  ),
  // null means no catalog version is available for comparison.
  hasUpdate: z.boolean().nullable(),
  latestVersion: z.string().nullable(),
});
export const adminExtensionInstalledListSchema = z.strictObject({
  extensions: z.array(adminExtensionInstalledSchema),
});

export type AdminInstalledExtension = z.infer<typeof adminExtensionInstalledSchema>;
