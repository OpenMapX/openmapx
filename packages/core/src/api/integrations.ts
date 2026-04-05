import type { LoadedIntegrationMeta } from "../integration/loader";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export async function fetchIntegrations(): Promise<LoadedIntegrationMeta[]> {
  try {
    const res = await fetch(`${API_URL}/api/integrations`, {
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) return [];
    return (await res.json()) as LoadedIntegrationMeta[];
  } catch {
    return [];
  }
}
