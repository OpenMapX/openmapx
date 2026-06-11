import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationManifest } from "@openmapx/integration-framework";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { integrationConfig } from "./db/schema";
import { resolveVaultSecrets } from "./services/secrets";

export type ConfigSource = "default" | "database" | "vault" | "config.json" | "env";

export interface ConfigValueWithSource {
  value: unknown;
  source: ConfigSource;
}

export async function resolveConfigWithSources(
  manifest: IntegrationManifest,
  directory: string,
): Promise<Record<string, ConfigValueWithSource>> {
  const result: Record<string, ConfigValueWithSource> = {};
  const schema = manifest.configSchema as Record<string, unknown> | undefined;
  const knownKeys = new Set<string>();
  // Uppercased config key → canonical (original-case) key. Used to match env
  // vars like `INTEGRATION_PHOTOS_FLICKR_APIKEY` against configSchema key
  // `apiKey` without forcing operators to lowercase the suffix (or forcing
  // schema authors to pick all-lowercase keys).
  const upperToKey = new Map<string, string>();

  if (schema) {
    const props = (schema.properties ?? schema) as Record<string, { default?: unknown }>;
    for (const [key, def] of Object.entries(props)) {
      if (key === "type" || key === "properties") continue;
      knownKeys.add(key);
      upperToKey.set(key.toUpperCase(), key);
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

  // Env layer — highest priority. Pattern: `INTEGRATION_<ID>_<KEY>` (upper-cased
  // id with hyphens replaced by underscores, then the upper-cased config key).
  // Matching is case-insensitive on the configSchema key so both snake_case
  // and camelCase keys work (`apiKey` matches `INTEGRATION_X_APIKEY`).
  const prefix = `INTEGRATION_${manifest.id.replace(/-/g, "_").toUpperCase()}_`;
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envVal === undefined) continue;
    if (!envKey.startsWith(prefix)) continue;
    const rest = envKey.slice(prefix.length);
    const canonical = upperToKey.get(rest);
    if (canonical) result[canonical] = { value: envVal, source: "env" };
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
