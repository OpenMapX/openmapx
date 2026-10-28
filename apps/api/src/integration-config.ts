import { constants, existsSync, readFileSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { type IntegrationManifest, integrationEnvVarName } from "@openmapx/integration-framework";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { integrationConfig } from "./db/schema";
import {
  type AdministrativeConfigurationReadContext,
  assertAdministrativeConfigurationRead,
  recordAdministrativeConfigurationFile,
} from "./services/administrative-configuration-context";
import { resolveIntegrationVaultSecretsStrict, resolveVaultSecrets } from "./services/secrets";

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

/**
 * Whether a raw `process.env[...]` read should be treated as an override.
 * Compose's `${VAR:-}` convention (used throughout this repo's generated
 * compose file) injects an empty string when a var is unset, rather than
 * leaving it undefined. Without this check, that empty string would win the
 * env layer's "highest priority" and blank out a lower-priority vault or
 * database value instead of leaving it alone — matching how
 * `apps/api/src/routes/admin.ts` already treats an empty env var as absent
 * when computing credential-source status.
 */
export function isEnvValuePresent(raw: string | undefined): raw is string {
  return raw !== undefined && raw !== "";
}

export async function resolveConfigWithSources(
  manifest: IntegrationManifest,
  directory: string,
): Promise<Record<string, ConfigValueWithSource>> {
  const result: Record<string, ConfigValueWithSource> = {};
  const schema = manifest.configSchema as Record<string, unknown> | undefined;
  const knownKeys = new Set<string>(["enabled"]);
  // Canonical key → JSON-schema declared type. Used to coerce env-string values
  // to the type the integration expects (env vars are always strings).
  const keyTypes = new Map<string, string>([["enabled", "boolean"]]);

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
    if (!isEnvValuePresent(envVal)) continue;
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

/** Strict administrative cascade. ENOENT alone means an absent config file. */
export async function resolveIntegrationConfigWithSourcesStrict(
  manifest: IntegrationManifest,
  directory: string,
  context: AdministrativeConfigurationReadContext,
): Promise<Record<string, ConfigValueWithSource>> {
  try {
    assertAdministrativeConfigurationRead(context);
    if (context.integrationReloadSnapshot) {
      const retained = context.integrationReloadSnapshot[manifest.id];
      if (!retained) throw Error("Captured integration configuration unavailable");
      return structuredClone(retained);
    }
    const properties: Record<string, { default?: unknown; type?: string }> = {
      ...((manifest.configSchema?.properties ?? manifest.configSchema ?? {}) as Record<
        string,
        { default?: unknown; type?: string }
      >),
      enabled: { type: "boolean" },
    };
    const result: Record<string, ConfigValueWithSource> = {};
    for (const [key, definition] of Object.entries(properties)) {
      if (definition && typeof definition === "object" && definition.default !== undefined)
        result[key] = { value: definition.default, source: "default" };
    }
    const rows = context.integrationRows.filter((row) => row.integrationId === manifest.id);
    if (rows.length > 1) throw new Error("duplicate config");
    const overlay = (values: unknown, source: ConfigSource) => {
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw new Error("malformed config");
      for (const [key, value] of Object.entries(values)) {
        if (!Object.hasOwn(properties, key)) throw new Error("undeclared config");
        if (key === "enabled" && typeof value !== "boolean") throw new Error("malformed enabled");
        result[key] = { value, source };
      }
    };
    overlay(rows[0]?.config ?? {}, "database");
    overlay(await resolveIntegrationVaultSecretsStrict(manifest.id, context), "vault");
    const path = join(directory, "config.json");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 524288)
        throw new Error("unsafe config");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const current = await lstat(path);
      if (
        stat.dev !== current.dev ||
        stat.ino !== current.ino ||
        stat.size !== after.size ||
        stat.mtimeMs !== after.mtimeMs ||
        stat.ctimeMs !== after.ctimeMs
      )
        throw new Error("changed config");
      recordAdministrativeConfigurationFile(context, path, {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
      });
      overlay(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "config.json");
    } catch (error) {
      if (handle !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      recordAdministrativeConfigurationFile(context, path, null);
    } finally {
      await handle?.close();
    }
    for (const [key, definition] of Object.entries(properties)) {
      const value = context.env[integrationEnvVarName(manifest.id, key)];
      if (isEnvValuePresent(value))
        result[key] = { value: coerceEnvValue(value, definition?.type), source: "env" };
    }
    for (const [key, entry] of Object.entries(result)) {
      // This is acquisition/type validation. Writability/secret ownership is
      // checked separately against the original definition by the overlay.
      const valueSchema = Object.fromEntries(
        Object.entries(properties[key] ?? {}).filter(
          ([annotation]) => annotation !== "readOnly" && annotation !== "x-openmapx-secret",
        ),
      );
      if (
        !coreServices.validateTrustedConfigurationValues(
          { [key]: entry.value },
          { type: "object", properties: { [key]: valueSchema } },
        )
      )
        throw Error("Malformed integration configuration value");
    }
    return result;
  } catch {
    throw new Error("Configuration acquisition unavailable");
  }
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
      // Values and enum members can both contain credentials. Diagnostics
      // identify only the field, including for ordinary provider settings.
      warn(`Integration ${id}: config "${key}" is not an allowed value`);
    }
  }
}
