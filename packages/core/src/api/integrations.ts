import type { LoadedIntegrationMeta } from "../types/integrationMeta";
import { serverApiUrl } from "./server-url";

export async function fetchIntegrations(): Promise<LoadedIntegrationMeta[]> {
  try {
    const res = await fetch(`${serverApiUrl()}/api/integrations`, {
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) return [];
    return (await res.json()) as LoadedIntegrationMeta[];
  } catch {
    return [];
  }
}
