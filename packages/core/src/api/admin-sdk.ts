/** Browser administration bindings use application API credentials, never service tokens. */

export {
  type AdminEventStreamTarget,
  type AdminEventStreamTargetOptions,
  type AdminSdkRequestOptions,
  adminErrorMessage,
  unwrapAdminResponse,
} from "./admin-sdk-transport";
export * from "./contracts/activity-admin";
export * from "./generated/admin/data-manager-admin.generated";
