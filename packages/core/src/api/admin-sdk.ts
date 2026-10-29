/** Browser administration bindings use application API credentials, never service tokens. */

export {
  type AdminBinaryUploadRequestOptions,
  type AdminByteResponseRequestOptions,
  type AdminEventStreamTarget,
  type AdminEventStreamTargetOptions,
  type AdminNativeDownloadTarget,
  type AdminNativeDownloadTargetOptions,
  type AdminSdkRequestOptions,
  type AdminTextStreamRequestOptions,
  adminErrorMessage,
  unwrapAdminResponse,
} from "./admin-sdk-transport";
export * from "./contracts/account-admin";
export * from "./contracts/activity-admin";
export * from "./contracts/extension-admin";
export * from "./contracts/integration-admin";
export * from "./contracts/service-admin";
export * from "./generated/admin/account-admin.generated";
export * from "./generated/admin/activity-admin.generated";
export * from "./generated/admin/data-manager-admin.generated";
export * from "./generated/admin/extension-admin.generated";
export * from "./generated/admin/integration-admin.generated";
export * from "./generated/admin/service-admin.generated";
