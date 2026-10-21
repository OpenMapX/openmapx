import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";
import {
  adminExtensionCatalogDetailSchema,
  adminExtensionCatalogQuerySchema,
  adminExtensionCatalogSchema,
} from "./catalog";
import {
  adminExtensionAcceptedSchema,
  adminExtensionEmptyMutationSchema,
  adminExtensionOkSchema,
  adminExtensionParamsSchema,
  adminExtensionRefreshSchema,
  adminExtensionSourceAddSchema,
  adminExtensionSourceRemoveSchema,
  adminExtensionSourcesSchema,
} from "./common";
import { adminExtensionInstalledListSchema } from "./installed";
import {
  adminExtensionInstallPreviewSchema,
  adminExtensionInstallRequestSchema,
  adminExtensionUpdateRequestSchema,
} from "./preview";

export * from "./catalog";
export * from "./common";
export * from "./installed";
export * from "./preview";

/** Complete finite JSON family. Authentication metadata never grants access. */
export const extensionAdminOperations = {
  listAdminExtensionCatalog: {
    method: "GET",
    path: "/api/admin/extensions/catalog",
    auth: "admin",
    request: { query: adminExtensionCatalogQuerySchema },
    responses: { ...adminCommonResponses, 200: adminJson(adminExtensionCatalogSchema) },
  },
  getAdminExtensionCatalogEntry: {
    method: "GET",
    path: "/api/admin/extensions/catalog/:id",
    auth: "admin",
    request: { params: adminExtensionParamsSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminExtensionCatalogDetailSchema),
      404: adminJson(httpErrorSchema),
    },
  },
  listAdminInstalledExtensions: {
    method: "GET",
    path: "/api/admin/extensions/installed",
    auth: "admin",
    responses: { ...adminCommonResponses, 200: adminJson(adminExtensionInstalledListSchema) },
  },
  previewAdminExtensionInstall: {
    method: "POST",
    path: "/api/admin/extensions/install-preview",
    auth: "admin",
    request: { body: adminExtensionInstallRequestSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminExtensionInstallPreviewSchema),
      404: adminJson(httpErrorSchema),
    },
  },
  installAdminExtension: {
    method: "POST",
    path: "/api/admin/extensions/install",
    auth: "admin",
    request: { body: adminExtensionInstallRequestSchema },
    responses: {
      ...adminCommonResponses,
      202: adminJson(adminExtensionAcceptedSchema),
      404: adminJson(httpErrorSchema),
    },
  },
  updateAdminExtension: {
    method: "POST",
    path: "/api/admin/extensions/update/:id",
    auth: "admin",
    request: { params: adminExtensionParamsSchema, body: adminExtensionUpdateRequestSchema },
    responses: { ...adminCommonResponses, 202: adminJson(adminExtensionAcceptedSchema) },
  },
  removeAdminExtension: {
    method: "DELETE",
    path: "/api/admin/extensions/:id",
    auth: "admin",
    request: { params: adminExtensionParamsSchema, body: adminExtensionEmptyMutationSchema },
    responses: { ...adminCommonResponses, 202: adminJson(adminExtensionAcceptedSchema) },
  },
  listAdminExtensionSources: {
    method: "GET",
    path: "/api/admin/extensions/sources",
    auth: "admin",
    responses: { ...adminCommonResponses, 200: adminJson(adminExtensionSourcesSchema) },
  },
  addAdminExtensionSource: {
    method: "POST",
    path: "/api/admin/extensions/sources",
    auth: "admin",
    request: { body: adminExtensionSourceAddSchema },
    responses: { ...adminCommonResponses, 200: adminJson(adminExtensionOkSchema) },
  },
  removeAdminExtensionSource: {
    method: "DELETE",
    path: "/api/admin/extensions/sources",
    auth: "admin",
    request: { body: adminExtensionSourceRemoveSchema },
    responses: { ...adminCommonResponses, 200: adminJson(adminExtensionOkSchema) },
  },
  refreshAdminExtensionCatalog: {
    method: "POST",
    path: "/api/admin/extensions/refresh-catalog",
    auth: "admin",
    request: { body: adminExtensionEmptyMutationSchema },
    responses: { ...adminCommonResponses, 200: adminJson(adminExtensionRefreshSchema) },
  },
} as const satisfies Record<string, AdminOperation>;
export type ExtensionAdminOperationId = keyof typeof extensionAdminOperations;
