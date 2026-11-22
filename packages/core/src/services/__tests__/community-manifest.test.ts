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
  it.each(["community", "community-verified"])("accepts a pinned %s manifest", (quality) => {
    expect(communityServiceManifestProblems(manifest({ quality }))).toEqual([]);
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

  it.each([
    ["a built-in quality tier", { quality: "built-in" }, /built-in/],
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
