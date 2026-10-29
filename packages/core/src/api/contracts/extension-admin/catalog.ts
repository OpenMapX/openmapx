import { extensionManifestSchema } from "@openmapx/extension-contracts/extension";
import z from "zod/v4";
import { adminCountSchema, adminJsonValueSchema } from "../admin";
import { adminJsonWire, preserveManifestJson } from "../manifest-json";
import { adminExtensionComponentKindSchema, adminExtensionTrustSchema } from "./common";

// Unknown scalar choices retain the producer's filtering/sorting fallback semantics.
export const adminExtensionCatalogQuerySchema = z.strictObject({
  q: z.string().optional(),
  category: z.string().optional(),
  trust: z.string().optional(),
  type: z.string().optional(),
  sort: z.string().optional(),
});
const service = preserveManifestJson(
  extensionManifestSchema.shape.services.unwrap().element,
).catchall(adminJsonValueSchema);
const integration = preserveManifestJson(
  extensionManifestSchema.shape.integrations.unwrap().element,
).catchall(adminJsonValueSchema);
// Catalog entries are spread onto the wire. Preserve inert JSON at those boundaries,
// while validating portable component fields; never parse them as a full manifest.
const base = z
  .object({
    id: z.string(),
    name: z.string(),
    summary: z.string().optional(),
    description: z.string().optional(),
    author: z.string().optional(),
    homepage: z.string().optional(),
    icon: z.string().optional(),
    screenshots: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    version: z.string().optional(),
    minPlatform: z.string().optional(),
    lastUpdated: z.string().optional(),
    manifest: z.string().optional(),
    manifestSha256: extensionManifestSchema.shape.integrations
      .unwrap()
      .element.shape.sha256.optional(),
    services: z.array(service).optional(),
    integrations: z.array(integration).optional(),
    featured: z.boolean().optional(),
    trust: adminExtensionTrustSchema.optional(),
  })
  .catchall(adminJsonValueSchema);
const projection = {
  compatible: z.boolean(),
  platformVersion: z.string(),
  removed: z.string().nullable(),
  critical: z.strictObject({ reason: z.string(), maxVersion: z.string().optional() }).nullable(),
};
export const adminExtensionCatalogStatusSchema = z.enum([
  "verified",
  "community",
  "revoked",
  "stale-revocation-data",
]);
export const adminExtensionCatalogEntrySchema = adminJsonWire(
  base.extend({
    ...projection,
    components: z.strictObject({ services: adminCountSchema, integrations: adminCountSchema }),
    installed: z.boolean(),
    installedVersion: z.string().nullable(),
    hasUpdate: z.boolean(),
    status: adminExtensionCatalogStatusSchema,
  }),
);
export const adminExtensionCatalogDetailSchema = adminJsonWire(
  base.extend({
    ...projection,
    componentList: z.array(
      z.strictObject({ kind: adminExtensionComponentKindSchema, id: z.string() }),
    ),
  }),
);
export const adminExtensionCatalogSchema = z.strictObject({
  entries: z.array(adminExtensionCatalogEntrySchema),
  total: adminCountSchema,
  revocationDataStale: z.boolean(),
});

export type AdminExtensionCatalogQuery = z.infer<typeof adminExtensionCatalogQuerySchema>;
export type AdminExtensionCatalogEntry = z.infer<typeof adminExtensionCatalogEntrySchema>;
export type AdminExtensionCatalogDetail = z.infer<typeof adminExtensionCatalogDetailSchema>;
