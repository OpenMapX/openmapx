/** Canonical existing configuration effect inputs, shared by request and
 * maintenance receipt schemas. Contains no result schema/runtime policy. */
import { z } from "zod";
import { configurationHandoffPrepareOperationSchema } from "./configuration-handoff-records";
import {
  configurationGenerationRevisionSchema,
  serviceIdSchema,
  stableIdSchema,
} from "./configuration-identifiers";
import { coordinatorModeSchema } from "./configuration-preparation-records";

export {
  configurationGenerationRevisionSchema,
  serviceIdSchema,
  stableIdSchema,
} from "./configuration-identifiers";

const configurationCondition = {
  expectedSourceRevision: z.uuid(),
  coordinatorMode: coordinatorModeSchema,
  maintenanceId: z.uuid().optional(),
  candidateId: z.uuid().optional(),
};

export const configurationHardlinksApplyOperationSchema = z.strictObject({
  kind: z.literal("configuration.hardlinks.apply"),
  revisionId: configurationGenerationRevisionSchema,
  coordinatorMode: coordinatorModeSchema,
  maintenanceId: z.uuid().optional(),
  candidateId: z.uuid().optional(),
  planDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const stackRenderOperationSchema = z.strictObject({
  kind: z.literal("stack.render"),
  ...configurationCondition,
  revisionId: stableIdSchema,
  expectedCurrentRevisionId: configurationGenerationRevisionSchema.nullable(),
});
export const serviceRecreateOperationSchema = z.strictObject({
  kind: z.literal("service.recreate"),
  serviceId: serviceIdSchema,
  expectedConfigurationRevisionId: configurationGenerationRevisionSchema,
  maintenanceId: z.uuid().optional(),
  planDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const serviceRecreateIsolatedOperationSchema = z.strictObject({
  kind: z.literal("service.recreateIsolated"),
  serviceId: serviceIdSchema,
  expectedConfigurationRevisionId: configurationGenerationRevisionSchema,
  maintenanceId: z.uuid().optional(),
  planDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const serviceSelectionApplyOperationSchema = z.strictObject({
  kind: z.literal("serviceSelection.apply"),
  ...configurationCondition,
  revisionId: stableIdSchema,
  expectedCurrentRevisionId: configurationGenerationRevisionSchema.nullable(),
});
export const serviceConfigApplyOperationSchema = z.strictObject({
  kind: z.literal("serviceConfig.apply"),
  ...configurationCondition,
  serviceId: serviceIdSchema,
  revisionId: stableIdSchema,
  expectedCurrentRevisionId: configurationGenerationRevisionSchema.nullable(),
});
export const integrationConfigApplyOperationSchema = z.strictObject({
  kind: z.literal("integrationConfig.apply"),
  ...configurationCondition,
  integrationId: serviceIdSchema,
  revisionId: stableIdSchema,
  expectedCurrentRevisionId: configurationGenerationRevisionSchema.nullable(),
});
export const vaultApplyOperationSchema = z.strictObject({
  kind: z.literal("vault.apply"),
  ...configurationCondition,
  serviceId: serviceIdSchema,
  revisionId: stableIdSchema,
  expectedCurrentRevisionId: configurationGenerationRevisionSchema.nullable(),
});
export const configurationMaintenanceEffectOperationSchema = z.discriminatedUnion("kind", [
  configurationHardlinksApplyOperationSchema,
  stackRenderOperationSchema,
  serviceRecreateOperationSchema,
  serviceRecreateIsolatedOperationSchema,
  serviceSelectionApplyOperationSchema,
  serviceConfigApplyOperationSchema,
  integrationConfigApplyOperationSchema,
  vaultApplyOperationSchema,
  configurationHandoffPrepareOperationSchema,
]);
