import { describe, expect, it } from "vitest";
import {
  configSchemaKeys,
  flattenResolvedConfig,
  resolveServiceConfigFromEnv,
  serviceConfigEnvPrefix,
} from "../services/config-resolver";

describe("serviceConfigEnvPrefix", () => {
  it("uppercases and replaces dashes with underscores", () => {
    expect(serviceConfigEnvPrefix("valhalla")).toBe("SERVICE_VALHALLA_");
    expect(serviceConfigEnvPrefix("data-manager")).toBe("SERVICE_DATA_MANAGER_");
  });
});

describe("configSchemaKeys", () => {
  it("returns empty array when schema is undefined", () => {
    expect(configSchemaKeys(undefined)).toEqual([]);
  });

  it("reads keys + defaults from a `properties` wrapper", () => {
    const result = configSchemaKeys({
      type: "object",
      properties: {
        memory_limit: { type: "string", default: "1g" },
        verbose: { type: "boolean", default: false },
        no_default: { type: "string" },
      },
    });
    expect(result).toEqual([
      { key: "memory_limit", default: "1g" },
      { key: "verbose", default: false },
      { key: "no_default", default: undefined },
    ]);
  });

  it("does not interpret a flat object as a config schema", () => {
    expect(configSchemaKeys({ foo: { default: "x" }, bar: {} })).toEqual([]);
  });

  it("skips reserved `type` and `properties` keys at the outer level", () => {
    const result = configSchemaKeys({
      type: "object",
      properties: { real: { default: 1 } },
    });
    expect(result.map((k) => k.key)).toEqual(["real"]);
  });

  it("skips `x-openmapx-secret` fields — secrets are delivered as files, never via the env map", () => {
    const result = configSchemaKeys({
      properties: {
        rate_limit: { type: "number", default: 120 },
        ny_511_api_key: { type: "string", "x-openmapx-secret": true },
      },
    });
    expect(result.map((k) => k.key)).toEqual(["rate_limit"]);
  });
});

describe("resolveServiceConfigFromEnv", () => {
  it("returns defaults when no env vars are set", () => {
    const r = resolveServiceConfigFromEnv(
      {
        id: "valhalla",
        configSchema: {
          type: "object",
          properties: { memory: { type: "string", default: "1g" } },
        },
      },
      {},
    );
    expect(r).toEqual({ memory: { value: "1g", source: "default" } });
  });

  it("overrides defaults with matching env vars (highest priority)", () => {
    const r = resolveServiceConfigFromEnv(
      {
        id: "valhalla",
        configSchema: {
          type: "object",
          properties: { memory: { type: "string", default: "1g" } },
        },
      },
      { SERVICE_VALHALLA_MEMORY: "4g" },
    );
    expect(r).toEqual({ memory: { value: "4g", source: "env" } });
  });

  it("uses SERVICE_<ID>_<KEY> with dashes translated to underscores", () => {
    const r = resolveServiceConfigFromEnv(
      {
        id: "data-manager",
        configSchema: {
          type: "object",
          properties: { data_dir: { type: "string", default: "/data" } },
        },
      },
      { SERVICE_DATA_MANAGER_DATA_DIR: "/srv/data" },
    );
    expect(r.data_dir).toEqual({ value: "/srv/data", source: "env" });
  });

  it("matches env key lookup case-insensitively against the schema key", () => {
    const r = resolveServiceConfigFromEnv(
      { id: "svc", configSchema: { type: "object", properties: { camelKey: {} } } },
      { SERVICE_SVC_CAMELKEY: "x" },
    );
    expect(r.camelKey).toEqual({ value: "x", source: "env" });
  });

  it("ignores env vars that don't match any schema key", () => {
    const r = resolveServiceConfigFromEnv(
      {
        id: "svc",
        configSchema: { type: "object", properties: { foo: { default: "d" } } },
      },
      { SERVICE_SVC_BAR: "nope" },
    );
    expect(r).toEqual({ foo: { value: "d", source: "default" } });
  });

  it("returns empty when configSchema has no keys", () => {
    expect(resolveServiceConfigFromEnv({ id: "svc" }, { SERVICE_SVC_X: "y" })).toEqual({});
  });

  it("omits keys with neither a default nor an env override", () => {
    const r = resolveServiceConfigFromEnv(
      { id: "svc", configSchema: { type: "object", properties: { foo: {} } } },
      {},
    );
    expect(r).toEqual({});
  });

  it("suppresses schema defaults whose key the manifest env already provides", () => {
    // Valhalla-style regression: the scripted image expects "True"/"False"
    // strings in env. A boolean schema default of `true` would stringify to
    // "true" at render time and silently replace the "True" already in
    // container.environment.
    const r = resolveServiceConfigFromEnv(
      {
        id: "valhalla",
        configSchema: {
          type: "object",
          properties: {
            build_elevation: { type: "boolean", default: true },
            extra_key: { type: "string", default: "seed" },
          },
        },
        container: { environment: { build_elevation: "True" } },
      },
      {},
    );
    expect(r.build_elevation).toBeUndefined();
    expect(r.extra_key).toEqual({ value: "seed", source: "default" });
  });

  it("still honours env overrides for keys the manifest env provides", () => {
    const r = resolveServiceConfigFromEnv(
      {
        id: "valhalla",
        configSchema: {
          type: "object",
          properties: { build_elevation: { type: "boolean", default: true } },
        },
        container: { environment: { build_elevation: "True" } },
      },
      { SERVICE_VALHALLA_BUILD_ELEVATION: "False" },
    );
    expect(r.build_elevation).toEqual({ value: "False", source: "env" });
  });
});

describe("flattenResolvedConfig", () => {
  it("strips source metadata, leaving just key → value", () => {
    expect(
      flattenResolvedConfig({
        a: { value: 1, source: "default" },
        b: { value: "two", source: "env" },
      }),
    ).toEqual({ a: 1, b: "two" });
  });
});
