import type { OfflineArea } from "./types";

const STORAGE_KEY = "openmapx-offline-areas-v1";

export function listAreas(): OfflineArea[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as OfflineArea[];
  } catch {
    return [];
  }
}

export function saveArea(area: OfflineArea): void {
  if (typeof window === "undefined") return;
  const all = listAreas();
  const idx = all.findIndex((a) => a.id === area.id);
  const next = idx === -1 ? [...all, area] : all.map((a) => (a.id === area.id ? area : a));
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function removeArea(id: string): void {
  if (typeof window === "undefined") return;
  const filtered = listAreas().filter((a) => a.id !== id);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export function cacheNameFor(area: OfflineArea): string {
  return `offline-area-${area.id}`;
}

export async function deleteAreaCache(area: OfflineArea): Promise<void> {
  if (typeof caches === "undefined") return;
  await caches.delete(cacheNameFor(area));
}
