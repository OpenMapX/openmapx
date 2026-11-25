import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { communityServiceManifestProblems } from "../community-manifest";
import { CORE_SERVICE_ID } from "../core-service-ids";
import { ServiceRegistry } from "../registry";
import type { ServiceManifest } from "../types";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "maps-tiles",
    name: "Map tiles",
    version: "1.0.0",
    platform: "1.0",
    quality: "community",
    container: {
      image: "registry.example.test/maps-tiles",
      tag: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      memory: "256m",
    },
    ...overrides,
  };
}

describe("communityServiceManifestProblems", () => {
  it("accepts a pinned community manifest", () => {
    expect(communityServiceManifestProblems(manifest())).toEqual([]);
  });

  it("refuses a protocol this host does not support", () => {
    expect(communityServiceManifestProblems(manifest({ platform: "2.0" }))).toEqual([
      'Service "maps-tiles" requires extension protocol 2.0; this host supports 1.0',
    ]);
  });

  it("accepts built-in services reached by their project-unique names", () => {
    const container = {
      image: "registry.example.test/x",
      tag: "1",
      digest: `sha256:${"a".repeat(64)}`,
      memory: "256m",
      environment: {
        DATABASE_URL: "postgresql://ingest@openmapx-postgis:5432/openmapx",
        OVERPASS_URL: "http://openmapx-overpass:80",
        UPSTREAM: "https://api.example.test/postgis",
      },
    };
    expect(communityServiceManifestProblems(manifest({ container }))).toEqual([]);
  });

  it("does not read user names, package scopes or path segments as hosts", () => {
    const container = {
      image: "registry.example.test/x",
      tag: "1",
      digest: `sha256:${"a".repeat(64)}`,
      memory: "256m",
      command: ["npx", "@web/dev-server", "--contact", "mailto:ops@web"],
      environment: {
        DATABASE_URL: "postgresql://api:secret@openmapx-postgis:5432/openmapx",
        TILES_URL: "https://martin:token@tiles.example.org/",
        UPSTREAM: "https://example.com//api/v1",
        DB_HOST: "openmapx-postgis",
        API_HOST: "api.example.org",
        REDIS_ADDR: "openmapx-redis:6379",
      },
    };
    expect(communityServiceManifestProblems(manifest({ container }))).toEqual([]);
  });

  it.each([
    ["a host variable", { environment: { DB_HOST: "postgis" } }, "postgis"],
    ["a host variable with a port", { environment: { REDIS_ADDR: "redis:6379" } }, "redis"],
    ["a bare host and port", { environment: { BROKER: "redis:6379" } }, "redis"],
    ["a fully qualified bare host", { environment: { URL: "http://overpass./api" } }, "overpass"],
    ["a command assignment", { command: ["sh", "-c", "DB_HOST=postgis ./run"] }, "postgis"],
    ["a command option", { command: ["serve", "--db-host=postgis"] }, "postgis"],
    [
      "a healthcheck",
      { healthcheck: { type: "exec", command: ["curl", "-f", "http://api:3001/health"] } },
      "api",
    ],
  ])("rejects a built-in service reached by its bare ID in %s", (_label, fields, host) => {
    const container = {
      image: "registry.example.test/x",
      tag: "1",
      digest: `sha256:${"a".repeat(64)}`,
      memory: "256m",
      ...fields,
    };
    expect(communityServiceManifestProblems(manifest({ container }))).toEqual([
      `Service "maps-tiles" reaches built-in service "${host}" by its bare ID; use "openmapx-${host}"`,
    ]);
  });

  it("rejects a bare host in a nested configuration default", () => {
    const configSchema = {
      type: "object",
      properties: {
        DATABASE: {
          type: "object",
          properties: { DB_HOST: { type: "string", default: "postgis" } },
        },
      },
    };
    expect(communityServiceManifestProblems(manifest({ configSchema }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/reaches built-in service "postgis"/)]),
    );
  });

  it.each([
    ["a built-in quality tier", { quality: "built-in" }, /^quality: /],
    ["a self-declared verified tier", { quality: "community-verified" }, /^quality: /],
    ["no protocol version", { platform: undefined }, /^platform: /],
    ["a version that is not semantic", { version: "2024.1" }, /^version: /],
    ["an unknown top-level key", { category: "Maps" }, /category/],
    ["an un-namespaced capability", { provides: ["tiles"] }, /^provides\[0\]: "tiles"/],
    ["an id longer than 48 characters", { id: "x".repeat(49) }, /^id: /],
    [
      "an image without a digest",
      { container: { image: "registry.example.test/x", tag: "latest", memory: "256m" } },
      /must pin its container image by sha256 digest/,
    ],
    [
      "a host bind mount",
      { bindMounts: [{ source: "/etc", target: "/host-etc", readOnly: false }] },
      /community_bind_mount_forbidden/,
    ],
    [
      "a privileged container",
      {
        container: {
          image: "registry.example.test/x",
          tag: "1",
          digest: `sha256:${"a".repeat(64)}`,
          memory: "256m",
          privileged: true,
        },
      },
      /privileged/,
    ],
    ["an id outside the plain service-id form", { id: "Maps_Tiles" }, /^id: /],
    [
      "the id of a built-in service",
      { id: "traefik" },
      /^Service id "traefik" belongs to a built-in service$/,
    ],
    [
      "the id of the built-in API",
      { id: CORE_SERVICE_ID.api },
      /^Service id "[a-z-]+" belongs to a built-in service$/,
    ],
    [
      "an id with the reserved network-name prefix",
      { id: "openmapx-tiles" },
      /reserved_network_name/,
    ],
    [
      "a network alias with the reserved network-name prefix",
      {
        container: {
          image: "registry.example.test/x",
          tag: "1",
          digest: `sha256:${"a".repeat(64)}`,
          memory: "256m",
          networkAliases: ["openmapx-postgis"],
        },
      },
      /^reserved_network_name: network alias "openmapx-postgis"/,
    ],
    [
      "a built-in service reached by its bare ID",
      {
        container: {
          image: "registry.example.test/x",
          tag: "1",
          digest: `sha256:${"a".repeat(64)}`,
          memory: "256m",
          environment: { DATABASE_URL: "postgresql://ingest@postgis:5432/openmapx" },
        },
      },
      /^Service "maps-tiles" reaches built-in service "postgis" by its bare ID; use "openmapx-postgis"$/,
    ],
    [
      "a built-in service reached by its bare ID in a configuration default",
      {
        configSchema: {
          type: "object",
          properties: { OVERPASS_URL: { type: "string", default: "http://overpass" } },
        },
      },
      /reaches built-in service "overpass" by its bare ID/,
    ],
  ])("rejects %s", (_label, overrides, problem) => {
    expect(communityServiceManifestProblems(manifest(overrides))).toEqual(
      expect.arrayContaining([expect.stringMatching(problem)]),
    );
  });

  it("rejects input that is not a manifest", () => {
    expect(communityServiceManifestProblems(null).length).toBeGreaterThan(0);
    expect(communityServiceManifestProblems([]).length).toBeGreaterThan(0);
  });
});

describe("ServiceRegistry communityServices", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openmapx-community-registry-"));
    mkdirSync(join(root, "services", "postgis"), { recursive: true });
    writeFileSync(
      join(root, "services", "postgis", "service.json"),
      JSON.stringify({
        id: "postgis",
        name: "PostGIS",
        version: "1.0.0",
        quality: "built-in",
        container: { image: "postgis/postgis", tag: "17" },
      }),
    );
    // A checkout the supplied list must take precedence over.
    const scanned = join(root, "services", ".community", "0".repeat(16), "scanned");
    mkdirSync(scanned, { recursive: true });
    writeFileSync(join(scanned, "service.json"), JSON.stringify(manifest({ id: "scanned" })));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses the supplied services instead of scanning the community checkout", async () => {
    const warnings: string[] = [];
    const registry = new ServiceRegistry({
      rootDir: root,
      warnings,
      enabledIds: new Set(["maps-tiles"]),
      communityServices: [
        {
          manifest: manifest() as unknown as ServiceManifest,
          directory: "/srv/openmapx/services/.community/1111111111111111/maps-tiles",
          isBuiltIn: false,
          enabled: false,
        },
        {
          manifest: manifest({ id: "postgis" }) as unknown as ServiceManifest,
          directory: "/srv/openmapx/services/.community/1111111111111111/postgis",
          isBuiltIn: false,
          enabled: false,
        },
      ],
    });

    await registry.load();

    expect(registry.get("scanned")).toBeUndefined();
    expect(registry.get("maps-tiles")).toMatchObject({ isBuiltIn: false, enabled: true });
    // A community service can never shadow a built-in one.
    expect(registry.get("postgis")).toMatchObject({ isBuiltIn: true });
    expect(warnings).toEqual([
      expect.stringMatching(
        /^Community service "postgis" .+ its ID belongs to a built-in service$/,
      ),
    ]);
  });
});
