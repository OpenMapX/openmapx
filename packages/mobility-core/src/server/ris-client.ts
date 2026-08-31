import type { MobilityHttpRequestOptions, MobilityHttpTransport } from "../json-transport.js";

const RIS_BASE_URLS = {
  stations: "https://apis.deutschebahn.com/db/apis/ris-stations/v1",
  routing: "https://apis.deutschebahn.com/db/apis/ris-routing/v2",
  maps: "https://apis.deutschebahn.com/db/apis/ris-maps/v2",
  transports: "https://apis.deutschebahn.com/db/apis/ris-transports/v3",
} as const;

const RIS_ORIGIN = "https://apis.deutschebahn.com";
const RIS_MEDIA_TYPE = "application/vnd.de.db.ris+json";

export type RisApi = keyof typeof RIS_BASE_URLS;

export interface RisCredentials {
  clientId?: string;
  apiKey?: string;
}

export interface RisClient {
  isConfigured(): boolean;
  get<T>(api: RisApi, path: string, timeoutMs?: number): Promise<T>;
  post<T>(api: RisApi, path: string, body: unknown, timeoutMs?: number): Promise<T>;
}

export function createRisClient(
  credentials: RisCredentials,
  transport: MobilityHttpTransport,
): RisClient {
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
    options: Omit<MobilityHttpRequestOptions, "method">,
  ): Promise<T> {
    try {
      return await transport.fetchJson<T>(`${RIS_BASE_URLS[api]}${path}`, {
        ...options,
        method,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "request failed";
      throw new Error(`RIS ${api} ${method} ${path} failed: ${detail}`, { cause: error });
    }
  }

  return {
    isConfigured: () => clientId !== undefined && apiKey !== undefined,

    async get<T>(api: RisApi, path: string, timeoutMs = 6_000): Promise<T> {
      return request<T>(api, path, "GET", {
        timeoutMs,
        allowedRedirectOrigin: RIS_ORIGIN,
        headers: headers(),
      });
    },

    async post<T>(api: RisApi, path: string, body: unknown, timeoutMs = 8_000): Promise<T> {
      return request<T>(api, path, "POST", {
        body: JSON.stringify(body),
        timeoutMs,
        allowedRedirectOrigin: RIS_ORIGIN,
        headers: { ...headers(), "Content-Type": "application/json" },
      });
    },
  };
}
