import { type ApiClient, apiClient } from "./client";
import { activityAdminOperations } from "./contracts/activity-admin";
import type { AdminOperation } from "./contracts/admin";
import { dataManagerAdminOperations } from "./contracts/data-manager-admin";
import { extensionAdminOperations } from "./contracts/extension-admin";
import { integrationAdminOperations } from "./contracts/integration-admin";
import { serviceAdminOperations } from "./contracts/service-admin";
import {
  createOperationBinder,
  matchesBoundRequest,
  type OperationRequestOptions,
} from "./operation-transport";

export {
  operationErrorMessage as adminErrorMessage,
  unwrapOperationResponse as unwrapAdminResponse,
} from "./operation-transport";
export function createAdminOperationBinder<const R extends Record<string, AdminOperation>>(
  registry: R,
) {
  return createOperationBinder(registry);
}
export type AdminSdkRequestOptions = OperationRequestOptions;
/** Required consumer for incremental plain text; successful envelope data is undefined. */
export type AdminTextStreamRequestOptions = AdminSdkRequestOptions & {
  onTextChunk: NonNullable<AdminSdkRequestOptions["onTextChunk"]>;
};
/** Constructs a connection target only; the caller owns the subsequent EventSource lifetime. */
export interface AdminEventStreamTargetOptions {
  client?: ApiClient;
  /** Checked before construction only. Aborting later cannot close a browser-owned EventSource. */
  signal?: AbortSignal;
  /** Generated GET bookkeeping; constructing a target never performs a request. */
  method?: "GET";
  /** Generated header containers must be empty. Native EventSource cannot transmit custom headers. */
  headers?: Readonly<Record<string, never>>;
}
export interface AdminEventStreamTarget {
  url: string;
  withCredentials: boolean;
}
const operations = {
  ...dataManagerAdminOperations,
  ...activityAdminOperations,
  ...integrationAdminOperations,
  ...serviceAdminOperations,
  ...extensionAdminOperations,
};
type OperationId = keyof typeof operations;
/** Canonical operation identity and every status validator live in the closure. */
export const bindAdminOperation = createOperationBinder(operations);
export function bindAdminStreamOperation(operationId: OperationId) {
  const operation: AdminOperation = operations[operationId];
  if (
    !Object.values(operation.responses).some(
      (c) => c.kind === "stream" && c.mediaType === "text/event-stream",
    )
  )
    throw new Error("Operation is not an EventSource stream");
  return async <T = AdminEventStreamTarget>(
    url: string,
    options: AdminEventStreamTargetOptions = {},
  ): Promise<T> => {
    const supported = new Set(["client", "signal", "method", "headers"]);
    if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !supported.has(key)))
      throw new Error("Unsupported EventSource target options");
    if (!matchesBoundRequest(url, options.method ?? "GET", operation))
      throw new Error("Administration request does not match its bound operation");
    const query = Object.fromEntries(new URL(url, "https://api.invalid").searchParams);
    if (operation.request?.query && !operation.request.query.safeParse(query).success)
      throw new Error("Administration stream query violates the contract");
    const headers = options.headers;
    const hasHeaders =
      headers instanceof Headers
        ? !headers.keys().next().done
        : Array.isArray(headers)
          ? headers.length > 0
          : headers && typeof headers === "object"
            ? Reflect.ownKeys(headers).length > 0
            : headers !== undefined;
    if (hasHeaders) throw new Error("EventSource cannot honor request headers");
    options.signal?.throwIfAborted();
    return (options.client ?? apiClient).connectionTarget(url) as T;
  };
}
