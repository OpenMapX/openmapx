import type { LoadedIntegrationMeta } from "../integration/loader";

// Server-side fetches must prefer the internal Docker URL — going through
// `NEXT_PUBLIC_API_URL` hits Traefik on the public domain, which may be
// gated behind basic auth or other middleware that rejects unauthenticated
// SSR requests. INTERNAL_API_URL is set by the rendered compose to
// `http://app-api:3001`; the fallbacks cover dev (`pnpm dev`) where both
// client and server share the same host.
const API_URL = (
  process.env.INTERNAL_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001"
).replace(/\/+$/, "");

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
