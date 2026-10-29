import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderServiceSnippet } from "../compose-renderer";
import { resolveServiceConfigFromEnv } from "../config-resolver";
import {
  assertTrustedConfigurationSchema,
  validateTrustedConfigurationValues,
} from "../configuration-schema";
import type { LoadedService, ServiceManifest } from "../types";

const servicesDir = resolve(import.meta.dirname, "../../../../../services");
const expectedIds =
  "app-api app-web brouter data-manager dawarich-app dawarich-postgis dawarich-redis dawarich-sidekiq elasticsearch local-ai martin motis motis-feed-proxy motis-staging nominatim ops-agent osrm otp overpass pelias pelias-pip pelias-placeholder photon postgis redis tileserver traefik transitous-runner valhalla well-known"
    .split(" ")
    .sort();
function manifest(id: string): ServiceManifest {
  return JSON.parse(readFileSync(resolve(servicesDir, id, "service.json"), "utf8"));
}
function render(id: string, values: Record<string, unknown>, isBuiltIn = true) {
  const service: LoadedService = {
    manifest: manifest(id),
    directory: resolve(servicesDir, id),
    isBuiltIn,
    enabled: true,
  };
  return renderServiceSnippet(service, {
    existsSync: () => true,
    resolvedServiceConfigs: new Map([[id, values]]),
  });
}
describe("operator runtime resources", () => {
  it("covers the exact built-in inventory with bounded optional resource fields", () => {
    expect(
      readdirSync(servicesDir)
        .filter((id) => {
          try {
            manifest(id);
            return true;
          } catch {
            return false;
          }
        })
        .sort(),
    ).toEqual(expectedIds);
    for (const id of expectedIds) {
      expect(() => assertTrustedConfigurationSchema(manifest(id).configSchema), id).not.toThrow();
      const props = manifest(id).configSchema?.properties as Record<string, unknown>;
      expect(props?.OPENMAPX_MEMORY_MIB, id).toMatchObject({
        type: "integer",
        minimum: 16,
        maximum: 1048576,
      });
      expect(props?.OPENMAPX_CPU_LIMIT, id).toMatchObject({
        type: "number",
        minimum: 0.125,
        maximum: 256,
      });
    }
    expect(manifest("valhalla").configSchema?.properties).toHaveProperty("build_elevation");
    expect(manifest("dawarich-app").configSchema?.properties).toHaveProperty("DATABASE_PASSWORD");
  });
  it("renders resource limits instead of environment, preserving unoverridden defaults and GPU", () => {
    expect(
      render("local-ai", { OPENMAPX_MEMORY_MIB: 4096, OPENMAPX_CPU_LIMIT: 1.5 }).deploy?.resources,
    ).toMatchObject({ limits: { memory: "4096m", cpus: "1.5" } });
    expect(render("local-ai", {}).deploy?.resources?.limits?.memory).toBe("${LOCAL_AI_MEMORY:-8g}");
    expect(render("local-ai", { OPENMAPX_MEMORY_MIB: 4096 }).environment).not.toHaveProperty(
      "OPENMAPX_MEMORY_MIB",
    );
    expect(render("redis", {}).environment).toEqual(manifest("redis").container.environment);
  });
  it.each([0, 15, 1048577, 16.5, "32", NaN, Infinity])(
    "refuses invalid memory %s at the render boundary",
    (value) => {
      expect(() => render("redis", { OPENMAPX_MEMORY_MIB: value })).toThrow();
    },
  );
  it.each([0, 0.124, 257, "2", NaN])("refuses invalid CPU %s", (value) => {
    expect(() => render("redis", { OPENMAPX_CPU_LIMIT: value })).toThrow();
  });
  it("refuses community resource escalation regardless of its claimed built-in id", () => {
    expect(() => render("redis", { OPENMAPX_MEMORY_MIB: 4096 }, false)).toThrow();
  });
  it("coordinates both MOTIS slots and the data-manager capacity projection", () => {
    const values = new Map([["motis", { OPENMAPX_MEMORY_MIB: 32768, OPENMAPX_CPU_LIMIT: 8 }]]);
    for (const id of ["motis", "motis-staging"])
      expect(
        renderServiceSnippet(
          { manifest: manifest(id), directory: "/fake", isBuiltIn: true, enabled: true },
          { existsSync: () => true, resolvedServiceConfigs: values },
        ).deploy?.resources?.limits,
      ).toEqual({ memory: "32768m", cpus: "8" });
    expect(
      renderServiceSnippet(
        { manifest: manifest("data-manager"), directory: "/fake", isBuiltIn: true, enabled: true },
        {
          existsSync: () => true,
          allServices: expectedIds.map((id) => ({
            manifest: manifest(id),
            directory: resolve(servicesDir, id),
            isBuiltIn: true,
            enabled: true,
          })),
          resolvedServiceConfigs: values,
        },
      ).environment,
    ).toMatchObject({ MOTIS_SLOT_MEMORY_GB: "32", MOTIS_SLOT_CPU: "8" });
    expect(() => render("motis-staging", { OPENMAPX_MEMORY_MIB: 4096 })).toThrow(/primary/);
  });
  it("synthesizes only finite Elasticsearch heap flags and capitalizes Valhalla booleans", () => {
    expect(
      render("elasticsearch", { OPENMAPX_JAVA_HEAP_MIB: 1024 }).environment?.ES_JAVA_OPTS,
    ).toBe("-Xms1024m -Xmx1024m");
    expect(
      render("elasticsearch", { OPENMAPX_JAVA_HEAP_MIB: 1024 }).environment,
    ).not.toHaveProperty("OPENMAPX_JAVA_HEAP_MIB");
    expect(
      render("valhalla", { serve_tiles: false, build_elevation: true }).environment,
    ).toMatchObject({ serve_tiles: "False", build_elevation: "True" });
    expect(() =>
      render("elasticsearch", { OPENMAPX_JAVA_HEAP_MIB: "1024 -javaagent:x" }),
    ).toThrow();
  });
  it("owns host-backed resource expressions and parses SERVICE numeric intent strictly", () => {
    expect(
      resolveServiceConfigFromEnv(manifest("local-ai"), { LOCAL_AI_MEMORY: "16g" })
        .OPENMAPX_MEMORY_MIB,
    ).toMatchObject({ source: "env" });
    expect(
      resolveServiceConfigFromEnv(manifest("redis"), { SERVICE_REDIS_OPENMAPX_MEMORY_MIB: "4096" })
        .OPENMAPX_MEMORY_MIB,
    ).toMatchObject({ source: "env", value: 4096 });
    expect(() =>
      resolveServiceConfigFromEnv(manifest("redis"), {
        SERVICE_REDIS_OPENMAPX_MEMORY_MIB: "garbage",
      }),
    ).toThrow();
  });
  it("validates supported settings and URL forms with the same trusted snapshot grammar", () => {
    const schema = manifest("app-web").configSchema;
    expect(
      validateTrustedConfigurationValues(
        {
          NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL: "/local-dem/tiles.json",
          NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE: "/traffic/{z}/{x}/{y}.png",
          NEXT_PUBLIC_TRAFFIC_MIN_ZOOM: 8,
        },
        schema,
      ),
    ).toBe(true);
    for (const value of [
      "//evil.test/x",
      "https://u:p@evil.test/x",
      "/x\\y",
      "/x/{unsupported}",
      "/x\n",
    ])
      expect(
        validateTrustedConfigurationValues(
          { NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE: value },
          schema,
        ),
        value,
      ).toBe(false);
    expect(validateTrustedConfigurationValues({ NEXT_PUBLIC_TILES_URL: "/x/{z}" }, schema)).toBe(
      false,
    );
    expect(validateTrustedConfigurationValues({ NEXT_PUBLIC_TRAFFIC_MIN_ZOOM: 25 }, schema)).toBe(
      false,
    );
  });
});
