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

export class ApiClient {
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
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
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
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
    if (res.status === 204) return null;
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
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
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text()}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
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
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }
}

export const apiClient = new ApiClient();

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
