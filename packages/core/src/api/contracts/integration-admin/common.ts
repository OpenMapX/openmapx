import {
  dataSourceOutputSchema,
  integrationManifestSchema,
} from "@openmapx/extension-contracts/integration";
import z from "zod/v4";
import { configurationApplyResultSchema } from "../../../ops/contract";
import { adminCountSchema, adminJsonValueSchema, adminTimestampSchema } from "../admin";
import { adminJsonWire, preserveManifestJson } from "../manifest-json";
import {
  adminIntegrationConfigSourceSchema,
  adminIntegrationCredentialSchema,
} from "./credentials";
import { adminIntegrationHealthSummarySchema } from "./health";

export const adminIntegrationIdSchema = integrationManifestSchema.shape.id;
export const adminIntegrationParamsSchema = z.strictObject({ id: adminIntegrationIdSchema });
export const adminIntegrationRefParamsSchema = z.strictObject({
  integrationId: adminIntegrationIdSchema,
});
export const adminIntegrationBindingParamsSchema = adminIntegrationRefParamsSchema.extend({
  capability: z.string().min(1),
});
export const adminIntegrationCredentialParamsSchema = adminIntegrationRefParamsSchema.extend({
  key: z.string().min(1),
});
export const adminIntegrationJsonObjectSchema = adminJsonWire(
  z.record(z.string(), adminJsonValueSchema),
);
const manifest = preserveManifestJson(
  integrationManifestSchema.extend({
    configSchema: adminIntegrationJsonObjectSchema.optional(),
    dataSources: z.array(dataSourceOutputSchema).optional(),
  }),
).catchall(adminJsonValueSchema);
/** Complete wire JSON with typed metadata; authoring transforms must not rewrite it.
 * Provider configSchema remains data, never an executable route schema.
 */
export const adminIntegrationManifestSchema = adminJsonWire(manifest);
export const adminIntegrationSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: integrationManifestSchema.shape.description,
  version: integrationManifestSchema.shape.version,
  domains: integrationManifestSchema.shape.domains,
  quality: integrationManifestSchema.shape.quality.unwrap(),
  isBuiltIn: z.boolean(),
  blockedCode: z.boolean(),
  enabled: z.boolean(),
  configured: z.boolean(),
  hasHealthCheck: z.boolean(),
  health: adminIntegrationHealthSummarySchema.nullable(),
  dependencies: z.array(z.string()),
  requires: integrationManifestSchema.shape.requires.unwrap(),
  infrastructure: integrationManifestSchema.shape.infrastructure.unwrap().nullable(),
});
export const adminIntegrationResolvedConfigSchema = z.record(
  z.string(),
  z.strictObject({ value: adminJsonValueSchema, source: adminIntegrationConfigSourceSchema }),
);
export const adminIntegrationDetailSchema = adminIntegrationSummarySchema.extend({
  author: integrationManifestSchema.shape.author,
  license: integrationManifestSchema.shape.license,
  documentation: integrationManifestSchema.shape.documentation,
  manifest: adminIntegrationManifestSchema,
  resolvedConfig: adminIntegrationResolvedConfigSchema,
  dependencyStatus: z.array(
    z.strictObject({ id: z.string(), loaded: z.boolean(), enabled: z.boolean() }),
  ),
  credentialStatus: z.array(adminIntegrationCredentialSchema),
  secretsConfigured: z.boolean(),
});
export const adminIntegrationEnvVarSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  secret: z.boolean(),
  present: z.boolean(),
  defaultValue: adminJsonValueSchema.optional(),
});
export const adminIntegrationEnvVarsSchema = z.strictObject({
  integrations: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      envVars: z.array(adminIntegrationEnvVarSchema),
    }),
  ),
});
export const adminIntegrationConfigPatchSchema = adminIntegrationJsonObjectSchema.refine(
  (value) => Object.keys(value).length > 0 && !Object.hasOwn(value, "enabled"),
  "Provide non-secret config fields; use enable/disable to change enabled",
);
export const adminIntegrationConfigEntrySchema = z.strictObject({
  integrationId: adminIntegrationIdSchema,
  config: adminJsonWire(
    z.object({ enabled: z.boolean().optional() }).catchall(adminJsonValueSchema),
  ),
});
export const adminIntegrationConfigExportSchema = z.strictObject({
  integrations: z.array(adminIntegrationConfigEntrySchema),
  exportedAt: adminTimestampSchema,
  count: adminCountSchema,
});
/** Exports can be imported directly. Runtime existence, writable fields and secrets
 * are validated against the current manifest by the server before any write.
 */
export const adminIntegrationConfigImportSchema = z.strictObject({
  integrations: z
    .array(adminIntegrationConfigEntrySchema)
    .min(1)
    .superRefine((entries, context) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry.integrationId))
          context.addIssue({
            code: "custom",
            path: [index, "integrationId"],
            message: "Duplicate integration ID",
          });
        seen.add(entry.integrationId);
      });
    }),
  exportedAt: adminTimestampSchema.optional(),
  count: adminCountSchema.optional(),
});
export const adminIntegrationReloadResultSchema = z.strictObject({
  ok: z.literal(true),
  message: z.string(),
  reloaded: adminCountSchema,
  enabled: adminCountSchema,
});
export const adminIntegrationConfigUpdatedSchema = adminIntegrationReloadResultSchema.extend({
  updated: z.array(z.string()),
});
export const adminIntegrationConfigImportedSchema = adminIntegrationReloadResultSchema.extend({
  imported: adminCountSchema,
  skipped: z.array(z.string()),
});
/** Enqueue acknowledgement, never a terminal job result. Existing routes return HTTP 200. */
export const adminIntegrationReloadAcceptedSchema = z.strictObject({
  ok: z.literal(true),
  jobId: z.string(),
});
export const adminIntegrationBindingSchema = z.strictObject({
  capability: z.string(),
  serviceId: z.string(),
});
export const adminIntegrationBindingsSchema = z.strictObject({
  bindings: z.array(adminIntegrationBindingSchema),
});
export const adminIntegrationBindingSetSchema = z.strictObject({ serviceId: z.string().min(1) });
export const adminIntegrationEmptyMutationSchema = z.strictObject({}).optional();
export const adminIntegrationValidationErrorSchema = z.strictObject({
  errors: z.array(z.string()),
});
export const adminIntegrationVaultUnavailableSchema = z.strictObject({
  error: z.string(),
  hint: z.string(),
});

export type AdminIntegrationManifest = z.infer<typeof adminIntegrationManifestSchema>;
export type AdminIntegrationSummary = z.infer<typeof adminIntegrationSummarySchema>;
export type AdminIntegrationResolvedConfig = z.infer<typeof adminIntegrationResolvedConfigSchema>;
export type AdminIntegrationDetail = z.infer<typeof adminIntegrationDetailSchema>;
export type AdminIntegrationEnvVar = z.infer<typeof adminIntegrationEnvVarSchema>;
export type AdminIntegrationEnvVars = z.infer<typeof adminIntegrationEnvVarsSchema>;
export type AdminIntegrationConfigPatch = z.infer<typeof adminIntegrationConfigPatchSchema>;
export type AdminIntegrationConfigEntry = z.infer<typeof adminIntegrationConfigEntrySchema>;
export type AdminIntegrationConfigExport = z.infer<typeof adminIntegrationConfigExportSchema>;
export type AdminIntegrationConfigImport = z.infer<typeof adminIntegrationConfigImportSchema>;
export type AdminIntegrationReloadResult = z.infer<typeof adminIntegrationReloadResultSchema>;
export type AdminIntegrationConfigUpdated = z.infer<typeof adminIntegrationConfigUpdatedSchema>;
export type AdminIntegrationConfigImported = z.infer<typeof adminIntegrationConfigImportedSchema>;
export type AdminIntegrationReloadAccepted = z.infer<typeof adminIntegrationReloadAcceptedSchema>;
export type AdminIntegrationBinding = z.infer<typeof adminIntegrationBindingSchema>;
export type AdminIntegrationBindings = z.infer<typeof adminIntegrationBindingsSchema>;
export type AdminIntegrationBindingSet = z.infer<typeof adminIntegrationBindingSetSchema>;
export type AdminIntegrationValidationError = z.infer<typeof adminIntegrationValidationErrorSchema>;
export type AdminIntegrationVaultUnavailable = z.infer<
  typeof adminIntegrationVaultUnavailableSchema
>;

const importApplyEvidenceSchema = z.union([
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
export const adminIntegrationImportFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.literal("Integration import failed"),
  phase: z.enum(["persistence", "apply", "reload", "ownership"]),
  recovery: z.enum(["restored", "reconciliation_required"]),
  database: z.enum(["unknown", "retained", "conflict", "restored"]),
  runtime: z.enum(["unchanged", "unknown", "restored"]).optional(),
  apply: importApplyEvidenceSchema.optional(),
  compensation: importApplyEvidenceSchema.optional(),
  reason: z.enum(["submitted_snapshot_not_owned", "previous_applied_not_proven"]).optional(),
});
export type AdminIntegrationImportFailure = z.infer<typeof adminIntegrationImportFailureSchema>;
