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

  it("omits container_name by default and emits it when containerName is set", () => {
    expect(renderServiceSnippet(svc("alpha"), {}).container_name).toBeUndefined();
    const pinned = renderServiceSnippet(
      svc("motis-staging", {
        container: { image: "t/motis", tag: "2.10.2", containerName: "motis-staging" },
      }),
      {},
    );
    // Pinned name lets the data-manager reach the container by bare name over
    // the docker CLI (`docker exec motis-staging`, `docker restart motis`).
    expect(pinned.container_name).toBe("motis-staging");
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

  it("renders a UDP host port mapping (HTTP/3 / QUIC)", () => {
    const snippet = renderServiceSnippet(
      svc("alpha", {
        exposure: {
          hostPorts: [
            { container: 443, host: 443 },
            { container: 443, host: 443, protocol: "udp" },
          ],
        },
      }),
      {},
    );
    expect(snippet.ports).toEqual(["443:443", "443:443/udp"]);
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

  it("renders environment from manifest when no resolved config present", () => {
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

  it("overlays resolvedServiceConfigs on top of the manifest environment", () => {
    const snippet = renderServiceSnippet(
      svc("alpha", {
        container: {
          image: "t/alpha",
          tag: "latest",
          environment: { LOG_LEVEL: "info", MEMORY: "1g" },
        },
      }),
      {
        resolvedServiceConfigs: new Map([["alpha", { MEMORY: "4g", EXTRA: "from-admin" }]]),
      },
    );
    // MEMORY overridden, LOG_LEVEL preserved, EXTRA added.
    expect(snippet.environment).toEqual({
      LOG_LEVEL: "info",
      MEMORY: "4g",
      EXTRA: "from-admin",
    });
  });

  it("coerces non-string resolved config values to strings for compose env", () => {
    const snippet = renderServiceSnippet(svc("alpha"), {
      resolvedServiceConfigs: new Map([["alpha", { WORKERS: 4, DEBUG: true }]]),
    });
    expect(snippet.environment).toEqual({ WORKERS: "4", DEBUG: "true" });
  });

  it("skips null/undefined resolved values so partial maps don't blank manifest env", () => {
    const snippet = renderServiceSnippet(
      svc("alpha", {
        container: { image: "t/alpha", tag: "latest", environment: { KEEP: "me" } },
      }),
      {
        resolvedServiceConfigs: new Map([
          ["alpha", { KEEP: undefined as unknown as string, OTHER: null as unknown as string }],
        ]),
      },
    );
    expect(snippet.environment).toEqual({ KEEP: "me" });
  });

  it("only applies resolved config for the matching service id", () => {
    const snippet = renderServiceSnippet(svc("alpha"), {
      resolvedServiceConfigs: new Map([["beta", { BAD: "wrong" }]]),
    });
    expect(snippet.environment).toBeUndefined();
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

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: strings are literal compose-substitution syntax, not JS template placeholders
  it("passes through ${VAR}-prefixed bindMount sources verbatim for compose substitution", () => {
    // app-api opts into a host-path-agreeing bind mount (docker-outside-of-
    // docker admin control) by pointing both sides at the same operator-set
    // env var. The renderer must not try to resolve `${OPENMAPX_HOST_DIR}`
    // relative to the service directory.
    const snippet = renderServiceSnippet(
      svc("app-api", {
        bindMounts: [
          {
            source: "${OPENMAPX_HOST_DIR:-/tmp/openmapx-host-not-configured}",
            target: "${OPENMAPX_HOST_DIR:-/tmp/openmapx-host-not-configured}",
            readOnly: false,
          },
        ],
      }),
      { composeOutDir: "/repo/infra/docker" },
    );
    expect(snippet.volumes).toEqual([
      "${OPENMAPX_HOST_DIR:-/tmp/openmapx-host-not-configured}:${OPENMAPX_HOST_DIR:-/tmp/openmapx-host-not-configured}",
    ]);
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: strings are literal compose-substitution syntax, not JS template placeholders

  it("renders @docker-socket bindMount as /var/run/docker.sock + adds the docker group", () => {
    const snippet = renderServiceSnippet(
      svc("traefik", {
        bindMounts: [{ source: "@docker-socket", target: "/var/run/docker.sock" }],
      }),
      {},
    );
    expect(snippet.volumes).toEqual(["/var/run/docker.sock:/var/run/docker.sock:ro"]);
    // A socket-mounting container must join the socket's group (root:docker, 660)
    // or it gets "permission denied"; the gid is host-specific via DOCKER_GID.
    expect(snippet.group_add).toEqual([expect.stringContaining("${DOCKER_GID")]);
  });

  it("does not add group_add for services that don't mount the docker socket", () => {
    const snippet = renderServiceSnippet(
      svc("plain", { bindMounts: [{ source: "config/x.json", target: "/etc/x.json" }] }),
      {},
    );
    expect(snippet.group_add).toBeUndefined();
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

  describe("optional bindMounts", () => {
    it("emits an optional bindMount when its host source exists", () => {
      const warnings: string[] = [];
      const snippet = renderServiceSnippet(
        svc("data-manager", {
          bindMounts: [
            {
              source: "@infra:secrets/transitous-feed-proxy.age",
              target: "/secrets/transitous-feed-proxy.age",
              readOnly: true,
              optional: true,
            },
          ],
        }),
        {
          composeOutDir: "/repo/infra/docker",
          existsSync: (p) => p === "/repo/infra/docker/secrets/transitous-feed-proxy.age",
          warnings,
        },
      );
      expect(snippet.volumes).toEqual([
        "./secrets/transitous-feed-proxy.age:/secrets/transitous-feed-proxy.age:ro",
      ]);
      expect(warnings).toEqual([]);
    });

    it("skips an optional bindMount and emits an advisory when its host source is missing", () => {
      const warnings: string[] = [];
      const snippet = renderServiceSnippet(
        svc("data-manager", {
          bindMounts: [
            {
              source: "@infra:secrets/transitous-feed-proxy.age",
              target: "/secrets/transitous-feed-proxy.age",
              readOnly: true,
              optional: true,
            },
          ],
        }),
        {
          composeOutDir: "/repo/infra/docker",
          existsSync: () => false,
          warnings,
        },
      );
      // The optional mount was skipped → no volumes for this service.
      expect(snippet.volumes).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("skipping optional bind-mount");
      expect(warnings[0]).toContain("@infra:secrets/transitous-feed-proxy.age");
      expect(warnings[0]).toContain("/repo/infra/docker/secrets/transitous-feed-proxy.age");
    });

    it("preserves existing behaviour for non-optional mounts whose source does not exist", () => {
      const warnings: string[] = [];
      const snippet = renderServiceSnippet(
        svc("svc", {
          bindMounts: [
            {
              source: "config/missing.json",
              target: "/etc/missing.json",
            },
          ],
        }),
        {
          composeOutDir: "/repo/infra/docker",
          existsSync: () => false,
          warnings,
        },
      );
      // No `optional` flag → emit the mount unchanged, no advisory.
      expect(snippet.volumes).toEqual([
        "../../services/svc/config/missing.json:/etc/missing.json:ro",
      ]);
      expect(warnings).toEqual([]);
    });
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
    expect(parsed.networks).toEqual({
      openmapx: {
        driver: "bridge",
        enable_ipv6: true,
        ipam: { config: [{ subnet: "fd4d:5058::/64" }] },
      },
    });
    expect(parsed.volumes).toEqual({ "openmapx-alpha-data": null });
  });

  it("forwards resolvedServiceConfigs into each service's rendered environment", () => {
    const services = [
      svc("alpha", {
        container: {
          image: "t/alpha",
          tag: "latest",
          environment: { LOG_LEVEL: "info" },
        },
      }),
      svc("beta"),
    ];
    const result = renderCompose(services, {
      domain: "example.com",
      resolvedServiceConfigs: new Map([
        ["alpha", { LOG_LEVEL: "debug", NEW_KEY: "x" }],
        ["beta", { SOMETHING: "y" }],
      ]),
    });
    const parsed = parseYaml(result.composeYaml) as Record<string, { environment?: unknown }>;
    const composeServices = parsed.services as Record<string, { environment?: unknown }>;
    expect(composeServices.alpha.environment).toEqual({ LOG_LEVEL: "debug", NEW_KEY: "x" });
    expect(composeServices.beta.environment).toEqual({ SOMETHING: "y" });
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

  it("passes consumes targetFilename through to the hardlink plan", () => {
    const services = [
      svc("data-manager", {
        produces: [{ type: "osm-pbf", sourceDir: "data/osm" }],
      }),
      svc("nominatim", {
        consumes: [
          {
            type: "osm-pbf",
            mountAt: "/nominatim/data",
            targetFilename: "data.osm.pbf",
            required: true,
          },
        ],
      }),
    ];
    const result = renderCompose(services, { domain: "example.com" });
    expect(result.hardlinkPlan).toEqual([
      {
        source: "data/osm",
        target: "data/nominatim/osm-pbf",
        consumerService: "nominatim",
        dataType: "osm-pbf",
        targetFilename: "data.osm.pbf",
      },
    ]);
    expect(result.composeYaml).toContain("./data/nominatim/osm-pbf:/nominatim/data");
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

  it("emits one Traefik router per additionalRoutes entry, all bound to the same backend", () => {
    const list = [
      svc("app-api", {
        container: { image: "ghcr.io/x/api", tag: "latest", expose: [3001] },
        exposure: {
          proxy: {
            enabled: true,
            pathPrefix: "/api",
            additionalRoutes: [{ path: "/health" }],
          },
        },
      }),
    ];
    const result = renderCompose(list, { domain: "example.com" });
    expect(result.composeYaml).toContain("traefik.http.routers.app-api.rule");
    expect(result.composeYaml).toContain("traefik.http.routers.app-api-r1.rule");
    expect(result.composeYaml).toContain("Path(`/health`)");
    // Secondary router routes to the SAME backend service.
    expect(result.composeYaml).toContain("traefik.http.routers.app-api-r1.service: app-api");
  });

  it("resolves @service:<slug>:<path> bindMounts against the named service's directory", () => {
    const pelias = svc("pelias", {});
    const placeholder = svc("pelias-placeholder", {
      bindMounts: [{ source: "@service:pelias:config/pelias.json", target: "/code/pelias.json" }],
    });
    const result = renderCompose([pelias, placeholder], {
      domain: "example.com",
      composeOutDir: "/repo/infra/docker",
    });
    expect(result.composeYaml).toContain(
      "../../services/pelias/config/pelias.json:/code/pelias.json:ro",
    );
  });

  it("rejects @service:<slug>:<path> when the target service is unknown at render time", () => {
    const orphan = svc("placeholder", {
      bindMounts: [{ source: "@service:nonexistent:config/x.json", target: "/code/x.json" }],
    });
    expect(() => renderCompose([orphan], { domain: "example.com" })).toThrow(/not found/);
  });

  it("rejects two services that pin the same container_name", () => {
    const a = svc("svc-a", {
      container: { image: "t/a", tag: "1", containerName: "shared" },
    });
    const b = svc("svc-b", {
      container: { image: "t/b", tag: "1", containerName: "shared" },
    });
    expect(() => renderCompose([a, b], { domain: "example.com" })).toThrow(
      /[Dd]uplicate container_name "shared"/,
    );
  });

  it("can resolve @service:<slug>:<path> against installed services outside the rendered subset", () => {
    const pelias = svc("pelias", {});
    const placeholder = svc("pelias-placeholder", {
      bindMounts: [{ source: "@service:pelias:config/pelias.json", target: "/code/pelias.json" }],
    });
    const result = renderCompose([placeholder], {
      domain: "example.com",
      composeOutDir: "/repo/infra/docker",
      allServices: [pelias, placeholder],
    });
    expect(result.composeYaml).toContain(
      "../../services/pelias/config/pelias.json:/code/pelias.json:ro",
    );
    expect(result.composeYaml).not.toContain("pelias:\n");
  });

  describe("multi-instance produces / consumes", () => {
    it("matches a default-instance producer to a no-instance consumer", () => {
      const producer = svc("data", {
        produces: [{ type: "osm-pbf", sourceDir: "data/osm" }],
      });
      const consumer = svc("valhalla", {
        consumes: [{ type: "osm-pbf", mountAt: "/custom_files", required: true }],
      });
      const result = renderCompose([producer, consumer], { domain: "example.com" });
      expect(result.hardlinkPlan).toEqual([
        {
          source: "data/osm",
          target: "data/valhalla/osm-pbf",
          consumerService: "valhalla",
          dataType: "osm-pbf",
        },
      ]);
      expect(result.composeYaml).toContain("./data/valhalla/osm-pbf:/custom_files");
    });

    it("matches a (type, instance)-keyed consumer to the corresponding producer instance", () => {
      const producer = svc("data", {
        produces: [
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/europe" },
          { type: "osm-pbf", instance: "north-america", sourceDir: "data/osm/north-america" },
        ],
      });
      const valhallaEu = svc("valhalla-eu", {
        consumes: [
          { type: "osm-pbf", instance: "europe", mountAt: "/custom_files", required: true },
        ],
      });
      const valhallaNa = svc("valhalla-na", {
        consumes: [
          {
            type: "osm-pbf",
            instance: "north-america",
            mountAt: "/custom_files",
            required: true,
          },
        ],
      });
      const result = renderCompose([producer, valhallaEu, valhallaNa], {
        domain: "example.com",
      });
      const targets = result.hardlinkPlan.map((e) => ({
        source: e.source,
        target: e.target,
        instance: e.instance,
      }));
      expect(targets).toEqual([
        {
          source: "data/osm/europe",
          target: "data/valhalla-eu/osm-pbf/europe",
          instance: "europe",
        },
        {
          source: "data/osm/north-america",
          target: "data/valhalla-na/osm-pbf/north-america",
          instance: "north-america",
        },
      ]);
      expect(result.composeYaml).toContain("./data/valhalla-eu/osm-pbf/europe:/custom_files");
      expect(result.composeYaml).toContain(
        "./data/valhalla-na/osm-pbf/north-america:/custom_files",
      );
    });

    it("falls back to the only instanced producer when consumer omits instance", () => {
      // Single instanced producer + consumer with no instance: implicit pick.
      const producer = svc("data", {
        produces: [{ type: "osm-pbf", instance: "europe", sourceDir: "data/osm/europe" }],
      });
      const consumer = svc("valhalla", {
        consumes: [{ type: "osm-pbf", mountAt: "/custom_files", required: true }],
      });
      const result = renderCompose([producer, consumer], { domain: "example.com" });
      expect(result.hardlinkPlan).toHaveLength(1);
      expect(result.hardlinkPlan[0]?.source).toBe("data/osm/europe");
      // The consumer didn't pick an instance, so its mount path stays at the
      // type-level dir (no instance subdir on the consumer side).
      expect(result.hardlinkPlan[0]?.target).toBe("data/valhalla/osm-pbf");
    });

    it("throws when consumer references a missing instance", () => {
      const producer = svc("data", {
        produces: [{ type: "osm-pbf", instance: "europe", sourceDir: "data/osm/europe" }],
      });
      const consumer = svc("valhalla", {
        consumes: [{ type: "osm-pbf", instance: "asia", mountAt: "/custom_files", required: true }],
      });
      expect(() => renderCompose([producer, consumer], { domain: "example.com" })).toThrow(
        /no producer with that instance/,
      );
    });

    it("throws when a required consumer has no producer", () => {
      const consumer = svc("valhalla", {
        consumes: [{ type: "osm-pbf", mountAt: "/custom_files", required: true }],
      });
      expect(() => renderCompose([consumer], { domain: "example.com" })).toThrow(
        /consumes required data type "osm-pbf" but no producer is installed/,
      );
    });

    it("throws on ambiguous resolution (multiple instances, consumer omits instance)", () => {
      const producer = svc("data", {
        produces: [
          { type: "osm-pbf", instance: "europe", sourceDir: "data/osm/europe" },
          { type: "osm-pbf", instance: "north-america", sourceDir: "data/osm/north-america" },
        ],
      });
      const consumer = svc("valhalla", {
        consumes: [{ type: "osm-pbf", mountAt: "/custom_files", required: true }],
      });
      expect(() => renderCompose([producer, consumer], { domain: "example.com" })).toThrow(
        /multiple producer instances/,
      );
    });

    it("throws on duplicate (type, instance) across producer services", () => {
      const a = svc("data-a", {
        produces: [{ type: "osm-pbf", instance: "europe", sourceDir: "a/europe" }],
      });
      const b = svc("data-b", {
        produces: [{ type: "osm-pbf", instance: "europe", sourceDir: "b/europe" }],
      });
      expect(() => renderCompose([a, b], { domain: "example.com" })).toThrow(
        /Multiple producers for/,
      );
    });

    it("surfaces optional-bindMount skip advisories on RenderResult.warnings", () => {
      const services = [
        svc("data-manager", {
          bindMounts: [
            {
              source: "@infra:secrets/transitous-feed-proxy.age",
              target: "/secrets/transitous-feed-proxy.age",
              readOnly: true,
              optional: true,
            },
          ],
        }),
      ];
      const result = renderCompose(services, {
        domain: "example.com",
        composeOutDir: "/repo/infra/docker",
        existsSync: () => false,
      });
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("skipping optional bind-mount");
      // The skipped mount must not appear in the compose YAML.
      expect(result.composeYaml).not.toContain("/secrets/transitous-feed-proxy.age");
    });

    it("omits the warnings field on RenderResult when nothing was skipped", () => {
      const services = [svc("alpha")];
      const result = renderCompose(services, { domain: "example.com" });
      expect(result.warnings).toBeUndefined();
    });

    it("silently skips a missing producer when consumer is required: false", () => {
      const consumer = svc("orphan", {
        consumes: [
          { type: "osm-pbf", instance: "asia", mountAt: "/custom_files", required: false },
        ],
      });
      // No producer, but required: false -> no plan entry, no mount, no throw.
      const result = renderCompose([consumer], { domain: "example.com" });
      expect(result.hardlinkPlan).toEqual([]);
      expect(result.composeYaml).not.toContain("/custom_files");
    });
  });
});

describe("renderServiceSnippet healthcheck", () => {
  it("renders an http healthcheck that works without curl and on IPv4-only servers", () => {
    const snippet = renderServiceSnippet(
      svc("alpha", {
        container: {
          image: "t/alpha",
          tag: "latest",
          expose: [8080],
          healthcheck: { type: "http", path: "/api/v1/health", port: 8080 },
        },
      }),
      {},
    );
    const test = (snippet.healthcheck as { test: string[] }).test;
    expect(test[0]).toBe("CMD-SHELL");
    const cmd = test[1];
    // IPv4 literal, not `localhost` — `localhost` resolves to `::1` first and is
    // refused by IPv4-only servers (e.g. MOTIS binds 0.0.0.0 = IPv4 only).
    expect(cmd).toContain("http://127.0.0.1:8080/api/v1/health");
    expect(cmd).not.toContain("localhost");
    // Falls back to wget when the image ships no curl (e.g. the MOTIS image).
    expect(cmd).toContain("wget");
  });
});
