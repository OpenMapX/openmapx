import { describe, expect, it } from "vitest";
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

  it("builds app-api env from the enabled local service set", () => {
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
      INTEGRATION_PHOTOS_FLICKR_APIKEY: "flickr-key",
      SERVICE_VALHALLA_BUILD_ELEVATION: "false",
      VALHALLA_URL: "http://valhalla:8002",
      OVERPASS_URL: "http://overpass:80",
    });
  });
});

describe("expandServiceSelection", () => {
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
