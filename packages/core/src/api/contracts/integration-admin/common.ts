import {
  dataSourceOutputSchema,
  integrationManifestSchema,
} from "@openmapx/extension-contracts/integration";
import z from "zod/v4";
import { adminCountSchema, adminJsonValueSchema } from "../admin";
import { configurationOwnershipSchema } from "../configuration-ownership";
import { adminJsonWire, preserveManifestJson } from "../manifest-json";
import { integrationApplyReceiptSchema, integrationRuntimeEvidenceSchema } from "./application";
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
  ownership: z.record(z.string(), configurationOwnershipSchema).optional(),
  configurationRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  runtime: integrationRuntimeEvidenceSchema.nullable().optional(),
  application: integrationApplyReceiptSchema.nullable().optional(),
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
export const adminIntegrationReloadResultSchema = z.strictObject({
  ok: z.literal(true),
  message: z.string(),
  reloaded: adminCountSchema,
  enabled: adminCountSchema,
});
export const adminIntegrationConfigUpdatedSchema = adminIntegrationReloadResultSchema.extend({
  updated: z.array(z.string()),
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
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  desiredRevision: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: integrationRuntimeEvidenceSchema.nullable(),
  lastApplication: integrationApplyReceiptSchema.nullable(),
});
export const adminIntegrationBindingDeleteSchema = z.strictObject({
  expectedServiceId: z.string().min(1).max(64).nullable(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const adminIntegrationBindingSetSchema = adminIntegrationBindingDeleteSchema.extend({
  serviceId: z.string().min(1).max(64),
});
export const adminIntegrationEmptyMutationSchema = z.strictObject({}).optional();
export const adminIntegrationIdempotencyHeadersSchema = z.object({
  "idempotency-key": z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
});
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
export type AdminIntegrationReloadResult = z.infer<typeof adminIntegrationReloadResultSchema>;
export type AdminIntegrationConfigUpdated = z.infer<typeof adminIntegrationConfigUpdatedSchema>;
export type AdminIntegrationReloadAccepted = z.infer<typeof adminIntegrationReloadAcceptedSchema>;
export type AdminIntegrationBinding = z.infer<typeof adminIntegrationBindingSchema>;
export type AdminIntegrationBindings = z.infer<typeof adminIntegrationBindingsSchema>;
export type AdminIntegrationBindingSet = z.infer<typeof adminIntegrationBindingSetSchema>;
export type AdminIntegrationValidationError = z.infer<typeof adminIntegrationValidationErrorSchema>;
export type AdminIntegrationVaultUnavailable = z.infer<
  typeof adminIntegrationVaultUnavailableSchema
>;
