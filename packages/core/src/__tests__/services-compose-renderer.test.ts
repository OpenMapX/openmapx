import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderCompose, renderServiceSnippet } from "../services/compose-renderer";
import type { LoadedService } from "../services/types";

function svc(id: string, opts: Partial<LoadedService["manifest"]> = {}): LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: `t/${id}`, tag: "latest", expose: [80] },
      ...opts,
    },
    directory: `/repo/services/${id}`,
    isBuiltIn: true,
    enabled: true,
  };
}

describe("renderServiceSnippet", () => {
  it("renders image:tag, expose, restart, network", () => {
    const snippet = renderServiceSnippet(
      svc("alpha", {
        container: {
          image: "t/alpha",
          tag: "1.2.3",
          expose: [80, 81],
          restart: "unless-stopped",
          memory: "512m",
        },
      }),
      {},
    );
    expect(snippet.image).toBe("t/alpha:1.2.3");
    expect(snippet.expose).toEqual(["80", "81"]);
    expect(snippet.restart).toBe("unless-stopped");
    expect(snippet.networks).toEqual(["openmapx"]);
    expect(snippet.deploy?.resources?.limits?.memory).toBe("512m");
  });

  it("renders host port mapping when exposure.hostPorts is set", () => {
    const snippet = renderServiceSnippet(
      svc("alpha", {
        exposure: {
          hostPorts: [{ container: 80, host: 8080, protocol: "tcp", bindAddress: "127.0.0.1" }],
        },
      }),
      {},
    );
    expect(snippet.ports).toEqual(["127.0.0.1:8080:80/tcp"]);
  });

  it("renders Traefik labels when exposure.proxy.enabled", () => {
    const snippet = renderServiceSnippet(
      svc("alpha", {
        exposure: { proxy: { enabled: true, pathPrefix: "/alpha", stripPrefix: true } },
        container: { image: "t/alpha", tag: "latest", expose: [3000] },
      }),
      { domain: "example.com" },
    );
    const labels = snippet.labels as Record<string, string>;
    expect(labels["traefik.enable"]).toBe("true");
    expect(labels["traefik.http.routers.alpha.rule"]).toContain("PathPrefix(`/alpha`)");
    expect(labels["traefik.http.routers.alpha.entrypoints"]).toBe("websecure");
    expect(labels["traefik.http.middlewares.alpha-strip.stripprefix.prefixes"]).toBe("/alpha");
    expect(labels["traefik.http.services.alpha.loadbalancer.server.port"]).toBe("3000");
  });

  it("renders environment from manifest + per-service config", () => {
    const snippet = renderServiceSnippet(
      svc("alpha", {
        container: {
          image: "t/alpha",
          tag: "latest",
          environment: { LOG_LEVEL: "info", FOO: "bar" },
        },
      }),
      {},
    );
    expect(snippet.environment).toEqual({ LOG_LEVEL: "info", FOO: "bar" });
  });

  it("renders volumes (named) and bind mounts for consumes/config", () => {
    const snippet = renderServiceSnippet(
      svc("alpha", {
        volumes: [{ name: "openmapx-alpha-data", mountAt: "/data" }],
        consumes: [{ type: "osm-pbf", mountAt: "/custom_files", required: true }],
      }),
      {
        consumesPaths: new Map([["osm-pbf", "./data/alpha"]]),
      },
    );
    expect(snippet.volumes).toEqual(
      expect.arrayContaining(["openmapx-alpha-data:/data", "./data/alpha:/custom_files"]),
    );
  });

  it("renders @docker-socket bindMount as /var/run/docker.sock", () => {
    const snippet = renderServiceSnippet(
      svc("traefik", {
        bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
      }),
      {},
    );
    expect(snippet.volumes).toEqual(["/var/run/docker.sock:/var/run/docker.sock:ro"]);
  });

  it("renders a relative-path bindMount as compose-relative when composeOutDir provided", () => {
    const snippet = renderServiceSnippet(
      svc("traefik", {
        bindMounts: [{ source: "config/traefik.yml", target: "/etc/traefik/traefik.yml" }],
      }),
      { composeOutDir: "/repo/infra/docker" },
    );
    // service directory is /repo/services/traefik
    // relative from /repo/infra/docker to /repo/services/traefik/config/traefik.yml
    expect(snippet.volumes).toEqual([
      "../../services/traefik/config/traefik.yml:/etc/traefik/traefik.yml:ro",
    ]);
  });

  it("honors readOnly: false for bindMounts (writable)", () => {
    const snippet = renderServiceSnippet(
      svc("svc", {
        bindMounts: [{ source: "config/data", target: "/var/data", readOnly: false }],
      }),
      { composeOutDir: "/repo/infra/docker" },
    );
    expect(snippet.volumes?.[0]).not.toMatch(/:ro$/);
    expect(snippet.volumes?.[0]).toMatch(/:\/var\/data$/);
  });

  it("emits absolute bindMount source when composeOutDir is not provided", () => {
    const snippet = renderServiceSnippet(
      svc("svc", {
        bindMounts: [{ source: "config/file.json", target: "/etc/file.json" }],
      }),
      {},
    );
    expect(snippet.volumes).toEqual(["/repo/services/svc/config/file.json:/etc/file.json:ro"]);
  });
});

describe("renderCompose", () => {
  it("produces valid YAML containing services, networks, and volumes sections", () => {
    const services = [
      svc("alpha", { volumes: [{ name: "openmapx-alpha-data", mountAt: "/d" }] }),
      svc("beta"),
    ];
    const result = renderCompose(services, { domain: "example.com" });
    const parsed = parseYaml(result.composeYaml) as Record<string, unknown>;

    expect(parsed.services).toBeDefined();
    expect((parsed.services as Record<string, unknown>).alpha).toBeDefined();
    expect((parsed.services as Record<string, unknown>).beta).toBeDefined();
    expect(parsed.networks).toEqual({ openmapx: { driver: "bridge" } });
    expect(parsed.volumes).toEqual({ "openmapx-alpha-data": null });
  });

  it("computes hardlink plan from consumes/produces", () => {
    const services = [
      svc("data-manager", {
        provides: ["osm-data"],
        produces: [{ type: "osm-data", sourceDir: "data/osm" }],
      }),
      svc("valhalla", {
        consumes: [{ type: "osm-data", mountAt: "/custom_files", required: true }],
      }),
    ];
    const result = renderCompose(services, { domain: "example.com" });
    expect(result.hardlinkPlan).toEqual([
      {
        source: "data/osm",
        target: "data/valhalla/osm-data",
        consumerService: "valhalla",
        dataType: "osm-data",
      },
    ]);
  });

  it("nests host paths by consumed type when a service consumes multiple types", () => {
    const services = [
      svc("dm", {
        provides: ["osm-data", "gtfs-data"],
        produces: [
          { type: "osm-data", sourceDir: "data/osm" },
          { type: "gtfs-data", sourceDir: "data/gtfs" },
        ],
      }),
      svc("motis", {
        consumes: [
          { type: "osm-data", mountAt: "/motis-data/osm", required: true },
          { type: "gtfs-data", mountAt: "/motis-data/gtfs", required: true },
        ],
      }),
    ];
    const result = renderCompose(services, { domain: "example.com" });
    // Hardlink plan: distinct host targets per consumed type.
    expect(result.hardlinkPlan).toEqual([
      {
        source: "data/osm",
        target: "data/motis/osm-data",
        consumerService: "motis",
        dataType: "osm-data",
      },
      {
        source: "data/gtfs",
        target: "data/motis/gtfs-data",
        consumerService: "motis",
        dataType: "gtfs-data",
      },
    ]);
    // Compose volumes: distinct mount sources.
    expect(result.composeYaml).toContain("./data/motis/osm-data:/motis-data/osm");
    expect(result.composeYaml).toContain("./data/motis/gtfs-data:/motis-data/gtfs");
  });

  it("topologically sorts services so producers come before consumers", () => {
    const services = [
      svc("valhalla", {
        consumes: [{ type: "osm-data", mountAt: "/custom_files", required: true }],
      }),
      svc("data-manager", {
        provides: ["osm-data"],
        produces: [{ type: "osm-data", sourceDir: "data/osm" }],
      }),
    ];
    const result = renderCompose(services, { domain: "example.com" });
    const parsed = parseYaml(result.composeYaml) as { services: Record<string, unknown> };
    const ids = Object.keys(parsed.services);
    expect(ids.indexOf("data-manager")).toBeLessThan(ids.indexOf("valhalla"));
  });
});
