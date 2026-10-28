import z from "zod/v4";
import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";
import { integrationApplyReceiptSchema } from "./application";
import {
  adminIntegrationBindingDeleteSchema,
  adminIntegrationBindingParamsSchema,
  adminIntegrationBindingSetSchema,
  adminIntegrationBindingsSchema,
  adminIntegrationConfigExportSchema,
  adminIntegrationConfigImportedSchema,
  adminIntegrationConfigImportSchema,
  adminIntegrationConfigPatchSchema,
  adminIntegrationConfigUpdatedSchema,
  adminIntegrationCredentialParamsSchema,
  adminIntegrationDetailSchema,
  adminIntegrationEmptyMutationSchema,
  adminIntegrationEnvVarsSchema,
  adminIntegrationIdempotencyHeadersSchema,
  adminIntegrationImportFailureSchema,
  adminIntegrationParamsSchema,
  adminIntegrationRefParamsSchema,
  adminIntegrationReloadAcceptedSchema,
  adminIntegrationReloadResultSchema,
  adminIntegrationSummarySchema,
  adminIntegrationValidationErrorSchema,
  adminIntegrationVaultUnavailableSchema,
} from "./common";
import {
  adminCredentialsSchema,
  adminIntegrationCredentialSetSchema,
  adminIntegrationCredentialsSchema,
  adminIntegrationCredentialTestRequestSchema,
  adminIntegrationCredentialTestSchema,
} from "./credentials";
import {
  adminIntegrationHealthHistoryQuerySchema,
  adminIntegrationHealthHistorySchema,
  adminIntegrationHealthResponseSchema,
  adminIntegrationHealthSweepSchema,
} from "./health";
import { adminOverviewSchema } from "./overview";

const common = adminCommonResponses;
const missing = { ...common, 404: adminJson(httpErrorSchema) };
const configErrors = adminJson(z.union([httpErrorSchema, adminIntegrationValidationErrorSchema]));
const mutation = {
  params: adminIntegrationParamsSchema,
  body: adminIntegrationEmptyMutationSchema,
};
const reloaded = {
  ...missing,
  200: adminJson(adminIntegrationReloadResultSchema),
  409: adminJson(httpErrorSchema),
};
const _ok = adminJson(z.strictObject({ ok: z.literal(true) }));

/** Complete integration/credential/overview family. Authentication metadata never enforces access. */
export const integrationAdminOperations = {
  listAdminIntegrations: {
    method: "GET",
    path: "/api/admin/integrations",
    auth: "admin",
    responses: { ...common, 200: adminJson(z.array(adminIntegrationSummarySchema)) },
  },
  getAdminIntegration: {
    method: "GET",
    path: "/api/admin/integrations/:id",
    auth: "admin",
    request: { params: adminIntegrationParamsSchema },
    responses: { ...missing, 200: adminJson(adminIntegrationDetailSchema) },
  },
  listAdminIntegrationEnvVars: {
    method: "GET",
    path: "/api/admin/integrations/env-vars",
    auth: "admin",
    responses: { ...common, 200: adminJson(adminIntegrationEnvVarsSchema) },
  },
  exportAdminIntegrationConfigs: {
    method: "GET",
    path: "/api/admin/integrations/export",
    auth: "admin",
    responses: { ...common, 200: adminJson(adminIntegrationConfigExportSchema) },
  },
  importAdminIntegrationConfigs: {
    method: "POST",
    path: "/api/admin/integrations/import",
    auth: "admin",
    request: {
      body: adminIntegrationConfigImportSchema,
      headers: adminIntegrationIdempotencyHeadersSchema,
    },
    responses: {
      ...common,
      400: configErrors,
      200: adminJson(adminIntegrationConfigImportedSchema),
      409: adminJson(z.union([adminIntegrationImportFailureSchema, httpErrorSchema])),
    },
  },
  runAdminIntegrationHealthChecks: {
    method: "POST",
    path: "/api/admin/integrations/health/run",
    auth: "admin",
    request: { body: adminIntegrationEmptyMutationSchema },
    responses: { ...common, 200: adminJson(adminIntegrationHealthSweepSchema) },
  },
  reloadAdminIntegrations: {
    method: "POST",
    path: "/api/admin/integrations/reload",
    auth: "admin",
    request: { body: adminIntegrationEmptyMutationSchema },
    responses: { ...common, 200: adminJson(adminIntegrationReloadAcceptedSchema) },
  },
  patchAdminIntegrationConfig: {
    method: "PATCH",
    path: "/api/admin/integrations/:id/config",
    auth: "admin",
    request: {
      params: adminIntegrationParamsSchema,
      body: adminIntegrationConfigPatchSchema,
      headers: adminIntegrationIdempotencyHeadersSchema,
    },
    responses: {
      ...missing,
      400: configErrors,
      200: adminJson(adminIntegrationConfigUpdatedSchema),
      409: adminJson(httpErrorSchema),
    },
  },
  enableAdminIntegration: {
    method: "POST",
    path: "/api/admin/integrations/:id/enable",
    auth: "admin",
    request: { ...mutation, headers: adminIntegrationIdempotencyHeadersSchema },
    responses: reloaded,
  },
  disableAdminIntegration: {
    method: "POST",
    path: "/api/admin/integrations/:id/disable",
    auth: "admin",
    request: { ...mutation, headers: adminIntegrationIdempotencyHeadersSchema },
    responses: reloaded,
  },
  getAdminIntegrationHealth: {
    method: "GET",
    path: "/api/admin/integrations/:id/health",
    auth: "admin",
    request: { params: adminIntegrationParamsSchema },
    responses: { ...missing, 200: adminJson(adminIntegrationHealthResponseSchema) },
  },
  getAdminIntegrationHealthHistory: {
    method: "GET",
    path: "/api/admin/integrations/:id/health/history",
    auth: "admin",
    request: {
      params: adminIntegrationParamsSchema,
      query: adminIntegrationHealthHistoryQuerySchema,
    },
    responses: { ...missing, 200: adminJson(adminIntegrationHealthHistorySchema) },
  },
  reloadAdminIntegration: {
    method: "POST",
    path: "/api/admin/integrations/:id/reload",
    auth: "admin",
    request: mutation,
    responses: { ...missing, 200: adminJson(adminIntegrationReloadAcceptedSchema) },
  },
  listAdminIntegrationBindings: {
    method: "GET",
    path: "/api/admin/integrations/:integrationId/bindings",
    auth: "admin",
    request: { params: adminIntegrationRefParamsSchema },
    responses: { ...common, 200: adminJson(adminIntegrationBindingsSchema) },
  },
  setAdminIntegrationBinding: {
    method: "POST",
    path: "/api/admin/integrations/:integrationId/bindings/:capability",
    auth: "admin",
    request: {
      params: adminIntegrationBindingParamsSchema,
      headers: adminIntegrationIdempotencyHeadersSchema,
      body: adminIntegrationBindingSetSchema,
    },
    responses: {
      ...common,
      409: adminJson(httpErrorSchema),
      503: adminJson(httpErrorSchema),
      200: adminJson(integrationApplyReceiptSchema),
    },
  },
  deleteAdminIntegrationBinding: {
    method: "DELETE",
    path: "/api/admin/integrations/:integrationId/bindings/:capability",
    auth: "admin",
    request: {
      params: adminIntegrationBindingParamsSchema,
      headers: adminIntegrationIdempotencyHeadersSchema,
      body: adminIntegrationBindingDeleteSchema,
    },
    responses: {
      ...common,
      409: adminJson(httpErrorSchema),
      503: adminJson(httpErrorSchema),
      200: adminJson(integrationApplyReceiptSchema),
    },
  },
  listAdminCredentials: {
    method: "GET",
    path: "/api/admin/credentials",
    auth: "admin",
    responses: { ...common, 200: adminJson(adminCredentialsSchema) },
  },
  getAdminIntegrationCredentials: {
    method: "GET",
    path: "/api/admin/credentials/:integrationId",
    auth: "admin",
    request: { params: adminIntegrationRefParamsSchema },
    responses: { ...missing, 200: adminJson(adminIntegrationCredentialsSchema) },
  },
  testAdminIntegrationCredentials: {
    method: "POST",
    path: "/api/admin/credentials/:integrationId/test",
    auth: "admin",
    request: {
      params: adminIntegrationRefParamsSchema,
      body: adminIntegrationCredentialTestRequestSchema,
    },
    responses: { ...missing, 200: adminJson(adminIntegrationCredentialTestSchema) },
  },
  setAdminIntegrationCredential: {
    method: "PUT",
    path: "/api/admin/credentials/:integrationId/:key",
    auth: "admin",
    request: {
      headers: adminIntegrationIdempotencyHeadersSchema,
      params: adminIntegrationCredentialParamsSchema,
      body: adminIntegrationCredentialSetSchema,
    },
    responses: {
      ...reloaded,
      503: adminJson(z.union([httpErrorSchema, adminIntegrationVaultUnavailableSchema])),
    },
  },
  deleteAdminIntegrationCredential: {
    method: "DELETE",
    path: "/api/admin/credentials/:integrationId/:key",
    auth: "admin",
    request: {
      headers: adminIntegrationIdempotencyHeadersSchema,
      params: adminIntegrationCredentialParamsSchema,
      body: adminIntegrationEmptyMutationSchema,
    },
    responses: reloaded,
  },
  getAdminOverview: {
    method: "GET",
    path: "/api/admin/overview",
    auth: "admin",
    responses: { ...common, 200: adminJson(adminOverviewSchema) },
  },
} as const satisfies Record<string, AdminOperation>;
export type IntegrationAdminOperationId = keyof typeof integrationAdminOperations;
