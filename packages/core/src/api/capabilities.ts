// Server-side fetches must prefer the internal Docker URL — see the
// matching comment in `./integrations.ts` for the rationale.
const API_URL = (
  process.env.INTERNAL_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001"
).replace(/\/+$/, "");

export async function fetchCapabilities(): Promise<Record<string, boolean>> {
  try {
    const res = await fetch(`${API_URL}/api/capabilities`, {
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) return {};
    const data = await res.json();
    return (data as { services: Record<string, boolean> }).services ?? {};
  } catch {
    return {};
  }
}

export function isServiceAvailable(
  capabilities: Record<string, boolean>,
  serviceId: string | string[] | undefined,
): boolean {
  if (!serviceId) return true;
  if (Array.isArray(serviceId)) {
    return serviceId.some((id) => capabilities[id] ?? true);
  }
  return capabilities[serviceId] ?? true;
}
