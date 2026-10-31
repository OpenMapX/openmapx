import z from "zod/v4";
import { standaloneInventoryEntrySchema } from "../../../ops/standalone-integrations";
import { platformConfigurationSchema } from "../../../services/platform-configuration";
import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";
import { configurationOwnershipSchema } from "../configuration-ownership";
import {
  adminPlatformConfirmationSchema,
  adminPlatformPreviewSchema,
} from "../service-admin/platform";
import { migrationOperationResultSchema } from "./credential-transfer";

const value = z.json();
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const values = z
  .record(z.string().min(1).max(128), value)
  .refine(
    (v) =>
      Object.keys(v).length <= 128 &&
      Object.keys(v).every((k) => !["__proto__", "prototype", "constructor"].includes(k)),
  );
export const migrationPrerequisiteSchema = z.strictObject({
  scope: z.enum(["integration", "service", "platform", "account"]),
  id: z.string().min(1).max(128),
  key: z.string().max(128).optional(),
  source: z.enum(["default", "database", "vault", "config.json", "env", "missing"]),
  reason: z.enum([
    "host_owned",
    "credential_required",
    "installation_required",
    "unsupported",
    "protected_bootstrap",
  ]),
});
export const configurationMigrationDocumentSchema = z
  .strictObject({
    format: z.literal("openmapx-configuration"),
    version: z.literal(1),
    exportedAt: z.iso.datetime(),
    settings: values,
    platform: platformConfigurationSchema.optional(),
    integrations: z.array(z.strictObject({ integrationId: id, config: values })).max(256),
    serviceConfigs: z.array(z.strictObject({ serviceId: id, config: values })).max(256),
    bindings: z
      .array(
        z.strictObject({
          integrationId: id,
          capability: z.string().min(1).max(128),
          serviceId: id,
        }),
      )
      .max(512),
    installations: z.array(standaloneInventoryEntrySchema).max(2048),
    prerequisites: z.array(migrationPrerequisiteSchema).max(1000),
  })
  .refine(
    (v) =>
      new TextEncoder().encode(JSON.stringify(v)).length <= 1048576 &&
      Object.keys(v.settings).length +
        v.integrations.reduce((n, e) => n + Object.keys(e.config).length, 0) +
        v.serviceConfigs.reduce((n, e) => n + Object.keys(e.config).length, 0) +
        v.bindings.length <=
        1000,
  );
export type ConfigurationMigrationDocument = z.infer<typeof configurationMigrationDocumentSchema>;
export type MigrationPrerequisite = z.infer<typeof migrationPrerequisiteSchema>;
export const configurationMigrationInventorySchema = z.strictObject({
  document: configurationMigrationDocumentSchema,
  fields: z
    .array(
      z.strictObject({
        scope: z.enum(["integration", "service", "platform", "account"]),
        id: z.string(),
        key: z.string(),
        ownership: configurationOwnershipSchema,
        included: z.boolean(),
      }),
    )
    .max(1000),
});
export const configurationMigrationPreviewSchema = z.strictObject({
  previewId: z.uuid(),
  fingerprint: z.string(),
  expectedCurrentRevisionId: z.string().nullable(),
  changes: z
    .array(z.strictObject({ scope: z.string(), id: z.string(), keys: z.array(z.string()) }))
    .max(512),
  prerequisites: z.array(migrationPrerequisiteSchema).max(1000),
  denials: z.array(z.string()).max(1000),
  expiresAt: z.iso.datetime(),
  platform: adminPlatformPreviewSchema.optional(),
});
export type ConfigurationMigrationPreview = z.infer<typeof configurationMigrationPreviewSchema>;
const headers = z.object({ "idempotency-key": z.string().min(1).max(128) });
const transferResponses = {
  ...adminCommonResponses,
  409: adminJson(httpErrorSchema),
  503: adminJson(httpErrorSchema),
};
export const configurationMigrationOperations = {
  getAdminConfigurationMigrationInventory: {
    method: "GET",
    path: "/api/admin/configuration-migration/inventory",
    auth: "admin",
    responses: { ...transferResponses, 200: adminJson(configurationMigrationInventorySchema) },
  },
  exportAdminConfigurationMigration: {
    method: "GET",
    path: "/api/admin/configuration-migration/export",
    auth: "admin",
    responses: { ...transferResponses, 200: adminJson(configurationMigrationDocumentSchema) },
  },
  previewAdminConfigurationMigration: {
    method: "POST",
    path: "/api/admin/configuration-migration/preview",
    auth: "admin",
    request: { body: configurationMigrationDocumentSchema, headers },
    responses: { ...transferResponses, 200: adminJson(configurationMigrationPreviewSchema) },
  },
  applyAdminConfigurationMigration: {
    method: "POST",
    path: "/api/admin/configuration-migration/apply",
    auth: "admin",
    request: {
      body: z.strictObject({
        previewId: z.uuid(),
        fingerprint: z.string().min(1).max(128),
        platformAuthorization: z
          .strictObject({
            confirmations: adminPlatformConfirmationSchema,
            proofToken: z.uuid().optional(),
          })
          .optional(),
      }),
      headers,
    },
    responses: { ...transferResponses, 200: adminJson(migrationOperationResultSchema) },
  },
} as const satisfies Record<string, AdminOperation>;
