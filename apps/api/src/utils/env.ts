/**
 * Read environment configuration, treating a blank value as unset.
 *
 * Compose injects optional service vars as empty strings via the `${VAR:-}`
 * default (see `services/app-api/service.json`), so inside a container an
 * "unset" var arrives as `""` rather than `undefined`. Plain `??` only guards
 * `null`/`undefined`, so it keeps that empty string and silently breaks
 * downstream URL building and number parsing — an empty tile URL becomes
 * `fetch("")` → `ERR_INVALID_URL`, which is exactly how a missing
 * `OPENTOPOMAP_TILE_URL` knocked out the terrain layer in production.
 *
 * These helpers collapse blank (and whitespace-only) values to the fallback,
 * matching the `||` convention already used in `apps/web/src/lib/env.ts`.
 */

/** Return the env var when it holds a non-blank value, otherwise the fallback. */
export function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value != null && value.trim() !== "" ? value : fallback;
}

/** Return the env var parsed as a finite number, otherwise the fallback. */
export function envInt(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
