import { artifactTransferAdminOperations } from "./artifact-transfers";

export * from "./artifact-transfers";

import z from "zod/v4";
import {
  type AdminOperation,
  adminCommonResponses,
  adminJson,
  adminStream,
  adminText,
  httpErrorSchema,
} from "../admin";
import { configurationSourceOwnedSchema } from "../configuration-ownership";
import {
  adminServiceAcceptedSchema,
  adminServiceCredentialParamsSchema,
  adminServiceEmptyMutationSchema,
  adminServiceFailureSchema,
  adminServiceIdempotencyHeadersSchema,
  adminServiceOkSchema,
  adminServiceParamsSchema,
  adminServiceValidationErrorSchema,
} from "./common";
import {
  adminServiceBackupCreateSchema,
  adminServiceBackupParamsSchema,
  adminServiceBackupRestoreSchema,
  adminServiceBackupsSchema,
  adminServiceDataQuerySchema,
  adminServiceDataSchema,
  adminServiceSelectionSchema,
  adminServiceSelectionSetSchema,
  adminServiceSelectionUpdatedSchema,
} from "./data";
import {
  adminOperationInputErrorSchema,
  adminOperationInputSchema,
  adminOperationParamsSchema,
  adminOperationPreviewSchema,
  adminOperationsSchema,
} from "./operations";
import {
  adminServiceActionSchema,
  adminServiceConfigSchema,
  adminServiceConfigUpdateSchema,
  adminServiceCredentialChangedSchema,
  adminServiceCredentialManagedSchema,
  adminServiceCredentialSetSchema,
  adminServiceCredentialsSchema,
  adminServiceDetailSchema,
  adminServiceLogsQuerySchema,
  adminServicesBulkActionSchema,
  adminServicesCheckedSchema,
  adminServicesSchema,
} from "./services";
import {
  adminDawarichBundleConflictSchema,
  adminDawarichConfirmationErrorSchema,
  adminDawarichConflictSchema,
  adminDawarichInvalidHostSchema,
  adminDawarichProvisionSchema,
  adminDawarichRotateSchema,
  adminDawarichStatusSchema,
  adminDawarichUnavailableSchema,
  adminServiceComposeStartedSchema,
  adminServiceDeploymentSchema,
  adminServiceSharedMobilityParamsSchema,
  adminServiceSharedMobilityRollbackSchema,
  adminServiceSharedMobilitySchema,
} from "./workflows";

export * from "./common";
export * from "./data";
export * from "./operations";
export * from "./services";
export * from "./workflows";

/** Complete service/workflow family. Authentication metadata never grants access. */
export const serviceAdminOperations = {
  ...artifactTransferAdminOperations,
  listAdminServices: {
    method: "GET",
    path: "/api/admin/services",
    auth: "admin",
    responses: { ...adminCommonResponses, 200: adminJson(adminServicesSchema) },
  },
  getAdminService: {
    method: "GET",
    path: "/api/admin/services/:id",
    auth: "admin",
    request: { params: adminServiceParamsSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceDetailSchema),
      404: adminJson(httpErrorSchema),
      503: adminJson(httpErrorSchema),
    },
  },
  getAdminServiceConfig: {
    method: "GET",
    path: "/api/admin/services/:id/config",
    auth: "admin",
    request: { params: adminServiceParamsSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceConfigSchema),
      404: adminJson(httpErrorSchema),
    },
  },
  updateAdminServiceConfig: {
    method: "POST",
    path: "/api/admin/services/:id/config",
    auth: "admin",
    request: {
      params: adminServiceParamsSchema,
      body: adminServiceConfigUpdateSchema,
      headers: adminServiceIdempotencyHeadersSchema,
    },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceOkSchema),
      409: adminJson(z.union([httpErrorSchema, configurationSourceOwnedSchema])),
      404: adminJson(httpErrorSchema),
      400: adminJson(z.union([httpErrorSchema, adminServiceValidationErrorSchema])),
    },
  },
  getAdminServiceCredentials: {
    method: "GET",
    path: "/api/admin/services/:id/credentials",
    auth: "admin",
    request: { params: adminServiceParamsSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceCredentialsSchema),
      404: adminJson(httpErrorSchema),
    },
  },
  setAdminServiceCredential: {
    method: "PUT",
    path: "/api/admin/services/:id/credentials/:key",
    auth: "admin",
    request: {
      params: adminServiceCredentialParamsSchema,
      body: adminServiceCredentialSetSchema,
      headers: adminServiceIdempotencyHeadersSchema,
    },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceCredentialChangedSchema),
      404: adminJson(httpErrorSchema),
      409: adminJson(
        z.union([
          adminServiceCredentialManagedSchema,
          httpErrorSchema,
          configurationSourceOwnedSchema,
        ]),
      ),
    },
  },
  deleteAdminServiceCredential: {
    method: "DELETE",
    path: "/api/admin/services/:id/credentials/:key",
    auth: "admin",
    request: {
      params: adminServiceCredentialParamsSchema,
      body: adminServiceEmptyMutationSchema,
      headers: adminServiceIdempotencyHeadersSchema,
    },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceCredentialChangedSchema),
      404: adminJson(httpErrorSchema),
      409: adminJson(
        z.union([
          adminServiceCredentialManagedSchema,
          httpErrorSchema,
          configurationSourceOwnedSchema,
        ]),
      ),
    },
  },
  streamAdminServiceLogs: {
    method: "GET",
    path: "/api/admin/services/:id/logs",
    auth: "admin",
    request: {
      params: adminServiceParamsSchema,
      query: adminServiceLogsQuerySchema,
      headers: adminServiceIdempotencyHeadersSchema,
    },
    responses: {
      ...adminCommonResponses,
      200: adminStream("text/plain"),
      404: adminJson(httpErrorSchema),
      409: adminJson(z.union([httpErrorSchema, configurationSourceOwnedSchema])),
      503: adminJson(httpErrorSchema),
    },
  },
  runAdminServiceAction: {
    method: "POST",
    path: "/api/admin/services/:id/action",
    auth: "admin",
    request: { params: adminServiceParamsSchema, body: adminServiceActionSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceAcceptedSchema),
      404: adminJson(httpErrorSchema),
      503: adminJson(httpErrorSchema),
    },
  },
  runAdminServicesBulkAction: {
    method: "POST",
    path: "/api/admin/services/bulk-action",
    auth: "admin",
    request: { body: adminServicesBulkActionSchema },
    responses: { ...adminCommonResponses, 200: adminJson(adminServiceAcceptedSchema) },
  },
  checkAdminServices: {
    method: "POST",
    path: "/api/admin/services/check",
    auth: "admin",
    request: { body: adminServiceEmptyMutationSchema },
    responses: { ...adminCommonResponses, 200: adminJson(adminServicesCheckedSchema) },
  },
  getAdminServiceData: {
    method: "GET",
    path: "/api/admin/services/data",
    auth: "admin",
    request: { query: adminServiceDataQuerySchema },
    responses: { ...adminCommonResponses, 200: adminJson(adminServiceDataSchema) },
  },
  getAdminServiceSelection: {
    method: "GET",
    path: "/api/admin/services/selection",
    auth: "admin",
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceSelectionSchema),
      503: adminJson(httpErrorSchema),
    },
  },
  setAdminServiceSelection: {
    method: "PUT",
    path: "/api/admin/services/selection",
    auth: "admin",
    request: {
      body: adminServiceSelectionSetSchema,
      headers: adminServiceIdempotencyHeadersSchema,
    },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceSelectionUpdatedSchema),
      409: adminJson(z.union([httpErrorSchema, configurationSourceOwnedSchema])),
      503: adminJson(httpErrorSchema),
    },
  },
  listAdminServiceBackups: {
    method: "GET",
    path: "/api/admin/services/backups",
    auth: "admin",
    responses: { ...adminCommonResponses, 200: adminJson(adminServiceBackupsSchema) },
  },
  createAdminServiceBackup: {
    method: "POST",
    path: "/api/admin/services/backups",
    auth: "admin",
    request: { body: adminServiceBackupCreateSchema },
    responses: { ...adminCommonResponses, 200: adminJson(adminServiceAcceptedSchema) },
  },
  restoreAdminServiceBackup: {
    method: "POST",
    path: "/api/admin/services/backups/:name/restore",
    auth: "admin",
    request: { params: adminServiceBackupParamsSchema, body: adminServiceBackupRestoreSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceAcceptedSchema),
      404: adminJson(httpErrorSchema),
      409: adminJson(z.union([httpErrorSchema, configurationSourceOwnedSchema])),
    },
  },
  deleteAdminServiceBackup: {
    method: "DELETE",
    path: "/api/admin/services/backups/:name",
    auth: "admin",
    request: { params: adminServiceBackupParamsSchema, body: adminServiceEmptyMutationSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceAcceptedSchema),
      404: adminJson(httpErrorSchema),
    },
  },
  getAdminDeployment: {
    method: "GET",
    path: "/api/admin/deployment",
    auth: "admin",
    responses: { ...adminCommonResponses, 200: adminJson(adminServiceDeploymentSchema) },
  },
  getAdminComposePreview: {
    method: "GET",
    path: "/api/admin/compose/preview",
    auth: "admin",
    responses: {
      ...adminCommonResponses,
      200: adminText(z.string(), "text/yaml"),
      503: adminJson(httpErrorSchema),
    },
  },
  startAdminCompose: {
    method: "POST",
    path: "/api/admin/compose/up",
    auth: "admin",
    request: {
      body: adminServiceEmptyMutationSchema,
      headers: adminServiceIdempotencyHeadersSchema,
    },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceComposeStartedSchema),
      409: adminJson(z.union([httpErrorSchema, configurationSourceOwnedSchema])),
      400: adminJson(z.union([httpErrorSchema, adminServiceFailureSchema])),
    },
  },
  stopAdminCompose: {
    method: "POST",
    path: "/api/admin/compose/down",
    auth: "admin",
    request: { body: adminServiceEmptyMutationSchema },
    responses: { ...adminCommonResponses, 503: adminJson(adminServiceFailureSchema) },
  },
  listAdminOperations: {
    method: "GET",
    path: "/api/admin/operations",
    auth: "admin",
    responses: { ...adminCommonResponses, 200: adminJson(adminOperationsSchema) },
  },
  previewAdminOperation: {
    method: "POST",
    path: "/api/admin/operations/:id/preview",
    auth: "admin",
    request: { params: adminOperationParamsSchema, body: adminOperationInputSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminOperationPreviewSchema),
      400: adminJson(z.union([httpErrorSchema, adminOperationInputErrorSchema])),
      404: adminJson(adminServiceFailureSchema),
    },
  },
  runAdminOperation: {
    method: "POST",
    path: "/api/admin/operations/:id/run",
    auth: "admin",
    request: { params: adminOperationParamsSchema, body: adminOperationInputSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminServiceAcceptedSchema),
      400: adminJson(z.union([httpErrorSchema, adminOperationInputErrorSchema])),
      404: adminJson(adminServiceFailureSchema),
    },
  },
  getAdminSharedMobility: {
    method: "GET",
    path: "/api/admin/shared-mobility",
    auth: "admin",
    responses: { ...adminCommonResponses, 200: adminJson(adminServiceSharedMobilitySchema) },
  },
  rollbackAdminSharedMobility: {
    method: "POST",
    path: "/api/admin/shared-mobility/:category/rollback",
    auth: "admin",
    request: {
      params: adminServiceSharedMobilityParamsSchema,
      body: adminServiceSharedMobilityRollbackSchema,
    },
    responses: { ...adminCommonResponses, 200: adminJson(adminServiceSharedMobilitySchema) },
  },
  getAdminDawarich: {
    method: "GET",
    path: "/api/admin/dawarich",
    auth: "admin",
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminDawarichStatusSchema),
      409: adminJson(adminDawarichConflictSchema),
      422: adminJson(adminDawarichInvalidHostSchema),
      503: adminJson(z.union([httpErrorSchema, adminDawarichUnavailableSchema])),
    },
  },
  provisionAdminDawarich: {
    method: "POST",
    path: "/api/admin/dawarich/provision",
    auth: "admin",
    request: { body: adminDawarichProvisionSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminDawarichStatusSchema),
      409: adminJson(adminDawarichBundleConflictSchema),
      422: adminJson(adminDawarichInvalidHostSchema),
      503: adminJson(z.union([httpErrorSchema, adminDawarichUnavailableSchema])),
    },
  },
  rotateAdminDawarichOidcSecret: {
    method: "POST",
    path: "/api/admin/dawarich/rotate-oidc-secret",
    auth: "admin",
    request: { body: adminDawarichRotateSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminDawarichStatusSchema),
      409: adminJson(adminDawarichBundleConflictSchema),
      422: adminJson(adminDawarichInvalidHostSchema),
      503: adminJson(z.union([httpErrorSchema, adminDawarichUnavailableSchema])),
      400: adminJson(z.union([httpErrorSchema, adminDawarichConfirmationErrorSchema])),
    },
  },
} as const satisfies Record<string, AdminOperation>;
export type ServiceAdminOperationId = keyof typeof serviceAdminOperations;
