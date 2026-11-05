import { z } from "zod";
import { serviceBatchResultSchema, serviceLifecycleFailureEvidenceSchema } from "./service-results";

export const PROCESS_OUTPUT_TRUNCATED = "[output truncated]";
export const processDiagnosticsSchema = z
  .strictObject({
    tail: z
      .array(
        z.strictObject({
          stream: z.enum(["stdout", "stderr"]),
          message: z.string().refine((x) => new TextEncoder().encode(x).byteLength <= 4096),
        }),
      )
      .max(256),
    truncated: z.boolean(),
  })
  .refine((x) => new TextEncoder().encode(JSON.stringify(x)).byteLength <= 16 * 1024);
export type ProcessDiagnostics = z.infer<typeof processDiagnosticsSchema>;
export const dataWorkflowReceiptSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["osm", "transit", "fonts", "build", "link", "complete"]),
  children: z
    .array(
      z.strictObject({
        step: z.enum(["osm", "transit", "fonts", "build", "link"]),
        operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
        jobId: z.uuid(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        deadlineAt: z.number().int().nonnegative().safe(),
        status: z.enum([
          "queued",
          "running",
          "succeeded",
          "failed",
          "interrupted",
          "cancel_pending",
          "canceled",
          "unknown",
        ]),
      }),
    )
    .max(16),
  completedBuildIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(256),
  failedBuildIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(256),
  skippedBuildIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(256),
  revisionId: z
    .string()
    .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
    .optional(),
});
export type DataWorkflowReceipt = z.infer<typeof dataWorkflowReceiptSchema>;
export const opsFailureResultSchema = z
  .strictObject({
    serviceBatch: serviceBatchResultSchema.optional(),
    dataWorkflow: dataWorkflowReceiptSchema.optional(),
    diagnostics: processDiagnosticsSchema.optional(),
    serviceLifecycle: serviceLifecycleFailureEvidenceSchema.optional(),
  })
  .refine((x) => new TextEncoder().encode(JSON.stringify(x)).byteLength <= 64 * 1024);
export type OpsFailureResult = z.infer<typeof opsFailureResultSchema>;
