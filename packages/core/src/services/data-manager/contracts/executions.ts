import z from "zod/v4";
import { executionRefSchema } from "../../../ops/execution-ref";
import { processDiagnosticsSchema } from "../../../ops/job-evidence";
import { hardlinkApplySummarySchema } from "../../../ops/service-results";
import { regionSchema } from "./common";
import { hardlinkEntrySchema } from "./datasets";
import { transitDesiredSourceMutationSchema, transitPreflightBindingSchema } from "./transit";

export const dataOperationKeySchema = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/);
export const dataFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const dataEpochSchema = z.number().int().nonnegative().safe();
export const dataRevisionSchema = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
export const dataCoordinatorModeSchema = z.enum(["ensure-running", "require-running"]);
const regional = <K extends string>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), region: regionSchema });
const countries = z.array(z.string().regex(/^[A-Za-z]{2,3}$/)).max(256);
const ordinaryInputs = [
  z.strictObject({ kind: z.literal("catalog.validate"), proposalId: z.uuid(), countries }),
  z.strictObject({
    kind: z.literal("catalog.activate"),
    proposalId: z.uuid(),
    validationId: z.uuid(),
    expectedGenerationId: dataFingerprintSchema.nullable(),
    diffDigest: dataFingerprintSchema,
    acknowledgeLicenseChanges: z.boolean(),
  }),
  regional("download-osm"),
  z.strictObject({ kind: z.literal("download-fonts") }),
  regional("convert-overpass"),
  z.strictObject({
    kind: z.literal("transit-sync"),
    countries,
    sourceMutation: transitDesiredSourceMutationSchema.optional(),
    preflight: transitPreflightBindingSchema.optional(),
  }),
  regional("overture-pull"),
  regional("overture-ingest"),
  regional("overture-extract"),
  regional("overture-conflate").extend({ restart: z.boolean().optional() }),
  regional("overture-sync"),
  regional("search-index-build"),
  z.strictObject({ kind: z.literal("notable-places-build") }),
] as const;
export const generationHardlinksInputSchema = z.strictObject({
  kind: z.literal("generation-hardlinks"),
  revisionId: dataRevisionSchema,
  planDigest: dataFingerprintSchema,
  coordinatorMode: dataCoordinatorModeSchema,
});
const maintenance = z.discriminatedUnion("action", [
  z.strictObject({ kind: z.literal("transit-maintenance"), action: z.literal("restart-primary") }),
  z.strictObject({
    kind: z.literal("transit-maintenance"),
    action: z.literal("reload-feed-proxy"),
    candidateId: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  }),
]);
export const ordinaryDataExecutionInputSchema = z.discriminatedUnion("kind", ordinaryInputs);
export const dataExecutionInputSchema = z.union([
  ordinaryDataExecutionInputSchema,
  generationHardlinksInputSchema,
  maintenance,
]);
export type DataExecutionInput = z.output<typeof dataExecutionInputSchema>;
export function normalizeDataExecutionInput(value: unknown): DataExecutionInput {
  const input = dataExecutionInputSchema.parse(value);
  if (
    input.kind === "transit-sync" &&
    input.sourceMutation &&
    new TextEncoder().encode(JSON.stringify(input.sourceMutation)).byteLength > 16 * 1024
  )
    throw Object.assign(
      new Error(
        "Transit source metadata is too large (maximum 16 KiB). Use a license URL and shorter attribution.",
      ),
      { statusCode: 413 },
    );
  return input.kind === "transit-sync" || input.kind === "catalog.validate"
    ? {
        ...input,
        countries: [...new Set(input.countries.map((country) => country.toLowerCase()))].sort(),
      }
    : input;
}
export const dataExecutionMetricsSchema = z.strictObject({
  processed: dataEpochSchema.optional(),
  inserted: dataEpochSchema.optional(),
  updated: dataEpochSchema.optional(),
  skipped: dataEpochSchema.optional(),
  sizeBytes: dataEpochSchema.optional(),
});
export type DataExecutionMetrics = z.infer<typeof dataExecutionMetricsSchema>;
const metricsResult = <K extends string>(kind: K) =>
  regional(kind).extend({
    metrics: dataExecutionMetricsSchema,
    release: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .optional(),
  });
export const dataExecutionResultSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("catalog.validate"),
      proposalId: z.uuid(),
      validationId: z.uuid(),
      status: z.enum(["passed", "failed"]),
      expiresAt: z.iso.datetime({ offset: true }),
    }),
    z.strictObject({
      kind: z.literal("catalog.activate"),
      proposalId: z.uuid(),
      validationId: z.uuid(),
      outcome: z.enum(["activated", "not_activated", "unknown"]),
      generationId: dataFingerprintSchema.nullable(),
      reason: z.string().max(1024).nullable(),
    }),
    regional("download-osm").extend({
      sizeBytes: dataEpochSchema,
      md5: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
    }),
    z.strictObject({ kind: z.literal("download-fonts"), completed: z.literal(true) }),
    regional("convert-overpass").extend({ sizeBytes: dataEpochSchema }),
    z.strictObject({
      kind: z.literal("transit-sync"),
      finalStatus: z.enum(["ok", "partial", "error"]),
      sourceRevision: z.string().min(1).max(512),
      countries,
    }),
    metricsResult("overture-pull"),
    metricsResult("overture-ingest"),
    metricsResult("overture-extract"),
    metricsResult("overture-conflate"),
    metricsResult("overture-sync"),
    regional("search-index-build").extend({ metrics: dataExecutionMetricsSchema }),
    z.strictObject({
      kind: z.literal("notable-places-build"),
      metrics: dataExecutionMetricsSchema,
    }),
    z.strictObject({
      kind: z.literal("generation-hardlinks"),
      hardlinks: hardlinkApplySummarySchema,
    }),
    z.strictObject({
      kind: z.literal("transit-maintenance"),
      action: z.enum(["restart-primary", "reload-feed-proxy"]),
      changed: z.literal(true),
    }),
  ])
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 32 * 1024);
export type DataExecutionResult = z.infer<typeof dataExecutionResultSchema>;
export const dataExecutionStatusSchema = z
  .strictObject({
    id: z.uuid(),
    operationKey: dataOperationKeySchema,
    fingerprint: dataFingerprintSchema,
    admittedAt: dataEpochSchema,
    deadlineAt: dataEpochSchema,
    kind: z.enum([
      "catalog.validate",
      "catalog.activate",
      "download-osm",
      "download-fonts",
      "convert-overpass",
      "transit-sync",
      "overture-pull",
      "overture-ingest",
      "overture-extract",
      "overture-conflate",
      "overture-sync",
      "search-index-build",
      "notable-places-build",
      "generation-hardlinks",
      "transit-maintenance",
    ]),
    status: z.enum([
      "queued",
      "running",
      "cancel_pending",
      "ok",
      "partial",
      "error",
      "canceled",
      "interrupted",
    ]),
    cancellationRequestedAt: z.iso.datetime({ offset: true }).nullable(),
    progress: z.number().finite().min(0).max(1).nullable(),
    diagnostics: processDiagnosticsSchema,
    publication: z.enum(["not_started", "committed", "unknown"]),
    result: dataExecutionResultSchema.optional(),
  })
  .refine(
    (value) =>
      value.deadlineAt > value.admittedAt && (!value.result || value.result.kind === value.kind),
  );
export type DataExecutionStatus = z.infer<typeof dataExecutionStatusSchema>;
export const startDataExecutionSchema = z.strictObject({
  operationKey: dataOperationKeySchema,
  input: ordinaryDataExecutionInputSchema,
  requestedDeadlineAt: dataEpochSchema.optional(),
});
export const generationHardlinksPlanSchema = z.strictObject({
  plan: z.array(hardlinkEntrySchema).max(256),
  prune: z.literal(true),
});
export const startGenerationHardlinksExecutionSchema = z
  .strictObject({
    operationKey: dataOperationKeySchema,
    requestedDeadlineAt: dataEpochSchema,
    input: generationHardlinksInputSchema,
    plan: generationHardlinksPlanSchema,
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 1024 * 1024);
export const dataExecutionIdentitySchema = z.strictObject({
  id: z.uuid(),
  operationKey: dataOperationKeySchema,
  fingerprint: dataFingerprintSchema,
});
export type DataExecutionIdentity = z.infer<typeof dataExecutionIdentitySchema>;
export const cancelDataExecutionSchema = dataExecutionIdentitySchema.omit({ id: true });
export const dataChildAttemptSchema = z
  .strictObject({
    phase: z.enum(["osm", "transit", "fonts", "data-step"]),
    operationKey: dataOperationKeySchema,
    input: dataExecutionInputSchema,
    operationFingerprint: dataFingerprintSchema,
    requestedDeadlineAt: dataEpochSchema,
    parentExecution: executionRefSchema,
    state: z.enum(["prepared", "attempted", "observing", "terminal", "unknown"]),
    id: z.uuid().optional(),
    fingerprint: dataFingerprintSchema.optional(),
    deadlineAt: dataEpochSchema.optional(),
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 8192);
export type DataChildAttempt = z.infer<typeof dataChildAttemptSchema>;
export function isDataExecutionTerminal(status: DataExecutionStatus): boolean {
  return (
    ["ok", "partial", "error", "canceled", "interrupted"].includes(status.status) &&
    status.publication !== "unknown"
  );
}
