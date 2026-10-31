import { credentialSetupSchema } from "@openmapx/extension-contracts/integration";
import z from "zod/v4";
import { adminCountSchema, adminTimestampSchema } from "../admin";
import { configurationOwnershipSchema } from "../configuration-ownership";
import { integrationApplyReceiptSchema, integrationRuntimeEvidenceSchema } from "./application";
import { adminIntegrationHealthStatusSchema } from "./health";

/** Winning effective layer; vault audit metadata is retained independently. */
export const adminIntegrationConfigSourceSchema = z.enum([
  "default",
  "database",
  "vault",
  "config.json",
  "env",
]);
export const adminIntegrationCredentialSourceSchema = z.enum([
  ...adminIntegrationConfigSourceSchema.options,
  "missing",
]);
export const adminIntegrationCredentialSetupSchema = credentialSetupSchema
  .extend({
    email: credentialSetupSchema.shape.email.unwrap().strict().optional(),
  })
  .strict();
export const adminIntegrationCredentialSchema = z.strictObject({
  key: z.string(),
  title: z.string(),
  description: z.string().optional(),
  source: adminIntegrationCredentialSourceSchema,
  ownership: configurationOwnershipSchema.optional(),
  sharedSecretName: z.string().optional(),
  setup: adminIntegrationCredentialSetupSchema.optional(),
  updatedAt: adminTimestampSchema.optional(),
  updatedBy: z.string().nullable().optional(),
});
export const adminIntegrationCredentialSummarySchema = z.strictObject({
  integrationId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  secretFields: adminCountSchema,
  vaultStored: adminCountSchema,
  missingCredentials: adminCountSchema,
});
export const adminCredentialsSchema = z.strictObject({
  credentials: z.array(adminIntegrationCredentialSummarySchema),
  secretsConfigured: z.boolean(),
});
export const adminIntegrationCredentialsSchema = z.strictObject({
  integrationId: z.string(),
  name: z.string(),
  credentials: z.array(adminIntegrationCredentialSchema),
  configurationRevision: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: integrationRuntimeEvidenceSchema.nullable(),
  application: integrationApplyReceiptSchema.nullable(),
  secretsConfigured: z.boolean(),
});
export const adminIntegrationCredentialDeleteSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const adminIntegrationCredentialSetSchema = adminIntegrationCredentialDeleteSchema.extend({
  // Check whitespace without transforming the actual credential bytes.
  value: z.string().refine((value) => value.trim().length > 0, "value must be a non-empty string"),
});
export const adminIntegrationCredentialTestRequestSchema = z
  .strictObject({ key: z.string().min(1).optional() })
  .optional();
export const adminIntegrationCredentialTestSchema = z.strictObject({
  ok: z.boolean(),
  integrationId: z.string(),
  key: z.string().nullable(),
  status: adminIntegrationHealthStatusSchema,
  responseTime: z.number().nonnegative().optional(),
  error: z.string().nullable(),
});
export type AdminIntegrationConfigSource = z.infer<typeof adminIntegrationConfigSourceSchema>;
export type AdminIntegrationCredentialSource = z.infer<
  typeof adminIntegrationCredentialSourceSchema
>;
export type AdminIntegrationCredentialSetup = z.infer<typeof adminIntegrationCredentialSetupSchema>;
export type AdminIntegrationCredential = z.infer<typeof adminIntegrationCredentialSchema>;
export type AdminIntegrationCredentialSummary = z.infer<
  typeof adminIntegrationCredentialSummarySchema
>;
export type AdminCredentials = z.infer<typeof adminCredentialsSchema>;
export type AdminIntegrationCredentials = z.infer<typeof adminIntegrationCredentialsSchema>;
export type AdminIntegrationCredentialSet = z.infer<typeof adminIntegrationCredentialSetSchema>;
export type AdminIntegrationCredentialTestRequest = z.infer<
  typeof adminIntegrationCredentialTestRequestSchema
>;
export type AdminIntegrationCredentialTest = z.infer<typeof adminIntegrationCredentialTestSchema>;
