// Full-cascade resolver for per-service operator configuration. Layers DB
// values on top of the core env/defaults resolver so the admin panel can
// surface exactly where each configured value is coming from — and so the
// compose renderer gets the effective values for every knob the operator can
// tweak.
//
// Precedence (highest wins):
//
//     default  <  database  <  env
//
// There is no `config.json` or vault layer for services today. The integration
// system has both; services will grow a vault layer the moment a service
// manifest declares an `x-openmapx-secret` field (none do yet). The layering
// is parallel to `resolveConfigWithSources` in `integration-host.ts` — the two
// functions share the core helpers in `@openmapx/core` (`configSchemaKeys`,
// `serviceConfigEnvPrefix`) so the env-var pattern and default extraction stay
// in lockstep.
//
// The env prefix is `SERVICE_{ID}_{KEY}` (dashes → underscores, uppercase).
// Example: `SERVICE_VALHALLA_MEMORY_LIMIT=4g` overrides whatever is saved in
// `service_config.config.memory_limit` for the `valhalla` service.

import { services as coreServices } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { serviceConfig } from "../db/schema";

const { configSchemaKeys, resolveServiceConfigFromEnv, serviceConfigEnvPrefix } = coreServices;

// Re-export the core types so callers (route handlers, tests) don't need to
// reach into `@openmapx/core` directly. Services can in principle land on any
// of the sources the core helper tracks; today only `default`, `database`,
// and `env` actually occur — there's no `vault` or `config.json` layer for
// services yet.
export type ConfigSource = coreServices.ConfigSource;
export type ConfigValueWithSource = coreServices.ConfigValueWithSource;

export interface ResolveServiceConfigInput {
  id: string;
  configSchema?: Record<string, unknown>;
  /**
   * Manifest's `container.environment` baseline. Threading this through to
   * `resolveServiceConfigFromEnv` keeps schema defaults from overlaying keys
   * the manifest already provides a value for — otherwise a boolean default of
   * `true` would stringify to "true" and silently replace a carefully chosen
   * "True" in the manifest. Optional because tests can still exercise the
   * env/default cascade without constructing a full manifest.
   */
  containerEnv?: Record<string, string>;
}

/**
 * Resolve the full config cascade for a single service. Returns a
 * `{ key: { value, source } }` map; keys with neither a default, DB value, nor
 * env override are omitted.
 *
 * DB errors (e.g. the pg server is unreachable) are swallowed — the resolver
 * falls back to env+defaults so a broken DB never blocks `compose render`.
 * The `source` field lets callers (admin UI) tell "from DB" from "default"
 * explicitly instead of guessing.
 */
export async function resolveServiceConfigWithSources(
  manifest: ResolveServiceConfigInput,
): Promise<Record<string, ConfigValueWithSource>> {
  const keys = configSchemaKeys(manifest.configSchema);
  if (keys.length === 0) return {};

  const known = new Set(keys.map((k) => k.key));

  // Start from defaults + env via the core helper. Env is highest priority, so
  // we'll re-apply it after the DB layer below to preserve that precedence.
  // `containerEnv` suppresses schema defaults for keys the manifest already
  // fills — see the doc comment on `ResolveServiceConfigInput.containerEnv`.
  const envLayer = resolveServiceConfigFromEnv(
    {
      id: manifest.id,
      configSchema: manifest.configSchema,
      container: manifest.containerEnv ? { environment: manifest.containerEnv } : undefined,
    },
    process.env,
  );

  const result: Record<string, ConfigValueWithSource> = {};

  // 1. Defaults (from envLayer; env entries are overlaid at step 3).
  for (const [key, entry] of Object.entries(envLayer)) {
    if (entry.source === "default") result[key] = entry;
  }

  // 2. Database.
  try {
    const [row] = await db
      .select({ config: serviceConfig.config })
      .from(serviceConfig)
      .where(eq(serviceConfig.serviceId, manifest.id))
      .limit(1);
    if (row?.config && typeof row.config === "object") {
      for (const [key, value] of Object.entries(row.config as Record<string, unknown>)) {
        if (known.has(key)) result[key] = { value, source: "database" };
      }
    }
  } catch {
    // DB unavailable — env + defaults only.
  }

  // 3. Env vars (highest priority — overwrites anything from steps 1-2).
  for (const [key, entry] of Object.entries(envLayer)) {
    if (entry.source === "env") result[key] = entry;
  }

  return result;
}

/**
 * Batch version: resolve configs for many services in parallel. Used by the
 * compose-render path where we need the full map before handing control to
 * the renderer.
 *
 * For values whose source is `env`, emit a Docker Compose substitution
 * placeholder (`${SERVICE_<ID>_<KEY>:-}`) instead of the literal value, so
 * operator-set env values (which can include secrets) stay in
 * `infra/docker/.env` and never get baked into the rendered YAML. Values
 * sourced from defaults or the database are written verbatim — the database
 * isn't expected to hold secrets today (no `x-openmapx-secret` field on any
 * service configSchema), and defaults are public manifest values.
 */
export async function resolveAllServiceConfigs(
  manifests: ResolveServiceConfigInput[],
): Promise<Map<string, Record<string, unknown>>> {
  const entries = await Promise.all(
    manifests.map(async (m) => {
      const resolved = await resolveServiceConfigWithSources(m);
      const prefix = serviceConfigEnvPrefix(m.id);
      const flat: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(resolved)) {
        if (entry.source === "env") {
          flat[key] = `\${${prefix}${key.toUpperCase()}:-}`;
        } else {
          flat[key] = entry.value;
        }
      }
      return [m.id, flat] as const;
    }),
  );
  return new Map(entries);
}
