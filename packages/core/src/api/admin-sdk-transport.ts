import { type ApiClient, ApiNativeDownloadUnavailableError, apiClient } from "./client";
import { accountAdminOperations } from "./contracts/account-admin";
import { activityAdminOperations } from "./contracts/activity-admin";
import type { AdminOperation } from "./contracts/admin";
import { dataManagerAdminOperations } from "./contracts/data-manager-admin";
import { extensionAdminOperations } from "./contracts/extension-admin";
import { integrationAdminOperations } from "./contracts/integration-admin";
import { privacyAdminOperations } from "./contracts/privacy-admin";
import { serviceAdminOperations } from "./contracts/service-admin";
import {
  createOperationBinder,
  isEventStreamOperation,
  matchesBoundRequest,
  type OperationRequestOptions,
} from "./operation-transport";

export {
  operationErrorMessage as adminErrorMessage,
  unwrapOperationResponse as unwrapAdminResponse,
} from "./operation-transport";
export type AdminSdkRequestOptions = OperationRequestOptions;
export type AdminBinaryUploadRequestOptions = Omit<
  AdminSdkRequestOptions,
  "body" | "onTextChunk" | "keepalive"
>;
export type AdminByteResponseRequestOptions = Omit<
  AdminSdkRequestOptions,
  "body" | "onTextChunk" | "keepalive"
> & {
  onByteChunk: (chunk: Uint8Array, signal: AbortSignal) => void | Promise<void>;
  onByteHeaders?: (headers: Headers, signal: AbortSignal) => void | Promise<void>;
};
export type { AdminNativeDownloadTarget } from "./client";
export type AdminNativeDownloadTargetOptions = {
  client?: ApiClient;
  signal?: AbortSignal;
  method?: "GET";
  headers?: Readonly<Record<string, never>>;
};
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
  ...accountAdminOperations,
  ...dataManagerAdminOperations,
  ...activityAdminOperations,
  ...integrationAdminOperations,
  ...serviceAdminOperations,
  ...extensionAdminOperations,
  ...privacyAdminOperations,
};
type OperationId = keyof typeof operations;
/** Canonical operation identity and every status validator live in the closure. */
export const bindAdminOperation = createOperationBinder(operations);
export function bindAdminStreamOperation(operationId: OperationId) {
  const operation: AdminOperation = operations[operationId];
  if (!isEventStreamOperation(operation)) throw new Error("Operation is not an EventSource stream");
  return async <T = AdminEventStreamTarget>(
    url: string,
    options: AdminEventStreamTargetOptions = {},
  ): Promise<T> => {
    const supported = new Set(["client", "signal", "method", "headers"]);
    if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !supported.has(key)))
      throw new Error("Unsupported EventSource target options");
    if (!matchesBoundRequest(url, options.method ?? "GET", operation))
      throw new Error("API request does not match its bound operation");
    const query = Object.fromEntries(new URL(url, "https://api.invalid").searchParams);
    if (operation.request?.query && !operation.request.query.safeParse(query).success)
      throw new Error("API stream query violates the contract");
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

type ByteOperationId = {
  [K in OperationId]: Extract<
    (typeof operations)[K]["responses"][keyof (typeof operations)[K]["responses"]],
    { kind: "bytes" }
  > extends never
    ? never
    : K;
}[OperationId];
type BinaryUploadOperationId = {
  [K in OperationId]: (typeof operations)[K] extends { requestBody: { kind: "bytes" } } ? K : never;
}[OperationId];
export function bindAdminByteOperation(operationId: ByteOperationId) {
  return bindAdminOperation(operationId);
}
export function bindAdminBinaryUploadOperation(operationId: BinaryUploadOperationId) {
  return bindAdminOperation(operationId);
}
export function bindAdminDownloadTarget(operationId: ByteOperationId) {
  const operation: AdminOperation = operations[operationId];
  if (
    operation.method !== "GET" ||
    !Object.values(operation.responses).some((c) => c.kind === "bytes" && c.nativeDownload)
  )
    throw Error("Operation cannot construct a native download");
  return async (url: string, options: AdminNativeDownloadTargetOptions = {}) => {
    const supported = new Set(["client", "signal", "method", "headers"]);
    if (Reflect.ownKeys(options).some((k) => typeof k !== "string" || !supported.has(k)))
      throw new ApiNativeDownloadUnavailableError("headers");
    if (!matchesBoundRequest(url, options.method ?? "GET", operation))
      throw new ApiNativeDownloadUnavailableError("origin");
    const parsedUrl = new URL(url, "https://api.invalid"),
      template = operation.path.split("/"),
      segments = parsedUrl.pathname.split("/");
    const params = Object.fromEntries(
      template.flatMap((part, index) =>
        part.startsWith(":") ? [[part.slice(1), decodeURIComponent(segments[index] ?? "")]] : [],
      ),
    );
    if (operation.request?.params && !operation.request.params.safeParse(params).success)
      throw new ApiNativeDownloadUnavailableError("origin");
    if (!operation.request?.query && parsedUrl.search)
      throw new ApiNativeDownloadUnavailableError("origin");
    if (options.headers && Reflect.ownKeys(options.headers).length)
      throw new ApiNativeDownloadUnavailableError("headers");
    if (
      operation.request?.query &&
      !operation.request.query.safeParse(
        Object.fromEntries(new URL(url, "https://api.invalid").searchParams),
      ).success
    )
      throw new ApiNativeDownloadUnavailableError("origin");
    options.signal?.throwIfAborted();
    return (options.client ?? apiClient).downloadTarget(url);
  };
}
