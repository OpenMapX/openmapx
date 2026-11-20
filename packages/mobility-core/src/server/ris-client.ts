const RIS_BASE_URLS = {
  stations: "https://apis.deutschebahn.com/db/apis/ris-stations/v1",
  routing: "https://apis.deutschebahn.com/db/apis/ris-routing/v2",
  maps: "https://apis.deutschebahn.com/db/apis/ris-maps/v2",
  transports: "https://apis.deutschebahn.com/db/apis/ris-transports/v3",
} as const;

const RIS_MEDIA_TYPE = "application/vnd.de.db.ris+json";

export type RisApi = keyof typeof RIS_BASE_URLS;

export interface RisCredentials {
  clientId?: string;
  apiKey?: string;
}

interface RisRequestOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * The JSON requests the RIS client needs. The integration host's `ctx.http`
 * satisfies it: a non-2xx answer rejects with its status, and the key headers
 * make it refuse redirects.
 */
export interface RisHttp {
  get<T>(url: string, options: RisRequestOptions): Promise<T>;
  post<T>(url: string, body: unknown, options: RisRequestOptions): Promise<T>;
}

export interface RisClient {
  isConfigured(): boolean;
  get<T>(api: RisApi, path: string, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
  post<T>(
    api: RisApi,
    path: string,
    body: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
}

export function createRisClient(credentials: RisCredentials, http: RisHttp): RisClient {
  const clientId = credentials.clientId?.trim() || undefined;
  const apiKey = credentials.apiKey?.trim() || undefined;

  function headers(): Record<string, string> {
    if (!clientId || !apiKey) throw new Error("DB RIS credentials not configured");
    return {
      "DB-Client-ID": clientId,
      "DB-Api-Key": apiKey,
      Accept: RIS_MEDIA_TYPE,
    };
  }

  async function request<T>(
    api: RisApi,
    path: string,
    method: "GET" | "POST",
    send: (url: string) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    signal?.throwIfAborted();
    try {
      return await send(`${RIS_BASE_URLS[api]}${path}`);
    } catch (error) {
      signal?.throwIfAborted();
      const detail = error instanceof Error ? error.message : "request failed";
      throw new Error(`RIS ${api} ${method} ${path} failed: ${detail}`, { cause: error });
    }
  }

  return {
    isConfigured: () => clientId !== undefined && apiKey !== undefined,

    async get<T>(api: RisApi, path: string, timeoutMs = 6_000, signal?: AbortSignal): Promise<T> {
      const options = { headers: headers(), timeoutMs, ...(signal ? { signal } : {}) };
      return request<T>(api, path, "GET", (url) => http.get<T>(url, options), signal);
    },

    async post<T>(
      api: RisApi,
      path: string,
      body: unknown,
      timeoutMs = 8_000,
      signal?: AbortSignal,
    ): Promise<T> {
      const options = { headers: headers(), timeoutMs, ...(signal ? { signal } : {}) };
      return request<T>(api, path, "POST", (url) => http.post<T>(url, body, options), signal);
    },
  };
}
