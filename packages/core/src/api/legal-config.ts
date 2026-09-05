import type { PrivacySource } from "../privacy/contracts";
import { serverApiUrl } from "./server-url";

/** Operator legal facts published on /privacy, resolved server-side (env > DB > default). */
export interface PublicLegalConfig {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  email: string;
  phone: string;
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
  dataRequestEmail: string;
  dsarCaseRetentionDays: number;
  identityEvidenceRetentionDays: number;
  exportArtifactRetentionHours: number;
  deploymentJurisdiction: string;
  privacySources: Array<Omit<PrivacySource, "contactCode" | "instructionsCode">>;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const boundedNumber = (raw: unknown, fallback: number, min: number, max: number): number => {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
};

/**
 * Fetch the operator's published legal facts (hosting, supervisory authority,
 * log retention) from app-api, which resolves them env > admin-database >
 * default. Used by the public legal pages. Returns null when the API is
 * unreachable so callers can fall back to their web-process environment
 * without mistaking an intentionally empty API value for a fetch failure.
 */
export async function fetchLegalConfig(): Promise<PublicLegalConfig | null> {
  try {
    const res = await fetch(`${serverApiUrl()}/api/legal-config`, {
      next: { revalidate: 60 },
    } as RequestInit);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<PublicLegalConfig>;
    return {
      name: asString(data.name),
      street: asString(data.street),
      postalCode: asString(data.postalCode),
      city: asString(data.city),
      country: asString(data.country),
      email: asString(data.email),
      phone: asString(data.phone),
      hostingProvider: asString(data.hostingProvider),
      hostingLocations: asString(data.hostingLocations),
      supervisoryAuthority: asString(data.supervisoryAuthority),
      supervisoryAuthorityUrl: asString(data.supervisoryAuthorityUrl),
      serverLogRetentionDays: boundedNumber(data.serverLogRetentionDays, 30, 1, 3650),
      dataRequestEmail: asString(data.dataRequestEmail),
      dsarCaseRetentionDays: boundedNumber(data.dsarCaseRetentionDays, 1095, 30, 3650),
      identityEvidenceRetentionDays: boundedNumber(data.identityEvidenceRetentionDays, 30, 1, 365),
      exportArtifactRetentionHours: boundedNumber(data.exportArtifactRetentionHours, 168, 24, 720),
      deploymentJurisdiction: asString(data.deploymentJurisdiction),
      privacySources: Array.isArray(data.privacySources) ? data.privacySources : [],
    };
  } catch {
    return null;
  }
}
