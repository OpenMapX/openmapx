import { fetchJson } from "./utils/fetchJson";

const RIS_BASE_URLS = {
  stations: "https://apis.deutschebahn.com/db/apis/ris-stations/v1",
  routing: "https://apis.deutschebahn.com/db/apis/ris-routing/v2",
  maps: "https://apis.deutschebahn.com/db/apis/ris-maps/v2",
  transports: "https://apis.deutschebahn.com/db/apis/ris-transports/v3",
} as const;

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

export function createRisClient(credentials: RisCredentials = {}): RisClient {
  const clientId = credentials.clientId?.length ? credentials.clientId : undefined;
  const apiKey = credentials.apiKey?.length ? credentials.apiKey : undefined;

  function configuredCredentials(): { clientId: string; apiKey: string } {
    if (!clientId || !apiKey) throw new Error("DB RIS credentials not configured");
    return { clientId, apiKey };
  }

  function headers(): Record<string, string> {
    const configured = configuredCredentials();
    return {
      "DB-Client-ID": configured.clientId,
      "DB-Api-Key": configured.apiKey,
      Accept: "application/vnd.de.db.ris+json",
    };
  }

  return {
    isConfigured: () => clientId !== undefined && apiKey !== undefined,

    async get<T>(api: RisApi, path: string, timeoutMs = 6_000): Promise<T> {
      return fetchJson<T>(`${RIS_BASE_URLS[api]}${path}`, {
        timeoutMs,
        userAgent: null,
        headers: headers(),
        errorMessage: ({ status, statusText }) =>
          `RIS ${api} GET ${path} failed: ${status} ${statusText}`,
      });
    },

    async post<T>(api: RisApi, path: string, body: unknown, timeoutMs = 8_000): Promise<T> {
      return fetchJson<T>(`${RIS_BASE_URLS[api]}${path}`, {
        timeoutMs,
        userAgent: null,
        headers: { ...headers(), "Content-Type": "application/json" },
        init: { method: "POST", body: JSON.stringify(body) },
        errorMessage: ({ status, statusText }) =>
          `RIS ${api} POST ${path} failed: ${status} ${statusText}`,
      });
    },
  };
}
