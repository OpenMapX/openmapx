import { credentialSetupSchema } from "@openmapx/extension-contracts/integration";

import { serviceManifestSchema } from "@openmapx/extension-contracts/service";
import z from "zod/v4";
import { adminCountSchema, adminJsonValueSchema, adminTimestampSchema } from "../admin";
import { adminJsonWire, preserveManifestJson } from "../manifest-json";
import {
  adminServiceAcceptedSchema,
  adminServiceIdListSchema,
  adminServiceJsonObjectSchema,
} from "./common";

const gpu = serviceManifestSchema.shape.container.shape.gpu.unwrap();
const buildImages = serviceManifestSchema.shape.buildImages.unwrap();
const provides = serviceManifestSchema.shape.provides.unwrap().element;
/** Portable known validators, with authoring defaults removed from the raw wire view. */
const manifest = preserveManifestJson(
  serviceManifestSchema.extend({
    container: serviceManifestSchema.shape.container.extend({
      gpu: gpu
        .extend({
          driver: gpu.shape.driver.removeDefault().optional(),
          count: gpu.shape.count.removeDefault().optional(),
          capabilities: gpu.shape.capabilities.removeDefault().optional(),
        })
        .optional(),
    }),
    buildImages: z
      .record(buildImages.keyType, preserveManifestJson(buildImages.valueType))
      .optional(),
    provides: z
      .array(
        z.union([
          provides.options[0],
          provides.options[1].extend({ metadata: adminServiceJsonObjectSchema.optional() }),
        ]),
      )
      .optional(),
    configSchema: serviceManifestSchema.shape.configSchema
      .unwrap()
      .extend({
        properties: z.record(z.string(), adminJsonValueSchema),
      })
      .optional(),
  }),
);
/** Validate trusted schema structure only; configSchema remains inert JSON data. */
export const adminServiceManifestSchema = adminJsonWire(manifest);
export const adminServiceStatusSchema = z.enum([
  "running",
  "exited",
  "restarting",
  "created",
  "paused",
  "not-running",
]);
export const adminServiceSummarySchema = z.strictObject({
  id: serviceManifestSchema.shape.id,
  name: serviceManifestSchema.shape.name,
  version: serviceManifestSchema.shape.version,
  description: serviceManifestSchema.shape.description,
  quality: serviceManifestSchema.shape.quality,
  provides: z.array(z.string()),
  consumes: adminJsonWire(preserveManifestJson(serviceManifestSchema.shape.consumes.unwrap())),
  exposure: adminJsonWire(preserveManifestJson(serviceManifestSchema.shape.exposure)).optional(),
  enabled: z.boolean(),
  isBuiltIn: z.boolean(),
  status: adminServiceStatusSchema,
});
export const adminServicesSchema = z.strictObject({
  services: z.array(adminServiceSummarySchema),
  summary: z.strictObject({
    running: adminCountSchema,
    stopped: adminCountSchema,
    total: adminCountSchema,
  }),
});
export const adminServiceDetailSchema = z.strictObject({
  manifest: adminServiceManifestSchema,
  directory: z.string(),
  isBuiltIn: z.boolean(),
  enabled: z.boolean(),
  status: adminServiceStatusSchema,
});
export const adminServiceConfigSourceSchema = z.enum(["default", "database", "env"]);
export const adminServiceResolvedConfigSchema = z.record(
  z.string(),
  z.strictObject({ value: adminJsonValueSchema, source: adminServiceConfigSourceSchema }),
);
export const adminServiceConfigSchema = z.strictObject({
  schema: adminServiceJsonObjectSchema.nullable(),
  resolvedConfig: adminServiceResolvedConfigSchema,
  envPrefix: z.string(),
});
export const adminServiceConfigUpdateSchema = z.strictObject({
  config: adminServiceJsonObjectSchema,
});
export const adminServiceCredentialSetupSchema = credentialSetupSchema
  .extend({ email: credentialSetupSchema.shape.email.unwrap().strict().optional() })
  .strict();
export const adminServiceCredentialSchema = z.strictObject({
  key: z.string(),
  title: z.string(),
  description: z.string().optional(),
  setup: adminServiceCredentialSetupSchema.optional(),
  source: z.enum(["vault", "missing"]),
  managedBy: z.literal("dawarich-provisioning").optional(),
  updatedAt: adminTimestampSchema.optional(),
  updatedBy: z.string().nullable(),
});
export const adminServiceCredentialsSchema = z.strictObject({
  serviceId: z.string(),
  secretsConfigured: z.boolean(),
  credentials: z.array(adminServiceCredentialSchema),
});
export const adminServiceCredentialSetSchema = z.strictObject({
  value: z.string().refine((value) => value.trim().length > 0, "value must be a non-empty string"),
});
export const adminServiceCredentialChangedSchema = z.union([
  adminServiceAcceptedSchema,
  z.strictObject({ ok: z.literal(true), needsRender: z.literal(true) }),
]);
export const adminServiceCredentialManagedSchema = z.strictObject({
  code: z.literal("DAWARICH_CREDENTIAL_MANAGED"),
  error: z.string(),
});
export const adminServiceActionSchema = z.strictObject({
  action: z.enum(["start", "stop", "restart"]),
});
const build = z.strictObject({
  action: z.literal("build"),
  serviceIds: adminServiceIdListSchema.optional(),
  all: z.boolean().optional(),
  region: z.string().trim().optional(),
  continueOnError: z.boolean().optional(),
});
export const adminServicesBulkActionSchema = z.union([
  z.strictObject({
    action: z.enum(["start", "stop", "restart", "update"]),
    serviceIds: adminServiceIdListSchema.min(1),
    continueOnError: z.boolean().optional(),
  }),
  build.refine(
    (value) => value.all === true || Boolean(value.serviceIds?.length),
    "Build requires serviceIds or all: true",
  ),
]);
export const adminServicesCheckedSchema = z.strictObject({
  statuses: z.array(z.strictObject({ service: z.string(), state: adminServiceStatusSchema })),
  checkedAt: adminTimestampSchema,
});
// Producer retains its existing numeric conversion/clamping policy for lines.
export const adminServiceLogsQuerySchema = z.object({
  lines: z.union([z.string(), z.number()]).optional(),
});

export type AdminServiceManifest = z.infer<typeof adminServiceManifestSchema>;
export type AdminServiceStatus = z.infer<typeof adminServiceStatusSchema>;
export type AdminServiceSummary = z.infer<typeof adminServiceSummarySchema>;
export type AdminServices = z.infer<typeof adminServicesSchema>;
export type AdminServiceDetail = z.infer<typeof adminServiceDetailSchema>;
export type AdminServiceConfigSource = z.infer<typeof adminServiceConfigSourceSchema>;
export type AdminServiceResolvedConfig = z.infer<typeof adminServiceResolvedConfigSchema>;
export type AdminServiceConfig = z.infer<typeof adminServiceConfigSchema>;
export type AdminServiceConfigUpdate = z.infer<typeof adminServiceConfigUpdateSchema>;
export type AdminServiceCredentialSetup = z.infer<typeof adminServiceCredentialSetupSchema>;
export type AdminServiceCredential = z.infer<typeof adminServiceCredentialSchema>;
export type AdminServiceCredentials = z.infer<typeof adminServiceCredentialsSchema>;
export type AdminServiceCredentialSet = z.infer<typeof adminServiceCredentialSetSchema>;
export type AdminServiceCredentialChanged = z.infer<typeof adminServiceCredentialChangedSchema>;
export type AdminServiceCredentialManaged = z.infer<typeof adminServiceCredentialManagedSchema>;
export type AdminServiceAction = z.infer<typeof adminServiceActionSchema>;
export type AdminServicesBulkAction = z.infer<typeof adminServicesBulkActionSchema>;
export type AdminServicesChecked = z.infer<typeof adminServicesCheckedSchema>;
export type AdminServiceLogsQuery = z.infer<typeof adminServiceLogsQuerySchema>;

export { getProvidedCapabilityNames } from "@openmapx/extension-contracts/service";
