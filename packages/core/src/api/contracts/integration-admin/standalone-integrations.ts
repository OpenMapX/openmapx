import z from "zod/v4";
import { standaloneInstallSourceSchema } from "../../../ops/standalone-integrations";
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
export const standaloneIntegrationAdminOperations = {
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
  standaloneInstallInspectionSchema,
  standaloneInstallSourceSchema,
} from "../../../ops/standalone-integrations";
