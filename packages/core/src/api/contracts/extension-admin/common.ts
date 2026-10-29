import z from "zod/v4";
import { adminCountSchema } from "../admin";

export const adminExtensionTrustSchema = z.enum(["built-in", "verified", "community"]);
export const adminExtensionComponentKindSchema = z.enum(["service", "integration"]);
// Lookup identity and source URL admission remain producer/domain decisions.
export const adminExtensionParamsSchema = z.strictObject({ id: z.string().min(1) });
export const adminExtensionEmptyMutationSchema = z.strictObject({}).optional();
/** Application job acceptance, never a terminal install/remove result. */
export const adminExtensionAcceptedSchema = z.strictObject({ jobId: z.string().min(1) });
export const adminExtensionOkSchema = z.strictObject({ ok: z.literal(true) });
export const adminExtensionRefreshSchema = z.strictObject({ entries: adminCountSchema });
export const adminExtensionSourceSchema = z.strictObject({
  url: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
});
export const adminExtensionSourcesSchema = z.strictObject({
  sources: z.array(adminExtensionSourceSchema),
});
export const adminExtensionSourceAddSchema = z.strictObject({
  url: z.string().min(1),
  label: z.string().min(1),
});
export const adminExtensionSourceRemoveSchema = z.strictObject({ url: z.string().min(1) });
export const adminExtensionSecurityRatingSchema = z.strictObject({
  score: z.number().int().min(1).max(8),
  requiresBuiltIn: z.boolean(),
  hostPorts: adminCountSchema,
  secretCount: adminCountSchema,
  deploymentVariables: z.array(z.string()),
  factors: z.array(z.string()),
});

export type AdminExtensionSource = z.infer<typeof adminExtensionSourceSchema>;
export type AdminExtensionSecurityRating = z.infer<typeof adminExtensionSecurityRatingSchema>;
