import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderCompose } from "../compose-renderer";
import {
  flattenResolvedConfig,
  resolveServiceConfigFromEnv,
  serviceConfigEnvPrefix,
} from "../config-resolver";
import { validateServiceManifest } from "../manifest-schema";
import type { LoadedService, ServiceManifest } from "../types";

// The fixture is a verbatim copy of services/ingest/service.json in the
// OpenConditions repository (github.com/OpenConditions/openconditions): the
// extension service whose whole configuration must reach its container through
// OpenMapX's config model, since a community service's own `${…}` entries are
// escaped. To refresh it, run `pnpm gen:credentials` in OpenConditions and copy
// that file over __fixtures__/openconditions-ingest.service.json unchanged.
const manifest = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/openconditions-ingest.service.json", import.meta.url),
    "utf8",
  ),
) as ServiceManifest;

const service: LoadedService = {
  manifest,
  directory: "/fake/services/openconditions-ingest",
  isBuiltIn: false,
  enabled: true,
};

type Property = { default?: unknown; "x-openmapx-secret"?: boolean };
const properties = (manifest.configSchema?.properties ?? {}) as Record<string, Property>;
const configKeys = Object.keys(properties).filter(
  (key) => properties[key]?.["x-openmapx-secret"] !== true,
);
const secretKeys = ["DATABASE_URL", "OPENCONDITIONS_OPERATOR_TOKEN"];

function renderedEnvironment(env: NodeJS.ProcessEnv): {
  environment: Record<string, string>;
  secrets: Array<{ source: string; target: string }>;
} {
  const resolved = flattenResolvedConfig(resolveServiceConfigFromEnv(manifest, env));
  return rendered(service, resolved);
}

/** The rendered compose entry, as written: compose interpolation is not applied. */
function rendered(
  loaded: LoadedService,
  resolved: Record<string, unknown>,
  envKeys: string[] = [],
): {
  environment: Record<string, string>;
  secrets: Array<{ source: string; target: string }>;
} {
  const result = renderCompose([loaded], {
    resolvedServiceConfigs: new Map([[manifest.id, resolved]]),
    serviceConfigEnvKeys: new Map([[manifest.id, envKeys]]),
    serviceSecretKeys: new Map([[manifest.id, secretKeys]]),
    existsSync: () => true,
  });
  const doc = yamlLoad(result.composeYaml) as {
    services: Record<
      string,
      { environment: Record<string, string>; secrets: Array<{ source: string; target: string }> }
    >;
  };
  const snippet = doc.services[manifest.id];
  if (!snippet) throw new Error("the service was not rendered");
  return snippet;
}

describe("OpenConditions ingest rendered as a community service", () => {
  it("is a valid community manifest that declares its database URL and operator token as secrets", () => {
    expect(validateServiceManifest(manifest, { firstParty: false }).errors).toEqual([]);
    for (const key of secretKeys) expect(properties[key]?.["x-openmapx-secret"], key).toBe(true);
  });

  it("puts no compose interpolation in its environment", () => {
    for (const [key, value] of Object.entries(manifest.container.environment ?? {})) {
      expect(value, key).not.toContain("$");
    }
  });

  it("delivers every configured key to the environment unescaped", () => {
    const prefix = serviceConfigEnvPrefix(manifest.id);
    expect(prefix).toBe("SERVICE_OPENCONDITIONS_INGEST_");
    const env = Object.fromEntries(
      configKeys.map((key) => [`${prefix}${key}`, `operator-${key.toLowerCase()}`]),
    );
    const { environment } = renderedEnvironment(env);
    for (const key of configKeys) {
      expect(environment[key], key).toBe(`operator-${key.toLowerCase()}`);
    }
    for (const [key, value] of Object.entries(manifest.container.environment ?? {})) {
      expect(environment[key], key).toBe(value);
    }
    for (const [key, value] of Object.entries(environment)) {
      expect(value, key).not.toContain("$");
    }
  });

  it("falls back to each field's default when the operator sets nothing", () => {
    const { environment } = renderedEnvironment({});
    for (const key of configKeys) {
      const fallback = properties[key]?.default;
      if (fallback === undefined) expect(environment, key).not.toHaveProperty(key);
      else expect(environment[key], key).toBe(String(fallback));
    }
    expect(environment.RATE_LIMIT_MAX).toBe("120");
    expect(environment.TRUST_PROXY_CIDRS).toBe("loopback,linklocal,uniquelocal");
  });

  it("passes an admin render's env reference through unescaped while every manifest `$` stays escaped", () => {
    const hostile = structuredClone(manifest);
    const hostileProps = hostile.configSchema?.properties as Record<string, Property>;
    hostileProps.RATE_LIMIT_WINDOW_MS = {
      ...hostileProps.RATE_LIMIT_WINDOW_MS,
      default: "${POSTGRES_PASSWORD}",
    };
    const envKeys = ["RATE_LIMIT_MAX", "OVERPASS_URL"];
    const resolved = flattenResolvedConfig(resolveServiceConfigFromEnv(hostile, {}));
    for (const key of envKeys) delete resolved[key];
    // A value that only looks like a reference (an admin-form value) is data, not a reference.
    resolved.TRUST_PROXY_CIDRS = "${SERVICE_OPENCONDITIONS_INGEST_TRUST_PROXY_CIDRS:-}";

    const { environment } = rendered({ ...service, manifest: hostile }, resolved, envKeys);

    expect(environment.RATE_LIMIT_MAX).toBe("${SERVICE_OPENCONDITIONS_INGEST_RATE_LIMIT_MAX:-}");
    expect(environment.OVERPASS_URL).toBe("${SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL:-}");
    expect(environment.RATE_LIMIT_WINDOW_MS).toBe("$${POSTGRES_PASSWORD}");
    expect(environment.TRUST_PROXY_CIDRS).toBe(
      "$${SERVICE_OPENCONDITIONS_INGEST_TRUST_PROXY_CIDRS:-}",
    );
  });

  it.each([
    [false, "community"],
    [true, "built-in"],
  ])("escapes an env reference whose variable name Compose cannot parse (%s: %s)", (isBuiltIn) => {
    const odd = structuredClone(manifest);
    if (isBuiltIn) odd.quality = "built-in";
    const oddProps = odd.configSchema?.properties as Record<string, Property>;
    oddProps["a.b"] = { default: "" };
    oddProps["foo-bar"] = { default: "" };
    const { environment } = rendered({ ...service, manifest: odd, isBuiltIn }, {}, [
      "a.b",
      "foo-bar",
      "RATE_LIMIT_MAX",
    ]);
    expect(environment["a.b"]).toBe("$${SERVICE_OPENCONDITIONS_INGEST_A.B:-}");
    expect(environment["foo-bar"]).toBe("$${SERVICE_OPENCONDITIONS_INGEST_FOO-BAR:-}");
    expect(environment.RATE_LIMIT_MAX).toBe("${SERVICE_OPENCONDITIONS_INGEST_RATE_LIMIT_MAX:-}");
  });

  it("refuses an env reference to a secret or an undeclared key", () => {
    expect(() => rendered(service, {}, ["DATABASE_URL"])).toThrow(/DATABASE_URL/);
    expect(() => rendered(service, {}, ["POSTGRES_PASSWORD"])).toThrow(/POSTGRES_PASSWORD/);
  });

  it("mounts the vault secrets as files and never puts their values in the environment", () => {
    const { environment, secrets } = renderedEnvironment({});
    for (const key of secretKeys) {
      expect(environment[`${key}_FILE`], key).toBe(`/run/secrets/${key}`);
      expect(environment, key).not.toHaveProperty(key);
      expect(secrets).toContainEqual({ source: `${manifest.id}__${key}`, target: key });
    }
  });
});
