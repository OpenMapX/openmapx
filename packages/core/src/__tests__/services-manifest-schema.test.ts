import { describe, expect, it } from "vitest";
import { validateServiceManifest } from "../services/manifest-schema";

const validMinimal = {
  id: "valhalla",
  name: "Valhalla",
  version: "1.0.0",
  quality: "built-in",
  container: {
    image: "ghcr.io/valhalla/valhalla-scripted",
    tag: "latest",
    expose: [8002],
  },
  provides: ["routing-engine"],
};

describe("validateServiceManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const result = validateServiceManifest(validMinimal);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects manifest missing id", () => {
    const result = validateServiceManifest({ ...validMinimal, id: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/id/);
  });

  it("rejects image containing a colon (tag must be separate)", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      container: { ...validMinimal.container, image: "valhalla:latest" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/image/);
  });

  it("rejects image with uppercase characters", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      container: { ...validMinimal.container, image: "Valhalla/Server" },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects volume name without openmapx- prefix", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      volumes: [{ name: "valhalla-tiles", mountAt: "/data" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/volumes/);
  });

  it("accepts volume with openmapx- prefix", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      volumes: [{ name: "openmapx-valhalla-tiles", mountAt: "/data" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects mountAt with parent traversal", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      consumes: [{ type: "osm-pbf", mountAt: "/foo/../etc", required: true }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/mountAt/);
  });

  it("rejects mountAt that is not absolute", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      consumes: [{ type: "osm-pbf", mountAt: "data", required: true }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects unknown capAdd entries (must be uppercase Linux capability)", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      container: { ...validMinimal.container, capAdd: ["random-thing"] },
    });
    expect(result.valid).toBe(false);
  });

  it("accepts well-known capAdd entries", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      container: { ...validMinimal.container, capAdd: ["NET_ADMIN", "SYS_PTRACE"] },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects networkMode: host for community service", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      quality: "community",
      container: { ...validMinimal.container, networkMode: "host" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/network/i);
  });

  it("accepts networkMode: host for built-in service", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      quality: "built-in",
      container: { ...validMinimal.container, networkMode: "host" },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects exposure.proxy.pathPrefix without leading slash", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      exposure: { proxy: { enabled: true, pathPrefix: "valhalla" } },
    });
    expect(result.valid).toBe(false);
  });

  it("accepts bindMounts with a relative source for built-in services", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      bindMounts: [{ source: "config/valhalla.json", target: "/etc/valhalla.json" }],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts @docker-socket as a bindMount source for built-in services", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects bindMounts with an absolute source path", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      bindMounts: [{ source: "/etc/passwd", target: "/mnt/passwd" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/source/);
  });

  it("rejects bindMounts with parent traversal in source", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      bindMounts: [{ source: "../etc/passwd", target: "/mnt/passwd" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects unknown @-prefixed special bindMount sources", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      bindMounts: [{ source: "@not-a-real-source", target: "/foo" }],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts relative-path bindMounts for community services (ship own configs)", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      quality: "community",
      bindMounts: [{ source: "config/file.json", target: "/etc/file.json" }],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts relative-path bindMounts for community-verified services", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      quality: "community-verified",
      bindMounts: [{ source: "config/settings.yml", target: "/app/settings.yml" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects @docker-socket bindMount source for community services", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      quality: "community",
      bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/built-in/);
  });

  it("rejects @docker-socket bindMount source for community-verified services", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      quality: "community-verified",
      bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts @service:<slug>:<path> bindMount source for built-in services", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      bindMounts: [{ source: "@service:pelias:config/pelias.json", target: "/code/pelias.json" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects @service:<slug>:<path> with parent traversal in path", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      bindMounts: [{ source: "@service:pelias:../etc/passwd", target: "/etc/passwd" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects @service:<slug>:<path> with absolute path part", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      bindMounts: [{ source: "@service:pelias:/etc/passwd", target: "/etc/passwd" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects @service:<slug>:<path> for community services", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      quality: "community",
      bindMounts: [{ source: "@service:pelias:config/pelias.json", target: "/code/pelias.json" }],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts exposure.proxy.additionalRoutes with path or pathPrefix", () => {
    const r1 = validateServiceManifest({
      ...validMinimal,
      exposure: {
        proxy: {
          enabled: true,
          pathPrefix: "/api",
          additionalRoutes: [{ path: "/health" }],
        },
      },
    });
    expect(r1.valid).toBe(true);

    const r2 = validateServiceManifest({
      ...validMinimal,
      exposure: {
        proxy: {
          enabled: true,
          pathPrefix: "/api",
          additionalRoutes: [{ pathPrefix: "/v2" }],
        },
      },
    });
    expect(r2.valid).toBe(true);
  });

  it("rejects exposure.proxy.additionalRoutes with both path and pathPrefix", () => {
    const result = validateServiceManifest({
      ...validMinimal,
      exposure: {
        proxy: {
          enabled: true,
          pathPrefix: "/api",
          additionalRoutes: [{ path: "/health", pathPrefix: "/v2" }],
        },
      },
    });
    expect(result.valid).toBe(false);
  });

  describe("produces / consumes instance ids", () => {
    it("accepts valid instance ids on produces and consumes", () => {
      const result = validateServiceManifest({
        ...validMinimal,
        produces: [
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/europe" },
          { type: "osm-pbf", instance: "north-america", sourceDir: "data/osm/north-america" },
        ],
        consumes: [
          { type: "osm-pbf", instance: "europe", mountAt: "/custom_files", required: true },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it("rejects an instance id that doesn't match the slug regex", () => {
      const result = validateServiceManifest({
        ...validMinimal,
        produces: [{ type: "osm-pbf", instance: "Europe!", sourceDir: "data/osm/europe" }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/lowercase/);
    });

    it("rejects duplicate (type, instance) on produces", () => {
      const result = validateServiceManifest({
        ...validMinimal,
        produces: [
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/eu1" },
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/eu2" },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/duplicate.*europe/);
    });

    it("rejects two default-instance produces entries for the same type", () => {
      const result = validateServiceManifest({
        ...validMinimal,
        produces: [
          { type: "osm-pbf", sourceDir: "data/osm/a" },
          { type: "osm-pbf", sourceDir: "data/osm/b" },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/default-instance/);
    });

    it("allows the same type with one default and one instanced entry on the same producer", () => {
      const result = validateServiceManifest({
        ...validMinimal,
        produces: [
          { type: "osm-pbf", sourceDir: "data/osm/global" },
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/europe" },
        ],
      });
      expect(result.valid).toBe(true);
    });
  });
});
