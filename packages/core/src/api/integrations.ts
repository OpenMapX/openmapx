import type { LoadedIntegrationMeta } from "../types/integrationMeta";
import { serverApiUrl } from "./server-url";

/**
 * Wire shape of `/api/integrations`. Mirrors `IntegrationsResponse` from
 * `@openmapx/integration-framework` — duplicated locally so `@openmapx/core`
 * doesn't depend on integration-framework (which itself depends on core).
 */

export interface AiCloudProcessor {
  id: string;
  name: string;
  countryCode: string;
  privacyUrl: string;
}
export interface AiSearchDisclosure {
  type: "ai-search";
  integrationId: string;
  aiActive: boolean;
  localActive: boolean;
  cloudActive: boolean;
  cloudProcessors: AiCloudProcessor[];
  cloudAvailable: boolean;
  cloudConsentRequired: boolean;
  cloudProviderLabels: string[];
}

export type EmailProvider = "emaillabs" | "lettermint" | "smtp";
export type TransferSafeguard = "eea" | "adequacy" | "dpf" | "scc" | "none";

export interface EmailDisclosure {
  type: "email";
  provider: EmailProvider;
  vendorName: string;
  countryCode: string;
  privacyUrl?: string;
  transfer: TransferSafeguard;
}

export type Disclosure = AiSearchDisclosure | EmailDisclosure;

interface IntegrationsApiResponse {
  integrations: LoadedIntegrationMeta[];
  frameworkStrings: Record<string, Record<string, unknown>>;
  disclosures?: Disclosure[];
}

// Not cached: the only callers are the force-dynamic /privacy and /terms
// pages, whose attribution/disclosure tables must reflect the integrations
// enabled at runtime. A cached fetch here is seeded empty during `next build`
// (no API runs then) and baked into the image, rendering those tables stale.
export async function fetchIntegrations(): Promise<LoadedIntegrationMeta[]> {
  try {
    const res = await fetch(`${serverApiUrl()}/api/integrations`, {
      cache: "no-store",
    } as RequestInit);
    if (!res.ok) return [];
    const body = (await res.json()) as IntegrationsApiResponse;
    return body.integrations ?? [];
  } catch {
    return [];
  }
}

export async function fetchDisclosures(): Promise<Disclosure[]> {
  try {
    const res = await fetch(`${serverApiUrl()}/api/integrations`, {
      cache: "no-store",
    } as RequestInit);
    if (!res.ok) return [];
    const body = (await res.json()) as IntegrationsApiResponse;
    return body.disclosures ?? [];
  } catch {
    return [];
  }
}
