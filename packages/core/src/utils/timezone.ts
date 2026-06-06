import tzLookup from "tz-lookup";

/**
 * IANA timezone name for a coordinate (e.g. `"Europe/Berlin"`), or `null` when
 * lookup fails. Thin wrapper over `tz-lookup` so consumers (including the web
 * app, which doesn't depend on `tz-lookup` directly) get timezone resolution
 * through `@openmapx/core`.
 */
export function timeZoneAt(lat: number, lng: number): string | null {
  try {
    return tzLookup(lat, lng);
  } catch {
    return null;
  }
}
