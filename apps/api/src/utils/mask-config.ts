/**
 * Manifest `x-openmapx-secret` is the authoritative credential signal,
 * matching the decision in commit `ca662908`. The key-name regex is only a
 * fallback for keys a manifest failed to declare. `"***"` is the same
 * "configured" sentinel used by `apps/api/src/routes/admin-settings.ts`.
 */

import { getSecretFields } from "./validate-config-body.js";

export const SENSITIVE_KEY_NAME_RE = /key|secret|token|password|credential|api_?key/i;

export function secretConfigKeys(configSchema: Record<string, unknown> | undefined): Set<string> {
  return new Set(getSecretFields(configSchema).map((field) => field.key));
}

export function maskSecretConfigValues<T extends { value: unknown; source: string }>(
  resolvedConfig: Record<string, T>,
  configSchema: Record<string, unknown> | undefined,
): Record<string, T | { value: string; source: string }> {
  const secretKeys = secretConfigKeys(configSchema);
  const masked: Record<string, T | { value: string; source: string }> = {};

  for (const [key, entry] of Object.entries(resolvedConfig)) {
    if (secretKeys.has(key) || (SENSITIVE_KEY_NAME_RE.test(key) && entry.source !== "default")) {
      masked[key] = { value: "***", source: entry.source };
    } else {
      masked[key] = entry;
    }
  }

  return masked;
}

export function maskSecretConfigRecord(
  config: Record<string, unknown>,
  configSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const secretKeys = secretConfigKeys(configSchema);
  const masked: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    masked[key] = secretKeys.has(key) || SENSITIVE_KEY_NAME_RE.test(key) ? "***" : value;
  }

  return masked;
}
