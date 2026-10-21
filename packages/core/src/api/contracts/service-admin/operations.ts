import z from "zod/v4";
import { adminServiceFailureSchema, adminServiceJsonObjectSchema } from "./common";

export const adminOperationIdSchema = z.enum([
  "download-osm",
  "download-fonts",
  "update",
  "convert-overpass",
  "link",
  "clean",
  "generate-api-keys",
  "overture-sync",
  "overture-conflate",
  "search-index-build",
  "notable-places-build",
]);
export const adminOperationGroupSchema = z.enum(["osm", "build", "overture", "search", "transit"]);
export const adminOperationRiskSchema = z.enum(["normal", "destructive"]);
export const adminOperationFormValueSchema = z.union([z.string(), z.boolean()]);
export const adminOperationFieldSchema = z.strictObject({
  name: z.string(),
  label: z.string(),
  kind: z.enum(["text", "boolean", "select"]),
  placeholder: z.string().optional(),
  helpText: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.strictObject({ value: z.string(), label: z.string() })).optional(),
});
export const adminOperationConfirmationSchema = z.strictObject({
  title: z.string(),
  message: z.string(),
});
export const adminOperationContractSchema = z.strictObject({
  id: adminOperationIdSchema,
  version: z.number().int().positive().safe(),
  group: adminOperationGroupSchema,
  title: z.string(),
  description: z.string(),
  risk: adminOperationRiskSchema,
  confirmation: adminOperationConfirmationSchema.optional(),
  fields: z.array(adminOperationFieldSchema),
  defaults: z.record(z.string(), adminOperationFormValueSchema),
});
export const adminOperationsSchema = z.strictObject({
  operations: z.array(adminOperationContractSchema),
});
/** Dynamic ID lookup, allowed keys and transformations are catalogue-owned.
 * Keep raw fields untouched, including null/absent (the producer interprets them as {}).
 */
export const adminOperationInputSchema = adminServiceJsonObjectSchema.nullable().optional();
export const adminOperationPreviewSchema = z.strictObject({
  ok: z.literal(true),
  input: adminServiceJsonObjectSchema,
  preview: z.array(z.string()),
  risk: adminOperationRiskSchema,
  confirmation: adminOperationConfirmationSchema.optional(),
});
export const adminOperationInputErrorSchema = adminServiceFailureSchema.extend({
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })),
});
export const adminOperationParamsSchema = z.strictObject({ id: z.string().min(1) });

export type AdminOperationId = z.infer<typeof adminOperationIdSchema>;
export type AdminOperationGroup = z.infer<typeof adminOperationGroupSchema>;
export type AdminOperationRisk = z.infer<typeof adminOperationRiskSchema>;
export type AdminOperationFormValue = z.infer<typeof adminOperationFormValueSchema>;
export type AdminOperationField = z.infer<typeof adminOperationFieldSchema>;
export type AdminOperationConfirmation = z.infer<typeof adminOperationConfirmationSchema>;
export type AdminOperationContract = z.infer<typeof adminOperationContractSchema>;
export type AdminOperations = z.infer<typeof adminOperationsSchema>;
export type AdminOperationInput = z.infer<typeof adminOperationInputSchema>;
export type AdminOperationPreview = z.infer<typeof adminOperationPreviewSchema>;
export type AdminOperationInputError = z.infer<typeof adminOperationInputErrorSchema>;
