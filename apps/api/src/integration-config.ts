import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { integrationEnvVarName, type IntegrationManifest } from "@openmapx/integration-framework";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { integrationConfig } from "./db/schema";
import { resolveVaultSecrets } from "./services/secrets";

export type ConfigSource = "default" | "database" | "vault" | "config.json" | "env";

export interface ConfigValueWithSource {
  value: unknown;
  source: ConfigSource;
}

/**
 * Env vars are always strings, but `configSchema` keys can be typed (integer,
 * number, boolean, array). Coerce the raw string to the declared type so
 * numeric/boolean knobs set via `INTEGRATION_<ID>_<KEY>` reach integrations as
 * the right type — otherwise consumers that type-check (e.g. `typeof === "number"`)
 * silently drop the override and fall back to defaults. Unknown/`string` types
 * pass through unchanged; values that can't be coerced fall back to the raw string.
 */
export function coerceEnvValue(raw: string, type: string | undefined): unknown {
  switch (type) {
    case "integer":
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes") return true;
      if (v === "false" || v === "0" || v === "no") return false;
      return raw;
    }
    case "array": {
      const t = raw.trim();
      if (t.startsWith("[")) {
        try {
          return JSON.parse(t);
        } catch {
          // not JSON — fall back to comma-separated parsing
        }
      }
      return t
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    default:
      return raw;
  }
}

export async function resolveConfigWithSources(
  manifest: IntegrationManifest,
  directory: string,
): Promise<Record<string, ConfigValueWithSource>> {
  const result: Record<string, ConfigValueWithSource> = {};
  const schema = manifest.configSchema as Record<string, unknown> | undefined;
  const knownKeys = new Set<string>();
  // Canonical key → JSON-schema declared type. Used to coerce env-string values
  // to the type the integration expects (env vars are always strings).
  const keyTypes = new Map<string, string>();

  if (schema) {
    const props = (schema.properties ?? schema) as Record<
      string,
      { default?: unknown; type?: unknown }
    >;
    for (const [key, def] of Object.entries(props)) {
      if (key === "type" || key === "properties") continue;
      knownKeys.add(key);
      if (def && typeof def === "object" && typeof def.type === "string") {
        keyTypes.set(key, def.type);
      }
      if (def && typeof def === "object" && "default" in def && def.default !== undefined) {
        result[key] = { value: def.default, source: "default" };
      }
    }
  }

  if (knownKeys.size === 0) return result;

  try {
    const [row] = await db
      .select({ config: integrationConfig.config })
      .from(integrationConfig)
      .where(eq(integrationConfig.integrationId, manifest.id))
      .limit(1);
    if (row?.config && typeof row.config === "object") {
      for (const [key, value] of Object.entries(row.config as Record<string, unknown>)) {
        if (knownKeys.has(key)) result[key] = { value, source: "database" };
      }
    }
  } catch {
    // DB not available
  }

  // 3. Apply vault secrets
  try {
    const vaultSecrets = await resolveVaultSecrets(manifest.id);
    for (const [key, value] of Object.entries(vaultSecrets)) {
      if (knownKeys.has(key)) result[key] = { value, source: "vault" };
    }
  } catch {
    // vault unavailable
  }

  const configJsonPath = join(directory, "config.json");
  if (existsSync(configJsonPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configJsonPath, "utf-8"));
      if (typeof fileConfig === "object" && fileConfig !== null) {
        for (const [key, value] of Object.entries(fileConfig as Record<string, unknown>)) {
          if (knownKeys.has(key)) result[key] = { value, source: "config.json" };
        }
      }
    } catch {
      // ignore
    }
  }

  // Env layer — highest priority. Pattern: `INTEGRATION_<ID>_<KEY>` via the
  // shared `integrationEnvVarName` helper (hyphens in both id and key are
  // normalized to underscores and upper-cased, so bare camelCase keys still
  // match `INTEGRATION_X_APIKEY` and region-first hyphenated keys match too).
  for (const key of knownKeys) {
    const envVal = process.env[integrationEnvVarName(manifest.id, key)];
    if (envVal === undefined) continue;
    result[key] = { value: coerceEnvValue(envVal, keyTypes.get(key)), source: "env" };
  }

  return result;
}

export async function resolveConfig(
  manifest: {
    id: string;
    configSchema?: Record<string, unknown>;
  },
  directory: string,
): Promise<Record<string, unknown>> {
  const withSources = await resolveConfigWithSources(manifest as IntegrationManifest, directory);
  const config: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(withSources)) {
    config[key] = entry.value;
  }
  return config;
}

/**
 * Emits advisory warnings for required/enum config keys that violate the
 * manifest's `configSchema`. Never blocks load. Shared by cold start and reload.
 */
export function warnInvalidConfig(
  manifest: IntegrationManifest,
  config: Record<string, unknown>,
  id: string,
  warn: (msg: string) => void,
): void {
  const configSchema = manifest.configSchema as Record<string, unknown> | undefined;
  if (!configSchema?.properties) return;
  const props = configSchema.properties as Record<
    string,
    { type?: string; enum?: unknown[]; required?: boolean }
  >;
  for (const [key, def] of Object.entries(props)) {
    if (def.required && config[key] === undefined) {
      warn(`Integration ${id}: missing required config key "${key}"`);
    }
    if (def.enum && config[key] !== undefined && !def.enum.includes(config[key])) {
      warn(
        `Integration ${id}: config "${key}" value "${config[key]}" not in allowed values: ${def.enum.join(", ")}`,
      );
    }
  }
}
