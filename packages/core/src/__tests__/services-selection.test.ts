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

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: Docker Compose substitution syntax in literal strings
  it("builds app-api env from the applied set and env references, never from env values", () => {
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
      ],
      { EXISTING: "1" },
      ["INTEGRATION_PHOTOS_FLICKR_APIKEY", "SERVICE_VALHALLA_BUILD_ELEVATION", "UNRELATED"],
    );

    expect(env).toEqual({
      EXISTING: "1",
      OPENMAPX_APPLIED_SERVICES: "app-api,osrm,valhalla",
      // Compose resolves these from infra/docker/.env when the stack starts.
      INTEGRATION_PHOTOS_FLICKR_APIKEY: "${INTEGRATION_PHOTOS_FLICKR_APIKEY:-}",
      SERVICE_VALHALLA_BUILD_ELEVATION: "${SERVICE_VALHALLA_BUILD_ELEVATION:-}",
    });
  });

  it("points env-addressed backends at co-deployed services unless the host env names one", () => {
    const env = buildAppApiServiceEnv(
      [
        svc("app-api"),
        svc("overpass", { container: { image: "t/overpass", tag: "latest", expose: [80] } }),
        svc("nominatim", {
          container: { image: "t/nominatim", tag: "latest", expose: [8080] },
        }),
      ],
      {},
    );

    expect(env.OVERPASS_URL).toBe("${OVERPASS_URL:-http://overpass:80}");
    expect(env.NOMINATIM_URL).toBe("${NOMINATIM_URL:-http://nominatim:8080}");
    expect(env.MOTIS_URL).toBeUndefined();
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: Docker Compose substitution syntax in literal strings
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

  it("never selects the bundled traefik behind an operator-run proxy", () => {
    const services = [
      svc("traefik"),
      svc("app-web", { exposure: { proxy: { enabled: true, pathPrefix: "/" } } }),
    ];

    const selection = expandServiceSelection(services, ["traefik", "app-web"], {
      externalProxyNetwork: "proxy",
    });

    expect(selection.enabledIdsOrdered).toEqual(["app-web"]);
    expect(selection.missingIds).toEqual([]);
    expect(
      expandServiceSelection(services, ["app-web"], { externalProxyNetwork: null })
        .enabledIdsOrdered,
    ).toEqual(["traefik", "app-web"]);
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
