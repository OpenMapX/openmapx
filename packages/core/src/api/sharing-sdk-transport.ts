import { MAX_PUBLIC_SHARE_JSON_BYTES, sharingOperations } from "./contracts/sharing";
import { createOperationBinder, type OperationRequestOptions } from "./operation-transport";

export type { OperationRequestOptions } from "./operation-transport";
export { unwrapOperationResponse as unwrapSharingResponse } from "./operation-transport";

const bind = createOperationBinder(sharingOperations);
/** Attribution-bearing lists have a separate bounded budget; other defaults stay unchanged. */
export function bindSharingOperation(id: keyof typeof sharingOperations) {
  const request = bind(id);
  return <T>(url: string, options: OperationRequestOptions = {}) =>
    request<T>(url, {
      ...(id === "resolvePublicShare" ? { maxJsonBytes: MAX_PUBLIC_SHARE_JSON_BYTES } : {}),
      ...options,
    });
}
