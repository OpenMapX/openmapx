/**
 * Thin fetch wrapper for the OpenMapX API gateway (`apps/api`).
 * All frontend data fetching goes through this client — never directly
 * to Pelias / OSRM / Valhalla.
 */

export interface ApiClientConfig {
  baseUrl: string;
  credentials?: RequestCredentials;
  headerInterceptor?: () => Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let _config: ApiClientConfig | null = null;

export function configureApiClient(config: ApiClientConfig): void {
  _config = config;
}

function getConfig(): ApiClientConfig {
  if (!_config) {
    return {
      baseUrl:
        typeof window !== "undefined"
          ? (process.env.NEXT_PUBLIC_API_URL ??
            process.env.EXPO_PUBLIC_API_URL ??
            "http://localhost:3001")
          : "http://localhost:3001",
      credentials: "include",
    };
  }
  return _config;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateMessage(value: string): string {
  return [...value].slice(0, 200).join("");
}

async function safeApiError(response: Response): Promise<ApiError> {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (isJsonObject(parsed)) body = parsed;
  } catch {
    // Error bodies are deliberately discarded when they are not safe JSON objects.
  }
  const suppliedMessage = typeof body?.error === "string" ? body.error.trim() : "";
  const message = suppliedMessage
    ? truncateMessage(suppliedMessage)
    : `Request failed (HTTP ${response.status})`;
  const code = typeof body?.code === "string" ? body.code : null;
  const retryAfterSeconds =
    typeof body?.retryAfterSeconds === "number" &&
    Number.isFinite(body.retryAfterSeconds) &&
    body.retryAfterSeconds >= 0
      ? body.retryAfterSeconds
      : null;
  return new ApiError(message, response.status, code, retryAfterSeconds);
}

async function parseApiResponse<T>(
  response: Response,
  successfulEmpty: "json" | "null-on-204" | "undefined-on-empty" = "json",
): Promise<T> {
  if (!response.ok) throw await safeApiError(response);
  if (successfulEmpty === "null-on-204" && response.status === 204) return null as T;
  if (successfulEmpty === "undefined-on-empty") {
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
  return response.json() as Promise<T>;
}

export class ApiClient {
  async get<T>(
    path: string,
    params?: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const cfg = getConfig();
    const url = new URL(path, cfg.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", ...cfg.headerInterceptor?.() },
      credentials: cfg.credentials ?? "omit",
      signal: options?.signal,
    });
    return parseApiResponse<T>(res);
  }

  /**
   * Like `get`, but returns `null` when the server responds 204 No Content.
   * Useful for "found / not found" endpoints where absence is a normal answer
   * and shouldn't be modeled as an error (e.g. an enrichment endpoint that has
   * no data for inland places).
   */
  async getOptional<T>(path: string, params?: Record<string, string>): Promise<T | null> {
    const cfg = getConfig();
    const url = new URL(path, cfg.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", ...cfg.headerInterceptor?.() },
      credentials: cfg.credentials ?? "omit",
    });
    return parseApiResponse<T | null>(res, "null-on-204");
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.mutate<T>("POST", path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.mutate<T>("PATCH", path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.mutate<T>("PUT", path, body);
  }

  async delete<T = void>(path: string): Promise<T> {
    const cfg = getConfig();
    const url = new URL(path, cfg.baseUrl);
    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: { Accept: "application/json", ...cfg.headerInterceptor?.() },
      credentials: cfg.credentials ?? "omit",
    });
    return parseApiResponse<T>(res, "undefined-on-empty");
  }

  private async mutate<T>(method: string, path: string, body: unknown): Promise<T> {
    const cfg = getConfig();
    const url = new URL(path, cfg.baseUrl);
    const res = await fetch(url.toString(), {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...cfg.headerInterceptor?.(),
      },
      credentials: cfg.credentials ?? "omit",
      body: JSON.stringify(body),
    });
    return parseApiResponse<T>(res);
  }
}

export const apiClient = new ApiClient();

/**
 * Build the absolute URL for an API path + query params without fetching it.
 * Useful for links the browser navigates to directly (e.g. `window.open` of a
 * redirect endpoint), where a `fetch` would defeat the purpose.
 */
export function apiUrl(path: string, params?: Record<string, string>): string {
  const cfg = getConfig();
  const url = new URL(path, cfg.baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Rewrite an image URL to go through the backend image proxy.
 * This prevents leaking the user's IP address to external image hosts.
 */
export function proxyImageUrl(url: string): string {
  // Only proxy external HTTP(S) URLs
  if (!url.startsWith("http://") && !url.startsWith("https://")) return url;
  const cfg = getConfig();
  return `${cfg.baseUrl}/api/image-proxy?url=${encodeURIComponent(url)}`;
}
