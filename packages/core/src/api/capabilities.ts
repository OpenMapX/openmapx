import { serverApiUrl } from "./server-url";

export async function fetchCapabilities(): Promise<Record<string, boolean>> {
  try {
    const res = await fetch(`${serverApiUrl()}/api/capabilities`, {
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
