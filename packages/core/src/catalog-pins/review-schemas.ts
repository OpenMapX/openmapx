/** Portable signed review evidence. A failed build never fabricates candidate evidence. */
import z from "zod/v4";
import { executionRefSchema } from "../ops/execution-ref";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  stamp = z.iso.datetime({ offset: true });
export const catalogRuntimeInputsSchema = z.strictObject({
  configurationRevisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  credentialsRevision: digest,
  sourcePolicyRevision: digest,
  overlayDigest: digest,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  stagingState: z.enum(["running", "stopped", "created", "restarting", "paused", "unknown"]),
  requiredKeys: z.array(z.string().min(1).max(1024)).max(1000),
  configuredKeys: z.array(z.string().min(1).max(1024)).max(10000),
});
/** Narrow only already pin/policy-verified required IDs to this immutable job's
 * country scope. Configured IDs and the consumed mount revision remain exact. */
export function scopeCatalogRuntimeInputs(
  inputs: z.infer<typeof catalogRuntimeInputsSchema>,
  countries: readonly string[],
) {
  return {
    ...inputs,
    requiredKeys: inputs.requiredKeys.filter(
      (key) =>
        !countries.length || countries.includes(key.split("/")[0]!.split("-")[0]!.toLowerCase()),
    ),
  };
}
const common = {
  validationId: z.uuid(),
  proposalId: z.uuid(),
  pinDigest: digest,
  diffDigest: digest,
  sourcePolicyRevision: digest,
  overlayDigest: digest,
  credentialsRevision: digest,
  countries: z.array(z.string().regex(/^[a-z]{2,3}$/)).max(256),
  completedAt: stamp,
  expiresAt: stamp,
};
const candidate = {
  slot: z.enum(["A", "B"]),
  epoch: z.uuid(),
  manifestHash: digest,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
};
export const catalogValidationSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...common, ...candidate, status: z.literal("passed") }),
  z.strictObject({
    ...common,
    status: z.literal("failed"),
    reason: z.string().min(1).max(1024),
    candidate: z.strictObject(candidate).optional(),
  }),
]);
export const catalogValidationRecordSchema = z
  .strictObject({
    version: z.literal(1),
    installationId: z.uuid(),
    sourceExecution: executionRefSchema,
    proposalDigest: digest,
    runtimeInputs: catalogRuntimeInputsSchema,
    validation: catalogValidationSchema,
  })
  .refine(
    (record) =>
      record.sourceExecution.executor === "data-manager" &&
      record.sourceExecution.executionId === record.validation.validationId,
    "Original validation execution required",
  );
export const catalogActivationRecordSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  parent: executionRefSchema,
  proposalId: z.uuid(),
  validationId: z.uuid(),
  proposalDigest: digest,
  validationDigest: digest,
  diffDigest: digest,
  runtimeInputs: catalogRuntimeInputsSchema,
  promotion: z.strictObject({
    execution: executionRefSchema,
    terminalReceiptDigest: digest,
    adoption: z.strictObject({
      leaseId: z.uuid(),
      delegationId: z.uuid(),
      phase: z.literal("ready"),
    }),
  }),
  approval: executionRefSchema,
});
export type CatalogValidation = z.infer<typeof catalogValidationSchema>;
export type CatalogRuntimeInputs = z.infer<typeof catalogRuntimeInputsSchema>;
/** Staging is intentionally stopped/recreated by validation and activation. All consumed inputs remain fixed. */
export function sameCatalogRuntimeInputs(
  before: CatalogRuntimeInputs,
  after: CatalogRuntimeInputs,
): boolean {
  const keys = [
    "configurationRevisionId",
    "credentialsRevision",
    "sourcePolicyRevision",
    "overlayDigest",
    "imageDigest",
  ] as const;
  return (
    keys.every((key) => before[key] === after[key]) &&
    JSON.stringify([...before.requiredKeys].sort()) ===
      JSON.stringify([...after.requiredKeys].sort()) &&
    JSON.stringify([...before.configuredKeys].sort()) ===
      JSON.stringify([...after.configuredKeys].sort())
  );
}
/** Fixed host-source codecs; these validate retained bytes and grant no authority. */
export const catalogApprovalAdmissionSchema = z
  .object({ parent: z.unknown(), operation: z.unknown() })
  .passthrough();
export const catalogPromotionEffectSchema = z
  .object({ receipt: z.strictObject({ kind: z.literal("ops-result"), result: z.unknown() }) })
  .passthrough();
const catalogArtifactSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  sha256: digest,
  sizeBytes: z.number().int().nonnegative().safe(),
});
export const catalogCandidateManifestSchema = z.object({
  epoch: z.uuid(),
  artifacts: z.strictObject({
    config: catalogArtifactSchema,
    license: catalogArtifactSchema,
    proxyConfig: catalogArtifactSchema,
    proxyVars: catalogArtifactSchema,
    sourceManifest: catalogArtifactSchema,
    sourceIndex: catalogArtifactSchema.optional(),
    datasets: z.array(catalogArtifactSchema).min(1).max(16384),
  }),
});
export const currentCatalogValidationSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  sourceExecution: executionRefSchema,
  selected: z
    .strictObject({ proposalId: z.uuid(), validationId: z.uuid(), validationDigest: digest })
    .nullable(),
});
