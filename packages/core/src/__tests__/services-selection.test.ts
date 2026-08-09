import { describe, expect, it } from "vitest";
import { renderServiceSnippet } from "../services/compose-renderer";
import {
  buildAppApiServiceEnv,
  DEFAULT_SELECTED_SERVICE_IDS,
  expandServiceSelection,
  formatServiceIdList,
  normalizeServiceIds,
  parseServiceIdList,
} from "../services/selection";
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

describe("service selection helpers", () => {
  it("normalizes comma and whitespace separated ids", () => {
    expect(normalizeServiceIds([" app-api, app-web ", "redis\npostgis", "redis"])).toEqual([
      "app-api",
      "app-web",
      "redis",
      "postgis",
    ]);
    expect(parseServiceIdList(undefined)).toBeNull();
    expect(parseServiceIdList("app-api app-web")).toEqual(["app-api", "app-web"]);
    expect(formatServiceIdList(["app-api", "app-web"])).toBe("app-api,app-web");
  });

  it("defines a small core default selection", () => {
    expect(DEFAULT_SELECTED_SERVICE_IDS).toEqual([
      "traefik",
      "well-known",
      "app-api",
      "app-web",
      "postgis",
      "redis",
      "data-manager",
    ]);
  });

  it("builds app-api env with selection + integration/service env passthrough", () => {
    const env = buildAppApiServiceEnv(
      [
        svc("app-api", {
          container: { image: "t/app-api", tag: "latest", expose: [3001] },
        }),
        svc("osrm", {
          container: { image: "t/osrm", tag: "latest", expose: [5000] },
        }),
        svc("valhalla", {
          container: { image: "t/valhalla", tag: "latest", expose: [8002] },
        }),
        svc("overpass", {
          container: { image: "t/overpass", tag: "latest", expose: [80] },
        }),
      ],
      { EXISTING: "1" },
      {
        OSRM_URL: "https://router.example",
        INTEGRATION_PHOTOS_FLICKR_APIKEY: "flickr-key",
        SERVICE_VALHALLA_BUILD_ELEVATION: "false",
      },
    );

    expect(env).toEqual({
      EXISTING: "1",
      OPENMAPX_ENABLED_SERVICES: "app-api,osrm,valhalla,overpass",
      // overpass is enabled and no host OVERPASS_URL set → internal URL injected
      OVERPASS_URL: "http://overpass:80",
      // INTEGRATION_*/SERVICE_* values are emitted as Docker Compose
      // substitution placeholders so the actual secret/config value is
      // resolved from infra/docker/.env at compose-up time and never
      // baked into the rendered YAML.
      // biome-ignore-start lint/suspicious/noTemplateCurlyInString: Docker Compose substitution syntax in literal strings
      INTEGRATION_PHOTOS_FLICKR_APIKEY: "${INTEGRATION_PHOTOS_FLICKR_APIKEY:-}",
      SERVICE_VALHALLA_BUILD_ELEVATION: "${SERVICE_VALHALLA_BUILD_ELEVATION:-}",
      // biome-ignore-end lint/suspicious/noTemplateCurlyInString: Docker Compose substitution syntax in literal strings
    });
  });

  it("injects internal Docker-network URLs for env-var-driven backends when co-deployed", () => {
    // Both overpass and nominatim enabled, no host overrides
    const env = buildAppApiServiceEnv(
      [
        svc("app-api"),
        svc("overpass", { container: { image: "t/overpass", tag: "latest", expose: [80] } }),
        svc("nominatim", {
          container: { image: "t/nominatim", tag: "latest", expose: [8080] },
        }),
      ],
      {},
      {},
    );

    expect(env.OVERPASS_URL).toBe("http://overpass:80");
    expect(env.NOMINATIM_URL).toBe("http://nominatim:8080");
  });

  it("host-env OVERPASS_URL and NOMINATIM_URL override the injected internal URLs", () => {
    const env = buildAppApiServiceEnv(
      [
        svc("app-api"),
        svc("overpass", { container: { image: "t/overpass", tag: "latest", expose: [80] } }),
        svc("nominatim", {
          container: { image: "t/nominatim", tag: "latest", expose: [8080] },
        }),
      ],
      {},
      {
        OVERPASS_URL: "https://my-overpass.example.com",
        NOMINATIM_URL: "https://my-nominatim.example.com",
      },
    );

    // Explicit host overrides must win over the injected internal addresses
    expect(env.OVERPASS_URL).toBeUndefined(); // not injected because hostEnv has it
    expect(env.NOMINATIM_URL).toBeUndefined(); // not injected because hostEnv has it
    // The host env values themselves are NOT forwarded unless they match the
    // passthrough prefix pattern (INTEGRATION_* / SERVICE_*), so they must be
    // set in the compose file's existing env or the manifest's ${VAR:-default}.
  });
});

describe("expandServiceSelection", () => {
  it("selects direct and transitive companions without introducing runtime dependencies", () => {
    const services = [
      svc("primary", { selectionDependencies: ["worker"] } as never),
      svc("worker", { selectionDependencies: ["scheduler"] } as never),
      svc("scheduler"),
    ];

    const selection = expandServiceSelection(services, ["primary"]);

    expect(selection.enabledIdsOrdered).toEqual(["primary", "worker", "scheduler"]);
    expect(selection.warnings).toEqual([]);
    expect(services[0]?.manifest.container.dependsOn).toBeUndefined();
    expect(renderServiceSnippet(services[0] as LoadedService, {}).depends_on).toBeUndefined();
  });

  it("warns for unavailable companions and terminates mutual companion cycles", () => {
    const services = [
      svc("alpha", { selectionDependencies: ["beta", "missing"] } as never),
      svc("beta", { selectionDependencies: ["alpha"] } as never),
    ];

    const selection = expandServiceSelection(services, ["alpha"]);

    expect(selection.enabledIdsOrdered).toEqual(["alpha", "beta"]);
    expect(selection.warnings).toEqual([
      'Service "missing" referenced by selectionDependencies of "alpha" is not installed',
    ]);
  });

  it("adds container dependencies, proxied traefik, and unique data producers", () => {
    const services = [
      svc("traefik"),
      svc("postgis"),
      svc("redis"),
      svc("app-api", {
        container: {
          image: "t/app-api",
          tag: "latest",
          expose: [3001],
          dependsOn: [
            { service: "postgis", condition: "service_healthy" },
            { service: "redis", condition: "service_healthy" },
          ],
        },
        exposure: { proxy: { enabled: true, pathPrefix: "/api" } },
      }),
      svc("data-manager", {
        produces: [{ type: "osm-pbf", sourceDir: "data/osm" }],
      }),
      svc("valhalla", {
        consumes: [{ type: "osm-pbf", mountAt: "/custom_files", required: true }],
      }),
    ];

    const selection = expandServiceSelection(services, ["app-api", "valhalla"]);

    expect(selection.missingIds).toEqual([]);
    expect(selection.enabledIdsOrdered).toEqual([
      "traefik",
      "postgis",
      "redis",
      "app-api",
      "data-manager",
      "valhalla",
    ]);
  });

  it("reports explicit missing roots but tolerates missing defaults when requested", () => {
    const services = [svc("app-api")];

    expect(expandServiceSelection(services, ["nope"]).missingIds).toEqual(["nope"]);
    expect(
      expandServiceSelection(services, ["nope"], { allowMissingSelected: true }).missingIds,
    ).toEqual([]);
  });

  it("warns when a selected service has no unique required producer", () => {
    const selection = expandServiceSelection(
      [
        svc("one", { produces: [{ type: "osm-pbf", instance: "one", sourceDir: "one" }] }),
        svc("two", { produces: [{ type: "osm-pbf", instance: "two", sourceDir: "two" }] }),
        svc("consumer", {
          consumes: [{ type: "osm-pbf", mountAt: "/data", required: true }],
        }),
      ],
      ["consumer"],
    );

    expect(selection.enabledIdsOrdered).toEqual(["consumer"]);
    expect(selection.warnings).toEqual([
      'Service "consumer" consumes required data type "osm-pbf" but no unique producer is installed',
    ]);
  });

  it("selecting pelias expands to elasticsearch, placeholder, pip, and data-manager", () => {
    const selection = expandServiceSelection(
      [
        svc("data-manager", {
          produces: [
            { type: "pelias-placeholder-data", sourceDir: "data/pelias/placeholder" },
            { type: "pelias-whosonfirst-data", sourceDir: "data/pelias/whosonfirst" },
          ],
        }),
        svc("elasticsearch"),
        svc("pelias", {
          container: {
            image: "pelias/api",
            tag: "latest",
            expose: [4000],
            dependsOn: [
              { service: "elasticsearch", condition: "service_healthy" },
              { service: "pelias-placeholder", condition: "service_started" },
              { service: "pelias-pip", condition: "service_started" },
            ],
          },
        }),
        svc("pelias-placeholder", {
          consumes: [
            { type: "pelias-placeholder-data", mountAt: "/data/placeholder", required: true },
          ],
        }),
        svc("pelias-pip", {
          consumes: [
            { type: "pelias-whosonfirst-data", mountAt: "/data/whosonfirst", required: true },
          ],
        }),
      ],
      ["pelias"],
    );

    expect(selection.missingIds).toEqual([]);
    expect(selection.warnings).toEqual([]);
    expect(selection.enabledIdsOrdered).toEqual([
      "data-manager",
      "elasticsearch",
      "pelias",
      "pelias-placeholder",
      "pelias-pip",
    ]);
  });
});
