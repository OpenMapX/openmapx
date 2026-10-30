import z from "zod/v4";
import { configurationApplyResultSchema } from "../../../ops/configuration-result-records";
/** Live host evidence, independent of the desired database binding. */
export const integrationRuntimeEvidenceSchema = z.strictObject({
  generationId: z.uuid(),
  bindings: z.record(z.string(), z.string().nullable()),
  configRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IntegrationRuntimeEvidence = z.infer<typeof integrationRuntimeEvidenceSchema>;
export const integrationHostApplyEvidenceSchema = z.union([
  ...configurationApplyResultSchema.options.map((schema) =>
    schema.extend({ publisherCleanupFailed: z.boolean(), registryUpdateFailed: z.boolean() }),
  ),
  z.strictObject({
    outcome: z.literal("unknown"),
    reason: z.literal("transport_or_result"),
    publisherCleanupFailed: z.boolean(),
    registryUpdateFailed: z.boolean(),
  }),
]);
export const integrationApplyReceiptSchema = z.strictObject({
  operationId: z.string().min(1).max(256),
  integrationId: z.string().min(1).max(64),
  desiredRevision: z.string().regex(/^[a-f0-9]{64}$/),
  database: z.enum(["retained", "restored", "conflict", "unknown"]),
  runtime: z.enum(["applied", "pending", "failed", "unknown"]),
  runtimeGenerationId: z.uuid().nullable(),
  reason: z
    .enum([
      "integration_disabled",
      "reload_failed",
      "ownership_changed",
      "authority_unavailable",
      "reconciliation_required",
    ])
    .optional(),
  hostApply: integrationHostApplyEvidenceSchema.optional(),
});
export type IntegrationApplyReceipt = z.infer<typeof integrationApplyReceiptSchema>;
