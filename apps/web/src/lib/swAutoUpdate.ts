import type { NavStatus } from "@openmapx/core";
import { listAreas } from "@/lib/offlineAreas/storage";

export const AUTO_RELOAD_COOLDOWN_MS = 2 * 60 * 1000;
const LAST_AUTO_RELOAD_KEY = "omx:sw-last-auto-reload";

export interface AutoUpdateSafetyInputs {
  online: boolean;
  navStatus: NavStatus;
  mutationCount: number;
  hasActiveDownload: boolean;
  hasUnsavedText: boolean;
  msSinceLastAutoReload: number; // Number.POSITIVE_INFINITY if never
}

export function isSafeToAutoReload(i: AutoUpdateSafetyInputs): boolean {
  if (!i.online) return false;
  if (i.navStatus === "navigating" || i.navStatus === "rerouting") return false;
  if (i.mutationCount > 0) return false;
  if (i.hasActiveDownload) return false;
  if (i.hasUnsavedText) return false;
  if (i.msSinceLastAutoReload < AUTO_RELOAD_COOLDOWN_MS) return false;
  return true;
}

export function hasUnsavedTextEntry(): boolean {
  const el = typeof document === "undefined" ? null : document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    return ((el as HTMLInputElement | HTMLTextAreaElement).value ?? "").length > 0;
  }
  if ((el as HTMLElement).isContentEditable) {
    return ((el as HTMLElement).textContent ?? "").length > 0;
  }
  return false;
}

export function hasActiveAreaDownload(): boolean {
  try {
    return listAreas().some((a) => a.status === "downloading");
  } catch {
    return false;
  }
}

export function msSinceLastAutoReload(): number {
  if (typeof sessionStorage === "undefined") return Number.POSITIVE_INFINITY;
  const raw = sessionStorage.getItem(LAST_AUTO_RELOAD_KEY);
  if (!raw) return Number.POSITIVE_INFINITY;
  const then = Number.parseInt(raw, 10);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Date.now() - then;
}

export function markAutoReloaded(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(LAST_AUTO_RELOAD_KEY, String(Date.now()));
}
