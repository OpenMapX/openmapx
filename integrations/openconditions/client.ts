import { DEFAULT_FETCH_JSON_MAX_BYTES } from "@openmapx/core";
import type { HttpClient } from "@openmapx/integration-framework";

/** Query parameters of one read; an `undefined` value is left out. */
export type OpenConditionsParams = Record<string, string | number | undefined>;

export interface OpenConditionsRequestOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Reads the OpenConditions HTTP API at `OPENCONDITIONS_URL`. With
 * `OPENCONDITIONS_OPERATOR_TOKEN` set, every read carries it as a bearer token:
 * an OpenConditions instance that holds the same token then answers in
 * operator scope, restricted sources included, and marks the response
 * `Cache-Control: private, no-store`. One that holds none answers in public
 * scope, which its `/sources` answer names. No read asks the
 * host for a shared cache, so an operator answer is never stored.
 */
export interface OpenConditionsClient {
  /** `OPENCONDITIONS_URL` without a trailing slash. */
  baseUrl: string;
  get<T>(
    path: string,
    params?: OpenConditionsParams,
    opts?: OpenConditionsRequestOptions,
  ): Promise<T>;
  /** As `get`, but a 404 answer is null rather than an error. */
  getOptional<T>(
    path: string,
    params?: OpenConditionsParams,
    opts?: OpenConditionsRequestOptions,
  ): Promise<T | null>;
}

/** The client of the configured OpenConditions instance, or null when `OPENCONDITIONS_URL` is unset. */
export function createOpenConditionsClient(
  env: NodeJS.ProcessEnv,
  http: HttpClient,
): OpenConditionsClient | null {
  const baseUrl = env.OPENCONDITIONS_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  const token = env.OPENCONDITIONS_OPERATOR_TOKEN?.trim();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const optionsOf = (params?: OpenConditionsParams, opts?: OpenConditionsRequestOptions) => ({
    ...(params ? { params } : {}),
    headers,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return {
    baseUrl,
    async get<T>(path: string, params?: OpenConditionsParams, opts?: OpenConditionsRequestOptions) {
      return http.get<T>(`${baseUrl}${path}`, {
        ...optionsOf(params, opts),
        ...(opts?.maxResponseBytes !== undefined
          ? { maxResponseBytes: opts.maxResponseBytes }
          : {}),
      });
    },
    async getOptional<T>(
      path: string,
      params?: OpenConditionsParams,
      opts?: OpenConditionsRequestOptions,
    ) {
      const res = await http.getResponse<T>(`${baseUrl}${path}`, {
        ...optionsOf(params, opts),
        maxBytes: opts?.maxResponseBytes ?? DEFAULT_FETCH_JSON_MAX_BYTES,
        contentTypes: ["application/json"],
      });
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`OpenConditions ${path} responded ${res.status}`);
      }
      return res.body;
    },
  };
}
