import { describe, expect, it } from "vitest";
import { renderServiceSnippet } from "../services/compose-renderer";
import { DEFAULT_SELECTED_SERVICE_IDS } from "../services/core-service-ids";
import {
  buildApiServiceEnv,
  expandServiceSelection,
  formatServiceIdList,
  normalizeServiceIds,
  parseServiceIdList,
} from "../services/selection";
import type { LoadedService } from "../services/types";
import { itemAt } from "../utils/itemAt";

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
    expect(normalizeServiceIds([" api, web ", "redis\npostgis", "redis"])).toEqual([
      "api",
      "web",
      "redis",
      "postgis",
    ]);
    expect(parseServiceIdList(undefined)).toBeNull();
    expect(parseServiceIdList("api web")).toEqual(["api", "web"]);
    expect(formatServiceIdList(["api", "web"])).toBe("api,web");
  });

  it("defines a small core default selection", () => {
    expect(DEFAULT_SELECTED_SERVICE_IDS).toEqual([
      "traefik",
      "well-known",
      "api",
      "web",
      "postgis",
      "redis",
      "data-manager",
    ]);
  });

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: Docker Compose substitution syntax in literal strings
  it("builds the API's env from the applied set and env references, never from env values", () => {
    const env = buildApiServiceEnv(
      [
        svc("api", {
          container: { image: "t/api", tag: "latest", expose: [3001] },
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
      OPENMAPX_APPLIED_SERVICES: "api,osrm,valhalla",
      // Compose resolves these from infra/docker/.env when the stack starts.
      INTEGRATION_PHOTOS_FLICKR_APIKEY: "${INTEGRATION_PHOTOS_FLICKR_APIKEY:-}",
      SERVICE_VALHALLA_BUILD_ELEVATION: "${SERVICE_VALHALLA_BUILD_ELEVATION:-}",
    });
  });

  it("points env-addressed backends at co-deployed services unless the host env names one", () => {
    const env = buildApiServiceEnv(
      [
        svc("api"),
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
    const primary = itemAt(services, 0);
    expect(primary.manifest.container.dependsOn).toBeUndefined();
    expect(renderServiceSnippet(primary, {}).depends_on).toBeUndefined();
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
      svc("api", {
        container: {
          image: "t/api",
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

    const selection = expandServiceSelection(services, ["api", "valhalla"]);

    expect(selection.missingIds).toEqual([]);
    expect(selection.enabledIdsOrdered).toEqual([
      "traefik",
      "postgis",
      "redis",
      "api",
      "data-manager",
      "valhalla",
    ]);
  });

  it("never selects the bundled traefik behind an operator-run proxy", () => {
    const services = [
      svc("traefik"),
      svc("web", { exposure: { proxy: { enabled: true, pathPrefix: "/" } } }),
    ];

    const selection = expandServiceSelection(services, ["traefik", "web"], {
      externalProxyNetwork: "proxy",
    });

    expect(selection.enabledIdsOrdered).toEqual(["web"]);
    expect(selection.missingIds).toEqual([]);
    expect(
      expandServiceSelection(services, ["web"], { externalProxyNetwork: null }).enabledIdsOrdered,
    ).toEqual(["traefik", "web"]);
  });

  it("reports explicit missing roots but tolerates missing defaults when requested", () => {
    const services = [svc("api")];

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

describe("producer selection", () => {
  it("adds the first of two default producers, as dependency ordering does", () => {
    const consumer = svc("router", { consumes: [{ type: "osm-pbf", mountAt: "/osm" }] });
    const first = svc("first", { produces: [{ type: "osm-pbf", sourceDir: "data/first" }] });
    const second = svc("second", { produces: [{ type: "osm-pbf", sourceDir: "data/second" }] });

    const selection = expandServiceSelection([consumer, first, second], ["router"]);

    expect(selection.enabledIds).toContain("first");
    expect(selection.enabledIds).not.toContain("second");
  });

  it("warns when several producer instances leave the consumer without a choice", () => {
    const consumer = svc("router", { consumes: [{ type: "osm-pbf", mountAt: "/osm" }] });
    const europe = svc("europe", {
      produces: [{ type: "osm-pbf", instance: "europe", sourceDir: "data/europe" }],
    });
    const asia = svc("asia", {
      produces: [{ type: "osm-pbf", instance: "asia", sourceDir: "data/asia" }],
    });

    const selection = expandServiceSelection([consumer, europe, asia], ["router"]);

    expect(selection.warnings).toEqual([
      'Service "router" consumes required data type "osm-pbf" but no unique producer is installed',
    ]);
  });
});
