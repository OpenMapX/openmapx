/**
 * Shared HTTP client for all Deutsche Bahn RIS APIs.
 * Adds DB-Client-ID / DB-Api-Key auth headers to every request.
 *
 * Auth docs: https://developers.deutschebahn.com
 */

const BASE_URLS = {
  stations: "https://apis.deutschebahn.com/db/apis/ris-stations/v1",
  routing: "https://apis.deutschebahn.com/db/apis/ris-routing/v2",
  maps: "https://apis.deutschebahn.com/db/apis/ris-maps/v2",
  transports: "https://apis.deutschebahn.com/db/apis/ris-transports/v3",
} as const;

export type RisApi = keyof typeof BASE_URLS;

// Populated by setup(ctx) from the resolved integration config cascade.
let cachedClientId: string | undefined;
let cachedApiKey: string | undefined;

export function setRisCredentials(creds: { clientId?: string; apiKey?: string }): void {
  cachedClientId = creds.clientId && creds.clientId.length > 0 ? creds.clientId : undefined;
  cachedApiKey = creds.apiKey && creds.apiKey.length > 0 ? creds.apiKey : undefined;
}

function getCredentials(): { clientId: string; apiKey: string } | null {
  if (!cachedClientId || !cachedApiKey) return null;
  return { clientId: cachedClientId, apiKey: cachedApiKey };
}

export function isRisConfigured(): boolean {
  return getCredentials() !== null;
}

function buildHeaders(creds: { clientId: string; apiKey: string }): Record<string, string> {
  return {
    "DB-Client-ID": creds.clientId,
    "DB-Api-Key": creds.apiKey,
    Accept: "application/vnd.de.db.ris+json",
  };
}

export async function risGet<T>(api: RisApi, path: string, timeoutMs = 6_000): Promise<T> {
  const creds = getCredentials();
  if (!creds) throw new Error("DB RIS credentials not configured");

  const url = `${BASE_URLS[api]}${path}`;
  const res = await fetch(url, {
    headers: buildHeaders(creds),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`RIS ${api} GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function risPost<T>(
  api: RisApi,
  path: string,
  body: unknown,
  timeoutMs = 8_000,
): Promise<T> {
  const creds = getCredentials();
  if (!creds) throw new Error("DB RIS credentials not configured");

  const url = `${BASE_URLS[api]}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...buildHeaders(creds), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`RIS ${api} POST ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
