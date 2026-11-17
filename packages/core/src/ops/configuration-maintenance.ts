import { z } from "zod";
import { configurationMaintenanceEffectOperationSchema } from "./configuration-operation-records";
import { coordinatorModeSchema } from "./configuration-preparation-records";
import type { OpsOperation } from "./contract";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/);
const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
const ids = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .max(256)
  .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id));

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
/** Runs every step of a prepared maintenance; it succeeds with the handoff still running. */
export const configurationMaintenanceApplySchema = z.strictObject({
  kind: z.literal("configurationMaintenance.apply"),
  maintenanceId: z.uuid(),
});
export const configurationMaintenanceInspectSchema = z.strictObject({
  kind: z.literal("configurationMaintenance.inspect"),
  maintenanceId: z.uuid(),
});
/** `complete` once no step is unresolved; `abandon` before any step started. A
 * repeat returns the settled record. */
export const configurationMaintenanceSettleSchema = z.strictObject({
  kind: z.literal("configurationMaintenance.settle"),
  maintenanceId: z.uuid(),
  outcome: z.enum(["complete", "abandon"]),
});
export type ConfigurationMaintenanceBinding = z.infer<typeof configurationMaintenanceBindingSchema>;
export type ConfigurationMaintenancePrepare = z.infer<typeof configurationMaintenancePrepareSchema>;
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
