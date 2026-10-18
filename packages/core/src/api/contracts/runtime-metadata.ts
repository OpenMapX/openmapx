import {
  dataSourceOutputSchema,
  integrationManifestSchema,
} from "@openmapx/extension-contracts/integration";
import { z } from "zod/v4";

/** JSON catalogs have object locale roots and recursively typed JSON children. */
export const localeCatalogSchema = z.record(z.string(), z.json());
export const localeStringsSchema = z.record(z.string(), localeCatalogSchema);
export type LocaleCatalog = z.infer<typeof localeCatalogSchema>;
export type LocaleStrings = z.infer<typeof localeStringsSchema>;

export const serviceCapabilitySchema = z.strictObject({
  enabled: z.boolean(),
  healthy: z.boolean(),
  available: z.boolean(),
  domains: z.array(z.string()),
});
export const capabilitiesResponseSchema = z.strictObject({
  services: z.record(z.string(), serviceCapabilitySchema),
  features: z.strictObject({ osmContributions: z.boolean() }),
});
export type ServiceCapability = z.infer<typeof serviceCapabilitySchema>;
export type CapabilitiesResponse = z.infer<typeof capabilitiesResponseSchema>;

export const aiCloudProcessorSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  countryCode: z.string(),
  privacyUrl: z.string(),
});
export const aiSearchDisclosureSchema = z.strictObject({
  type: z.literal("ai-search"),
  integrationId: z.string(),
  aiActive: z.boolean(),
  localActive: z.boolean(),
  cloudActive: z.boolean(),
  cloudProcessors: z.array(aiCloudProcessorSchema),
  cloudAvailable: z.boolean(),
  cloudConsentRequired: z.boolean(),
  cloudProviderLabels: z.array(z.string()),
});
export const emailProviderSchema = z.enum(["emaillabs", "lettermint", "smtp"]);
export const transferSafeguardSchema = z.enum(["eea", "adequacy", "dpf", "scc", "none"]);
export const emailDisclosureSchema = z.strictObject({
  type: z.literal("email"),
  provider: emailProviderSchema,
  vendorName: z.string(),
  countryCode: z.string(),
  privacyUrl: z.string().optional(),
  transfer: transferSafeguardSchema,
});
export const disclosureSchema = z.discriminatedUnion("type", [
  aiSearchDisclosureSchema,
  emailDisclosureSchema,
]);
export type AiCloudProcessor = z.infer<typeof aiCloudProcessorSchema>;
export type AiSearchDisclosure = z.infer<typeof aiSearchDisclosureSchema>;
export type EmailProvider = z.infer<typeof emailProviderSchema>;
export type TransferSafeguard = z.infer<typeof transferSafeguardSchema>;
export type EmailDisclosure = z.infer<typeof emailDisclosureSchema>;
export type Disclosure = z.infer<typeof disclosureSchema>;

const manifestHealthCheckSchema = integrationManifestSchema.shape.healthCheck.unwrap().options[0];
/** Operational URLs, templates, headers and config keys stay inside the host. */
export const publicIntegrationHealthCheckSchema = manifestHealthCheckSchema
  .pick({ type: true, name: true, category: true })
  .strict();
export type PublicIntegrationHealthCheck = z.infer<typeof publicIntegrationHealthCheckSchema>;

export const integrationMetadataSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: integrationManifestSchema.shape.description,
  enabled: z.boolean(),
  isBuiltIn: z.boolean(),
  domains: integrationManifestSchema.shape.domains,
  frontend: integrationManifestSchema.shape.frontend,
  dataSources: z.array(dataSourceOutputSchema).optional(),
  healthCheck: z
    .union([publicIntegrationHealthCheckSchema, z.array(publicIntegrationHealthCheckSchema)])
    .optional(),
  strings: localeStringsSchema.optional(),
});
export const integrationMetadataPayloadSchema = z.strictObject({
  integrations: z.array(integrationMetadataSchema),
  frameworkStrings: localeStringsSchema,
  disclosures: z.array(disclosureSchema),
});
export const integrationsResponseSchema = integrationMetadataPayloadSchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IntegrationMetadata = z.infer<typeof integrationMetadataSchema>;
export type IntegrationMetadataPayload = z.infer<typeof integrationMetadataPayloadSchema>;
export type IntegrationsResponse = z.infer<typeof integrationsResponseSchema>;
