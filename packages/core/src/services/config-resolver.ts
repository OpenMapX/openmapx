// Pure helpers for resolving per-service operator configuration. The renderer
// (core) stays free of DB/process-env knowledge by accepting a pre-resolved
// `Map<serviceId, Record<string, unknown>>` in `RenderContext`. This module
// provides the env-var + defaults side of that map — callers that don't
// talk to a database (the CLI `compose render` command, tests) can use it
// directly; callers that do (apps/api) layer DB + vault on top.
//
// Precedence shape that the final merger must implement (highest last):
//   default  →  database  →  vault  →  env
//
// Env pattern is `SERVICE_{ID}_{KEY}` with dashes → underscores, uppercased.
// e.g. for service `valhalla` with config key `memoryLimit`, the operator sets
// `SERVICE_VALHALLA_MEMORYLIMIT=2g` — or, for more readable env var names,
// the config key should already be upper_snake.

import type { ServiceManifest } from "./types";

export type ConfigSource = "default" | "database" | "vault" | "env";

export interface ConfigValueWithSource {
  value: unknown;
  source: ConfigSource;
}

/**
 * Build the env-var prefix for a given service id. Exported so callers (admin
 * UI, docs) can surface the exact pattern operators need to set on the host.
 */
export function serviceConfigEnvPrefix(serviceId: string): string {
  return `SERVICE_${serviceId.replace(/-/g, "_").toUpperCase()}_`;
}

/**
 * Extract the set of known config keys from a manifest's JSON `configSchema`.
 */
export function configSchemaKeys(
  configSchema: Record<string, unknown> | undefined,
): Array<{ key: string; default?: unknown }> {
  if (!configSchema) return [];
  const props = configSchema.properties as
    | Record<string, { default?: unknown; "x-openmapx-secret"?: unknown }>
    | undefined;
  if (!props || typeof props !== "object") return [];
  const out: Array<{ key: string; default?: unknown }> = [];
  for (const [key, def] of Object.entries(props)) {
    // Secret fields are delivered to the container as mounted files (Docker
    // `secrets:`), never through the env map this function feeds — so skip them
    // here to guarantee a secret value can't be baked into the rendered YAML.
    if (def && typeof def === "object" && def["x-openmapx-secret"] === true) continue;
    out.push({ key, default: def && typeof def === "object" ? def.default : undefined });
  }
  return out;
}

/**
 * Resolve service config from defaults and env vars only — no DB access. Used
 * by the CLI `compose render` command where no database is available, and by
 * the API to build the env-only fallback when the DB is unreachable.
 *
 * Returns a `{ key: { value, source } }` map. Keys without a default and
 * without an env override are omitted from the result (so the caller can tell
 * "nothing configured" from "configured to an empty string").
 *
 * When the caller passes `manifest.container.environment`, schema-default
 * entries whose key already exists there are suppressed. The manifest env
 * is itself a default (it's what the image runs with out of the box), so
 * overlaying a schema default on top would only cause drift — e.g., the
 * valhalla-scripted image expects capitalized "True"/"False", but a JSON
 * schema default of `true` would stringify to lowercase "true" and silently
 * replace the manifest value. Env and database overrides are still returned
 * unconditionally — those are operator intent.
 */
export function resolveServiceConfigFromEnv(
  manifest: Pick<ServiceManifest, "id" | "configSchema"> & {
    container?: Pick<ServiceManifest["container"], "environment">;
  },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ConfigValueWithSource> {
  const keys = configSchemaKeys(manifest.configSchema);
  if (keys.length === 0) return {};

  const manifestEnvKeys = new Set(Object.keys(manifest.container?.environment ?? {}));
  const result: Record<string, ConfigValueWithSource> = {};

  for (const { key, default: defVal } of keys) {
    if (defVal === undefined) continue;
    if (manifestEnvKeys.has(key)) continue;
    result[key] = { value: defVal, source: "default" };
  }

  const prefix = serviceConfigEnvPrefix(manifest.id);
  const known = new Set(keys.map((k) => k.key));
  const upperToKey = new Map<string, string>();
  for (const k of known) upperToKey.set(k.toUpperCase(), k);

  for (const [envKey, envVal] of Object.entries(env)) {
    if (envVal === undefined) continue;
    if (!envKey.startsWith(prefix)) continue;
    const rest = envKey.slice(prefix.length);
    const canonical = upperToKey.get(rest);
    if (!canonical) continue;
    result[canonical] = { value: envVal, source: "env" };
  }

  return result;
}

/**
 * Convenience: flatten a `{ key: { value, source } }` map to `{ key: value }`.
 * Callers that just need to hand values into `RenderContext.resolvedServiceConfigs`
 * use this to drop the source metadata.
 */
export function flattenResolvedConfig(
  resolved: Record<string, ConfigValueWithSource>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(resolved)) {
    out[key] = entry.value;
  }
  return out;
}
