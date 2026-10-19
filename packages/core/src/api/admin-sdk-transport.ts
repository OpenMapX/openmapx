import { readBoundedJsonResponse } from "../utils/fetchJson";
import {
  type ApiClient,
  ApiClientError,
  type ApiRequestOptions,
  apiClient,
  parseRetryAfter,
} from "./client";
import {
  type DataManagerAdminOperation,
  dataManagerAdminOperations,
} from "./contracts/data-manager-admin";
import { ApiContractError } from "./sdk-transport";

export type AdminSdkRequestOptions = Omit<RequestInit, "signal" | "credentials"> &
  ApiRequestOptions & {
    client?: ApiClient;
    maxJsonBytes?: number;
    maxErrorBytes?: number;
  };
type OperationId = keyof typeof dataManagerAdminOperations;
interface AdminResponse {
  status: number;
  headers: Headers;
  data: unknown;
}
function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0)
    throw new Error("Administration JSON limits must be positive finite numbers");
  return result;
}
function matchesBoundRequest(
  url: string,
  method: string,
  operation: { path: string; method: string },
): boolean {
  if (!url.startsWith("/") || url.startsWith("//") || method.toUpperCase() !== operation.method)
    return false;
  const path = new URL(url, "https://api.invalid");
  if (path.origin !== "https://api.invalid" || path.hash) return false;
  const expected = operation.path.split("/");
  const actual = path.pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) =>
      segment.startsWith(":") ? Boolean(actual[index]) : segment === actual[index],
    )
  );
}

/** Canonical operation identity and status validators live in the closure. */
export function bindAdminOperation(operationId: OperationId) {
  return async <T = AdminResponse>(
    url: string,
    options: AdminSdkRequestOptions = {},
  ): Promise<T> => {
    const operation: DataManagerAdminOperation = dataManagerAdminOperations[operationId];
    const {
      client = apiClient,
      signal,
      timeoutMs,
      cache,
      headers,
      maxJsonBytes,
      maxErrorBytes,
      method = "GET",
      body,
      integrity,
      keepalive,
      mode,
      referrer,
      referrerPolicy,
    } = options;
    if (!matchesBoundRequest(url, method, operation))
      throw new Error("Administration request does not match its bound operation");
    const successBudget = positive(maxJsonBytes, 8 * 1024 * 1024);
    const errorBudget = positive(maxErrorBytes, 64 * 1024);
    const responses = operation.responses;
    const result = await client.request(
      url,
      { method, body, integrity, keepalive, mode, referrer, referrerPolicy },
      async (response, effectiveSignal): Promise<AdminResponse> => {
        const contract = responses[response.status];
        if (!contract) throw new ApiContractError(response.status);
        const mediaType = response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        if (mediaType !== "application/json" && !mediaType?.endsWith("+json"))
          throw new ApiContractError(response.status);
        if (contract.headers) {
          const values: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            values[name.toLowerCase()] = value;
          });
          try {
            if (!contract.headers.safeParse(values).success)
              throw new ApiContractError(response.status);
          } catch {
            throw new ApiContractError(response.status);
          }
        }
        let body: unknown;
        try {
          body = await readBoundedJsonResponse(response, {
            maxBytes: response.ok ? successBudget : errorBudget,
            signal: effectiveSignal,
            label: "Administration response",
          });
        } catch (error) {
          if (effectiveSignal.aborted) throw error;
          throw new ApiContractError(response.status);
        }
        try {
          const parsed = contract.schema.safeParse(body);
          if (!parsed.success) throw new ApiContractError(response.status);
          return { status: response.status, headers: response.headers, data: parsed.data };
        } catch {
          throw new ApiContractError(response.status);
        }
      },
      // The bound contract owns every status. Reject unknown results before
      // reading their bodies rather than entering ApiClient's generic parser.
      { signal, timeoutMs, cache, headers, acceptedStatuses: "all" },
    );
    return result as T;
  };
}

type Success<T> = T extends { status: infer S extends number }
  ? `${S}` extends `2${string}`
    ? T
    : never
  : never;
export function unwrapAdminResponse<T extends { status: number; headers: Headers; data: unknown }>(
  response: T,
): Success<T> extends { data: infer D } ? D : never {
  if (response.status < 200 || response.status >= 300)
    throw new ApiClientError(
      response.status,
      response.data,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  return response.data as Success<T> extends { data: infer D } ? D : never;
}
/** Opt-in feature display; generic errors/logging retain their redacted message. */
export function adminErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError) || !error.payload || typeof error.payload !== "object")
    return fallback;
  const payload = error.payload as Record<string, unknown>;
  for (const key of ["errorMessage", "error", "message", "reason"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.slice(0, 512);
  }
  return fallback;
}
