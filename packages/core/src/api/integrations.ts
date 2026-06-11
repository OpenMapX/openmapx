import type { LoadedIntegrationMeta } from "../types/integrationMeta";
import { serverApiUrl } from "./server-url";

/**
 * Wire shape of `/api/integrations`. Mirrors `IntegrationsResponse` from
 * `@openmapx/integration-framework` — duplicated locally so `@openmapx/core`
 * doesn't depend on integration-framework (which itself depends on core).
 */

export type CloudAiVendor = "anthropic" | "openai";
export interface AiSearchDisclosure {
  type: "ai-search";
  integrationId: string;
  aiActive: boolean;
  localActive: boolean;
  cloudActive: boolean;
  cloudVendors: CloudAiVendor[];
}
export type Disclosure = AiSearchDisclosure;

interface IntegrationsApiResponse {
  integrations: LoadedIntegrationMeta[];
  frameworkStrings: Record<string, Record<string, unknown>>;
  disclosures?: Disclosure[];
}

export async function fetchIntegrations(): Promise<LoadedIntegrationMeta[]> {
  try {
    const res = await fetch(`${serverApiUrl()}/api/integrations`, {
      next: { revalidate: 3600 },
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
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) return [];
    const body = (await res.json()) as IntegrationsApiResponse;
    return body.disclosures ?? [];
  } catch {
    return [];
  }
}
