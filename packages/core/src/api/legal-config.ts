import { serverApiUrl } from "./server-url";

/** Operator legal facts published on /privacy, resolved server-side (env > DB > default). */
export interface PublicLegalConfig {
  /** Company that hosts this instance. Empty string → omit the hosting sentence. */
  hostingProvider: string;
  /** Data-center locations appended to the hosting sentence. Empty string → omit. */
  hostingLocations: string;
  /** Competent data-protection supervisory authority. Empty string → omit. */
  supervisoryAuthority: string;
  /** Link to the supervisory authority. Empty string → show just the name. */
  supervisoryAuthorityUrl: string;
  /** Days server access logs are retained. Always a positive integer (defaults to 30). */
  serverLogRetentionDays: number;
}

const EMPTY_LEGAL_CONFIG: PublicLegalConfig = {
  hostingProvider: "",
  hostingLocations: "",
  supervisoryAuthority: "",
  supervisoryAuthorityUrl: "",
  serverLogRetentionDays: 30,
};

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Fetch the operator's published legal facts (hosting, supervisory authority,
 * log retention) from app-api, which resolves them env > admin-database >
 * default. Used by the public /privacy page. Falls back to safe defaults when
 * the API is unreachable during SSR, so the page never renders a dangling
 * fragment.
 */
export async function fetchLegalConfig(): Promise<PublicLegalConfig> {
  try {
    const res = await fetch(`${serverApiUrl()}/api/legal-config`, {
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) return EMPTY_LEGAL_CONFIG;
    const data = (await res.json()) as Partial<PublicLegalConfig>;
    const retention = Number(data.serverLogRetentionDays);
    return {
      hostingProvider: asString(data.hostingProvider),
      hostingLocations: asString(data.hostingLocations),
      supervisoryAuthority: asString(data.supervisoryAuthority),
      supervisoryAuthorityUrl: asString(data.supervisoryAuthorityUrl),
      serverLogRetentionDays: Number.isInteger(retention) && retention > 0 ? retention : 30,
    };
  } catch {
    return EMPTY_LEGAL_CONFIG;
  }
}
