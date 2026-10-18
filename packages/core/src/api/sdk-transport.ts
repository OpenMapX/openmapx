import type { ZodType } from "zod";
import { type ApiClient, type ApiRequestOptions, apiClient } from "./client";

export class ApiContractError extends Error {
  constructor(readonly status: number) {
    super(`API response did not match its contract (status ${status})`);
    this.name = "ApiContractError";
  }
}

export type SdkRequestOptions = Omit<RequestInit, "signal" | "credentials"> &
  ApiRequestOptions & {
    client?: ApiClient;
    /** Supplied by generated operations, never an endpoint-to-schema dispatch table. */
    schema?: ZodType;
    /** Generated from the operation's OpenAPI responses. */
    declaredStatuses?: readonly number[];
  };

interface SdkResponse {
  status: number;
  data: unknown;
  headers: Headers;
}

/** Orval's documented mutator boundary; acquisition stays with ApiClient. */
export async function sdkRequest<T extends SdkResponse = SdkResponse>(
  url: string,
  options: SdkRequestOptions = {},
): Promise<T> {
  const {
    client = apiClient,
    schema,
    signal,
    timeoutMs,
    cache,
    headers,
    declaredStatuses = [200],
    ...init
  } = options;
  const response = await client.request(
    url,
    init,
    async (res): Promise<SdkResponse> => {
      if (!declaredStatuses.includes(res.status)) throw new ApiContractError(res.status);
      if (res.status === 304) return { status: 304, data: undefined, headers: res.headers };
      // The current generated family declares 200 JSON and a bodyless 304.
      if (res.status !== 200 || !schema) throw new ApiContractError(res.status);
      const mediaType = res.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
        throw new ApiContractError(res.status);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ApiContractError(res.status);
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new ApiContractError(res.status);
      return { status: res.status, data: parsed.data, headers: res.headers };
    },
    {
      signal,
      timeoutMs,
      cache,
      headers,
      acceptedStatuses: declaredStatuses.includes(304) ? [304] : [],
    },
  );
  // Orval supplies T and its matching validator together. The body is validated
  // above; this single generic envelope boundary connects that runtime proof to
  // the generated status-discriminated return type, without asserting raw JSON.
  return response as T;
}
