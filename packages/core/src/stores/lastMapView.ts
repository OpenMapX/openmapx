import { getStorage } from "../platform/storage";
import type { LngLat } from "../types/geometry";

export const REMEMBER_MAP_VIEW_STORAGE_KEY = "openmapx:rememberMapView";
export const LAST_MAP_VIEW_STORAGE_KEY = "openmapx:lastMapView";

/** Where the map was last left: enough to reopen on the same place. */
export interface LastMapView {
  center: LngLat;
  zoom: number;
}

// On by default; stored only when toggled, so an absent value means enabled.
// Read from storage rather than the settings store: the map starts before the
// settings store is hydrated, and a disabled preference must already hold then.
export function readRememberMapView(): boolean {
  return getStorage().getString(REMEMBER_MAP_VIEW_STORAGE_KEY) !== "false";
}

function isLastMapView(value: unknown): value is LastMapView {
  if (typeof value !== "object" || value === null) return false;
  const { center, zoom } = value as { center?: unknown; zoom?: unknown };
  if (!Array.isArray(center) || center.length !== 2) return false;
  const [lng, lat] = center;
  return (
    typeof lng === "number" &&
    typeof lat === "number" &&
    typeof zoom === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Number.isFinite(zoom) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90 &&
    zoom >= 0 &&
    zoom <= 24
  );
}

/** The saved view, or null when none is saved or remembering is switched off. */
export function readLastMapView(): LastMapView | null {
  if (!readRememberMapView()) return null;
  const raw = getStorage().getString(LAST_MAP_VIEW_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isLastMapView(parsed)) return null;
    return { center: [parsed.center[0], parsed.center[1]], zoom: parsed.zoom };
  } catch {
    return null;
  }
}

/** Save the view for the next launch; a no-op while remembering is switched off. */
export function writeLastMapView(view: LastMapView): void {
  if (!readRememberMapView() || !isLastMapView(view)) return;
  getStorage().setString(
    LAST_MAP_VIEW_STORAGE_KEY,
    JSON.stringify({ center: view.center, zoom: view.zoom }),
  );
}
