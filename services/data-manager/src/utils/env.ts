/**
 * Read environment configuration, treating a blank value as unset.
 *
 * Mirrors `apps/api/src/utils/env.ts`: compose injects optional service vars
 * as empty strings via the `${VAR:-}` default, so inside a container an
 * "unset" var arrives as `""` rather than `undefined`. Plain `??` only guards
 * `null`/`undefined` and would keep that empty string, silently breaking
 * downstream URL building and number parsing.
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
