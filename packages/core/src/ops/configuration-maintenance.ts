import { createHash } from "node:crypto";
import { z } from "zod";
import { dataConfigurationFenceReceiptSchema } from "../services/data-manager/contracts/configuration-maintenance";
import { canonicalJson } from "./canonical-json";
import { configurationMaintenanceEffectOperationSchema } from "./configuration-operation-records";
import { coordinatorModeSchema } from "./configuration-preparation-records";
import type { OpsOperation } from "./contract";
import { executionRefSchema } from "./execution-ref";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/);
const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
const ids = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .max(256)
  .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id));
const sequence = z.number().int().nonnegative().safe();

export {
  type ProtectedConfigurationServiceId,
  protectedConfigurationServiceIdSchema,
} from "./configuration-handoff-records";
export const configurationMaintenanceBindingSchema = z.strictObject({
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  applyOperationKey: key,
  applyOperationFingerprint: digest,
  expectedCurrentRevisionId: revision.nullable(),
  revisionId: revision,
  expectedSourceRevision: z.uuid(),
  coordinatorMode: coordinatorModeSchema,
  followUp: z.enum(["render-only", "service-apply", "platform-apply"]),
});
export const configurationMaintenancePrepareSchema = configurationMaintenanceBindingSchema.extend({
  kind: z.literal("configurationMaintenance.prepare"),
});
export const configurationMaintenanceIdentitySchema = z.strictObject({
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  prepareOperationKey: key,
  prepareFingerprint: digest,
  planDigest: digest,
});
export const configurationMaintenanceDecisionSchema = configurationMaintenanceIdentitySchema.extend(
  {
    kind: z.literal("configurationMaintenance.decide"),
    decisionId: z.uuid(),
    decision: z.enum(["continue", "abandon"]),
    expectedSequence: sequence,
    checkpointVersion: sequence,
    checkpointDigest: digest,
  },
);
export const configurationMaintenanceSettleSchema = configurationMaintenanceIdentitySchema.extend({
  kind: z.literal("configurationMaintenance.settle"),
  decisionId: z.uuid(),
  expectedSequence: sequence,
  evidenceDigest: digest,
});
export type ConfigurationMaintenanceBinding = z.infer<typeof configurationMaintenanceBindingSchema>;
export type ConfigurationMaintenancePrepare = z.infer<typeof configurationMaintenancePrepareSchema>;
export type ConfigurationMaintenanceIdentity = z.infer<
  typeof configurationMaintenanceIdentitySchema
>;
export type ConfigurationMaintenanceDecision = z.infer<
  typeof configurationMaintenanceDecisionSchema
>;
export type ConfigurationMaintenanceSettle = z.infer<typeof configurationMaintenanceSettleSchema>;
export type ConfigurationMaintenanceEffect = Extract<
  OpsOperation,
  {
    kind:
      | "stack.render"
      | "serviceSelection.apply"
      | "serviceConfig.apply"
      | "integrationConfig.apply"
      | "vault.apply"
      | "configuration.hardlinks.apply"
      | "service.recreate"
      | "service.recreateIsolated"
      | "configurationHandoff.prepare";
  }
>;
const effectSchema: z.ZodType<ConfigurationMaintenanceEffect> =
  configurationMaintenanceEffectOperationSchema;
export const configurationMaintenanceStepSchema = z.strictObject({
  phase: z.enum([
    "configuration-commit",
    "maintenance-hardlinks",
    "maintenance-recreate",
    "maintenance-handoff",
  ]),
  ordinal: z.number().int().min(0).max(31),
  operation: effectSchema,
  operationKey: key,
  operationFingerprint: digest,
  serviceIds: ids,
  prerequisites: z.array(z.number().int().min(0).max(31)).max(31),
});
export type ConfigurationMaintenanceStep = z.infer<typeof configurationMaintenanceStepSchema>;
export const configurationMaintenanceReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    binding: configurationMaintenanceBindingSchema,
    prepare: executionRefSchema,
    apiJobId: z.uuid(),
    parentOperationKey: key,
    parentFingerprint: digest,
    parentDeadlineAt: sequence,
    planDigest: digest,
    serviceIds: ids,
    steps: z.array(configurationMaintenanceStepSchema).min(1).max(32),
    preflight: z.enum(["current", "drifted", "unavailable"]),
    sequence,
    state: z.enum([
      "preparing",
      "prepared",
      "authorized",
      "applying",
      "settling",
      "settled",
      "recovery_required",
    ]),
    decision: z
      .strictObject({
        decisionId: z.uuid(),
        decision: z.enum(["continue", "abandon"]),
        checkpointVersion: sequence,
        checkpointDigest: digest,
      })
      .nullable(),
    dmFence: dataConfigurationFenceReceiptSchema.nullable(),
    generation: z.enum(["not_started", "committed", "not_committed", "unknown"]),
    appliedRevisionId: revision.nullable(),
    followUp: z.enum(["not_started", "complete", "contained", "unknown"]),
  })
  .superRefine((value, context) => {
    if (
      Buffer.byteLength(JSON.stringify(value)) > 65536 ||
      value.steps[0]?.phase !== "configuration-commit" ||
      value.steps.filter((step) => step.phase === "configuration-commit").length !== 1 ||
      value.steps.some(
        (step, index) =>
          step.ordinal !== index ||
          new Set(step.prerequisites).size !== step.prerequisites.length ||
          step.prerequisites.some((prior) => prior >= index) ||
          step.serviceIds.some((id) => !value.serviceIds.includes(id)),
      )
    )
      context.addIssue({ code: "custom", message: "Invalid bounded maintenance plan" });
  });
export type ConfigurationMaintenanceReceipt = z.infer<typeof configurationMaintenanceReceiptSchema>;
/** A checksum of an authenticated API observation, never final evidence or a
 * nominal settlement capability. The actual owner compares it before its first
 * settle-control CAS; the agent produces final-v2 evidence independently. */
export function configurationMaintenanceSettleRequestDigest(
  receipt: ConfigurationMaintenanceReceipt,
): string {
  const r = configurationMaintenanceReceiptSchema.parse(receipt),
    projection = {
      version: 1,
      binding: r.binding,
      prepare: r.prepare,
      apiJobId: r.apiJobId,
      parentOperationKey: r.parentOperationKey,
      parentFingerprint: r.parentFingerprint,
      parentDeadlineAt: r.parentDeadlineAt,
      planDigest: r.planDigest,
      serviceIds: r.serviceIds,
      steps: r.steps.map((s) => ({
        phase: s.phase,
        ordinal: s.ordinal,
        operationKey: s.operationKey,
        operationFingerprint: s.operationFingerprint,
        serviceIds: s.serviceIds,
        prerequisites: s.prerequisites,
      })),
      sequence: r.sequence,
      decision: r.decision,
      dmFence: r.dmFence,
      generation: r.generation,
      appliedRevisionId: r.appliedRevisionId,
      followUp: r.followUp,
    };
  return createHash("sha256")
    .update(
      "openmapx-configuration-settle-request-evidence-v1\0" + canonicalJson(projection),
      "utf8",
    )
    .digest("hex");
}
