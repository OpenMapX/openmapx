import z from "zod/v4";
import {
  standaloneInstallSourceSchema,
  standaloneInventoryEntrySchema,
} from "../../../ops/standalone-integrations";
import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";
import { adminIntegrationIdempotencyHeadersSchema } from "./common";
export const standaloneInstallRequestSchema = z.strictObject({
  inspectionId: z.uuid(),
  expectedContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const standalonePreviewRequestSchema = z.strictObject({
  source: standaloneInstallSourceSchema,
});
export const standaloneJobAcceptedSchema = z.strictObject({
  jobId: z.uuid(),
  operationId: z.uuid(),
});
const responses = {
  ...adminCommonResponses,
  202: adminJson(standaloneJobAcceptedSchema),
  409: adminJson(httpErrorSchema),
  503: adminJson(httpErrorSchema),
};
export const standaloneOwnershipParamsSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
});
export const standaloneOwnershipRequestSchema = z.strictObject({
  expectedContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const standaloneRemovalRequestSchema = standaloneOwnershipRequestSchema.extend({
  expectedContentDigest: standaloneOwnershipRequestSchema.shape.expectedContentDigest.nullable(),
});
export const standaloneIntegrationAdminOperations = {
  listAdminStandaloneIntegrations: {
    method: "GET",
    path: "/api/admin/standalone-integrations",
    auth: "admin",
    responses: {
      ...adminCommonResponses,
      200: adminJson(
        z.strictObject({ entries: z.array(standaloneInventoryEntrySchema).max(2048) }),
      ),
    },
  },
  adoptAdminStandaloneIntegration: {
    method: "POST",
    path: "/api/admin/standalone-integrations/:id/adopt",
    auth: "admin",
    request: {
      params: standaloneOwnershipParamsSchema,
      body: standaloneOwnershipRequestSchema,
      headers: adminIntegrationIdempotencyHeadersSchema,
    },
    responses,
  },
  removeAdminStandaloneIntegration: {
    method: "POST",
    path: "/api/admin/standalone-integrations/:id/remove",
    auth: "admin",
    request: {
      params: standaloneOwnershipParamsSchema,
      body: standaloneRemovalRequestSchema,
      headers: adminIntegrationIdempotencyHeadersSchema,
    },
    responses,
  },
  previewAdminStandaloneIntegration: {
    method: "POST",
    path: "/api/admin/standalone-integrations/preview",
    auth: "admin",
    request: {
      body: standalonePreviewRequestSchema,
      headers: adminIntegrationIdempotencyHeadersSchema,
    },
    responses,
  },
  installAdminStandaloneIntegration: {
    method: "POST",
    path: "/api/admin/standalone-integrations/install",
    auth: "admin",
    request: {
      body: standaloneInstallRequestSchema,
      headers: adminIntegrationIdempotencyHeadersSchema,
    },
    responses,
  },
} as const satisfies Record<string, AdminOperation>;

// Browser-safe schemas; clients must not import the server operations barrel.
export {
  type StandaloneInstallInspection,
  type StandaloneInstallSource,
  type StandaloneInventoryEntry,
  standaloneInstallInspectionSchema,
  standaloneInstallSourceSchema,
  standaloneInventoryEntrySchema,
} from "../../../ops/standalone-integrations";
