/** Browser administration bindings use application API credentials, never service tokens. */

export {
  type AdminSdkRequestOptions,
  adminErrorMessage,
  unwrapAdminResponse,
} from "./admin-sdk-transport";
export * from "./generated/admin/data-manager-admin.generated";
