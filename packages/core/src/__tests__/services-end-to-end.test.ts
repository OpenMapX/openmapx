import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  expandServiceSelection,
  renderCompose,
  ServiceRegistry,
  validateServiceManifest,
} from "../services";

const repoRoot = join(__dirname, "..", "..", "..", "..");
const manifestsPresent = existsSync(join(repoRoot, "services", "postgis", "service.json"));

describe.skipIf(!manifestsPresent)(
  "end-to-end: built-in manifests render to a valid compose",
  () => {
    it("loads all services/ manifests without warnings", async () => {
      const warnings: string[] = [];
      const registry = new ServiceRegistry({ rootDir: repoRoot, warnings });
      await registry.load();

      expect(warnings).toEqual([]);
      expect(registry.list().length).toBeGreaterThan(10);
    });

    it("renders the full built-in set once every required producer exists", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const result = renderCompose(registry.enabled(), { domain: "example.com" });
      expect(result.hardlinkPlan).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "data/pelias/placeholder",
            target: "data/pelias-placeholder/pelias-placeholder-data",
            consumerService: "pelias-placeholder",
            dataType: "pelias-placeholder-data",
          }),
          expect.objectContaining({
            source: "data/pelias/whosonfirst",
            target: "data/pelias-pip/pelias-whosonfirst-data",
            consumerService: "pelias-pip",
            dataType: "pelias-whosonfirst-data",
          }),
        ]),
      );
    });

    it("publishes /api but denies the internal-only sub-prefix at the proxy", async () => {
      // These handlers are unauthenticated by design and are documented as
      // internal-only, so the bundled proxy must reject their public route.
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const result = renderCompose(registry.enabled(), { domain: "example.com" });
      expect(result.composeYaml).toContain("PathPrefix(`/api/internal`)");
      expect(result.composeYaml).toContain("internal-deny@file");
    });

    it("renders OSRM against a prepared osrm-graph product, not raw OSM PBFs", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const services = registry
        .list()
        .filter((service) => ["data-manager", "osrm"].includes(service.manifest.id));
      const result = renderCompose(services, {
        domain: "example.com",
        allServices: registry.list(),
      });
      const osrmPlanEntry = result.hardlinkPlan.find((entry) => entry.consumerService === "osrm");

      expect(osrmPlanEntry).toEqual(
        expect.objectContaining({
          source: "data/osrm-graph",
          target: "data/osrm/osrm-graph",
          dataType: "osrm-graph",
        }),
      );
      expect(result.composeYaml).toContain("./data/osrm/osrm-graph:/data:ro");
      expect(result.composeYaml).not.toContain("./data/osrm/osm-pbf:/data");
    });

    it("renders TileServer with MBTiles and fonts while styles stay in the web app", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const services = registry
        .list()
        .filter((service) => ["data-manager", "tileserver"].includes(service.manifest.id));
      const result = renderCompose(services, {
        domain: "example.com",
        allServices: registry.list(),
      });

      expect(result.hardlinkPlan).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "data/tile-mbtiles",
            target: "data/tileserver/tile-mbtiles",
            consumerService: "tileserver",
            dataType: "tile-mbtiles",
          }),
          expect.objectContaining({
            source: "data/tile-fonts",
            target: "data/tileserver/tile-fonts",
            consumerService: "tileserver",
            dataType: "tile-fonts",
          }),
        ]),
      );
      expect(result.composeYaml).toContain("./data/tileserver/tile-mbtiles:/data/mbtiles:ro");
      expect(result.composeYaml).toContain("./data/tileserver/tile-fonts:/data/fonts:ro");
      expect(result.composeYaml).not.toContain("tile-styles");
    });

    it("renders OTP against a prepared otp-graph product, not raw OSM or GTFS inputs", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const services = registry
        .list()
        .filter((service) => ["data-manager", "otp"].includes(service.manifest.id));
      const result = renderCompose(services, {
        domain: "example.com",
        allServices: registry.list(),
      });
      const otpPlanEntry = result.hardlinkPlan.find((entry) => entry.consumerService === "otp");

      expect(otpPlanEntry).toEqual(
        expect.objectContaining({
          source: "data/otp-graph",
          target: "data/otp/otp-graph",
          dataType: "otp-graph",
        }),
      );
      expect(result.composeYaml).toContain("./data/otp/otp-graph:/var/opentripplanner");
      expect(result.composeYaml).not.toContain("./data/otp/otp-graph:/var/opentripplanner:ro");
      expect(result.composeYaml).not.toContain("./data/otp/osm-pbf");
      expect(result.composeYaml).not.toContain("./data/otp/gtfs");
    });

    it("renders MOTIS as a pipeline-owned writable bind-mount, not a hardlinked product", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const services = registry
        .list()
        .filter((service) => ["data-manager", "motis"].includes(service.manifest.id));
      const result = renderCompose(services, {
        domain: "example.com",
        allServices: registry.list(),
        composeOutDir: "/repo/infra/docker",
      });

      // The MOTIS dataset is owned + atomically swapped by the data-manager
      // pipeline, so it's a plain writable bind-mount with NO producer/hardlink
      // indirection (the hardlink sentinel/prune model can't carry the
      // container-built import output the swap depends on).
      const motisPlanEntry = result.hardlinkPlan.find((entry) => entry.consumerService === "motis");
      expect(motisPlanEntry).toBeUndefined();

      // Writable (no `:ro`) — MOTIS imports in place + writes its compiled
      // timetable into the mounted dir.
      expect(result.composeYaml).toContain("./data/motis/live:/motis-data");
      expect(result.composeYaml).not.toContain("./data/motis/live:/motis-data:ro");
      // The deploy step pre-creates this writable data dir as the data-owning user.
      expect(result.writableBindDirs?.some((d) => d.endsWith("/data/motis/live"))).toBe(true);
      expect(result.composeYaml).not.toContain("./data/motis/osm-pbf");
      expect(result.composeYaml).not.toContain("./data/motis/gtfs");
    });

    it("renders Pelias with produced placeholder and PIP data plus explicit runtime dependencies", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const services = registry
        .list()
        .filter((service) =>
          ["data-manager", "elasticsearch", "pelias", "pelias-placeholder", "pelias-pip"].includes(
            service.manifest.id,
          ),
        );
      const result = renderCompose(services, {
        domain: "example.com",
        allServices: registry.list(),
      });

      expect(result.hardlinkPlan).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "data/pelias/placeholder",
            target: "data/pelias-placeholder/pelias-placeholder-data",
            consumerService: "pelias-placeholder",
            dataType: "pelias-placeholder-data",
          }),
          expect.objectContaining({
            source: "data/pelias/whosonfirst",
            target: "data/pelias-pip/pelias-whosonfirst-data",
            consumerService: "pelias-pip",
            dataType: "pelias-whosonfirst-data",
          }),
        ]),
      );
      expect(result.composeYaml).toContain(
        "./data/pelias-placeholder/pelias-placeholder-data:/data/placeholder:ro",
      );
      expect(result.composeYaml).toContain(
        "./data/pelias-pip/pelias-whosonfirst-data:/data/whosonfirst:ro",
      );
      expect(result.composeYaml).toContain("pelias-placeholder:");
      expect(result.composeYaml).toContain("pelias-pip:");
      expect(result.composeYaml).toContain(
        "pelias-placeholder:\n        condition: service_started",
      );
      expect(result.composeYaml).toContain("pelias-pip:\n        condition: service_started");
    });

    describe("managed Dawarich bundle", () => {
      it("selects the complete isolated topology without an app-to-worker runtime edge", async () => {
        const registry = new ServiceRegistry({ rootDir: repoRoot });
        await registry.load();

        const selection = expandServiceSelection(registry.list(), ["dawarich-app"]);
        expect(selection.missingIds).toEqual([]);
        expect(selection.warnings).toEqual([]);
        expect(selection.enabledIds).toEqual(
          new Set([
            "traefik",
            "dawarich-app",
            "dawarich-sidekiq",
            "dawarich-postgis",
            "dawarich-redis",
          ]),
        );

        const app = registry.get("dawarich-app")?.manifest;
        const worker = registry.get("dawarich-sidekiq")?.manifest;
        expect(registry.get("dawarich-redis")?.manifest.license).toBe("RSALv2 OR SSPL-1.0");
        expect(app?.version).toBe("1.10.3");
        expect(app?.container).toMatchObject({
          image: "freikin/dawarich",
          tag: "1.10.3",
          expose: [3000],
          entrypoint: ["/usr/local/bin/openmapx-entrypoint.sh"],
          command: ["bin/rails", "server", "-p", "3000", "-b", "::"],
          memory: "4g",
          restart: "unless-stopped",
          healthcheck: {
            type: "http",
            path: "/api/v1/health",
            port: 3000,
            interval: "10s",
            timeout: "10s",
            retries: 30,
            startPeriod: "30s",
          },
          logging: { driver: "json-file", options: { "max-size": "100m", "max-file": "5" } },
        });
        expect(app?.container.dependsOn).toEqual([
          { service: "dawarich-postgis", condition: "service_healthy" },
          { service: "dawarich-redis", condition: "service_healthy" },
        ]);
        expect(app?.selectionDependencies).toEqual(["dawarich-sidekiq"]);
        expect(app?.container.dependsOn?.map((dependency) => dependency.service)).not.toContain(
          "dawarich-sidekiq",
        );
        expect(worker?.container.dependsOn).toEqual([
          { service: "dawarich-postgis", condition: "service_healthy" },
          { service: "dawarich-redis", condition: "service_healthy" },
          { service: "dawarich-app", condition: "service_healthy" },
        ]);

        const appEnvironment = app?.container.environment;
        // biome-ignore-start lint/suspicious/noTemplateCurlyInString: literal Docker Compose interpolation syntax
        expect(appEnvironment).toMatchObject({
          RAILS_ENV: "production",
          REDIS_URL: "redis://dawarich-redis:6379",
          DATABASE_HOST: "dawarich-postgis",
          DATABASE_PORT: "5432",
          DATABASE_USERNAME: "postgres",
          DATABASE_NAME: "dawarich_production",
          APPLICATION_HOSTS: "timeline.${DOMAIN:-localhost}",
          APPLICATION_PROTOCOL: "https",
          RAILS_LOG_TO_STDOUT: "true",
          SELF_HOSTED: "true",
          STORE_GEODATA: "true",
          WEB_CONCURRENCY: "1",
          OIDC_AUTO_REGISTER: "true",
          OIDC_PROVIDER_NAME: "OpenMapX",
          OIDC_PKCE_ENABLED: "true",
          OIDC_ISSUER: "https://${DOMAIN:-localhost}/api/auth",
          OIDC_REDIRECT_URI:
            "https://timeline.${DOMAIN:-localhost}/users/auth/openid_connect/callback",
          ALLOW_EMAIL_PASSWORD_REGISTRATION: "true",
        });
        // biome-ignore-end lint/suspicious/noTemplateCurlyInString: literal Docker Compose interpolation syntax
        for (const key of ["DATABASE_PASSWORD", "SECRET_KEY_BASE", "OIDC_CLIENT_SECRET"]) {
          expect(appEnvironment).not.toHaveProperty(key);
        }
        const appConfig = (app?.configSchema?.properties ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        for (const key of [
          "APPLICATION_HOSTS",
          "APPLICATION_URL",
          "DOMAIN",
          "APPLICATION_PROTOCOL",
          "TIME_ZONE",
          "REDIS_URL",
          "DATABASE_HOST",
          "DATABASE_PORT",
          "DATABASE_USERNAME",
          "DATABASE_NAME",
          "OIDC_CLIENT_ID",
          "OIDC_ISSUER",
          "OIDC_REDIRECT_URI",
          "OIDC_PROVIDER_NAME",
          "OIDC_AUTO_REGISTER",
          "OIDC_PKCE_ENABLED",
          "WEB_CONCURRENCY",
          "RAILS_MAX_THREADS",
          "LOG_MAX_SIZE",
          "LOG_MAX_FILE",
        ]) {
          expect(appConfig[key]?.type, key).toBe("string");
          expect(appConfig[key]?.["x-openmapx-secret"], key).not.toBe(true);
        }
        for (const key of ["DATABASE_PASSWORD", "SECRET_KEY_BASE", "OIDC_CLIENT_SECRET"]) {
          expect(appConfig[key]?.["x-openmapx-secret"], key).toBe(true);
        }
        const postgisConfig = (registry.get("dawarich-postgis")?.manifest.configSchema
          ?.properties ?? {}) as Record<string, Record<string, unknown>>;
        expect(postgisConfig.POSTGRES_USER?.type).toBe("string");
        expect(postgisConfig.POSTGRES_DB?.type).toBe("string");
        expect(app?.bindMounts).toEqual([
          {
            source: "scripts/openmapx-entrypoint.sh",
            target: "/usr/local/bin/openmapx-entrypoint.sh",
            readOnly: true,
          },
        ]);
        expect(app?.volumes).toEqual([
          {
            name: "openmapx-dawarich-public",
            mountAt: "/var/app/public",
            backup: true,
            backupMode: "tar",
          },
          {
            name: "openmapx-dawarich-watched",
            mountAt: "/var/app/tmp/imports/watched",
            backup: true,
            backupMode: "tar",
          },
          {
            name: "openmapx-dawarich-storage",
            mountAt: "/var/app/storage",
            backup: true,
            backupMode: "tar",
          },
        ]);

        expect(worker?.version).toBe("1.10.3");
        expect(worker?.container).toMatchObject({
          image: "freikin/dawarich",
          tag: "1.10.3",
          entrypoint: ["/usr/local/bin/openmapx-entrypoint.sh"],
          command: ["sidekiq"],
          memory: "2g",
          restart: "unless-stopped",
          healthcheck: {
            type: "exec",
            command: ["pgrep", "-f", "sidekiq"],
            interval: "10s",
            timeout: "10s",
            retries: 30,
            startPeriod: "30s",
          },
        });
        expect(worker?.container.environment).toMatchObject({
          ...appEnvironment,
          BACKGROUND_PROCESSING_CONCURRENCY: "3",
        });
        expect(worker?.bindMounts).toEqual([
          {
            source: "scripts/openmapx-entrypoint.sh",
            target: "/usr/local/bin/openmapx-entrypoint.sh",
            readOnly: true,
          },
        ]);
        expect(worker?.volumes).toEqual(
          app?.volumes?.map((volume) => ({ ...volume, backup: false, backupMode: undefined })),
        );
      });

      it("renders the pinned private data services, shared app data, file-only secrets and host-only TLS route", async () => {
        const registry = new ServiceRegistry({ rootDir: repoRoot });
        await registry.load();
        const selection = expandServiceSelection(registry.list(), ["dawarich-app"]);
        registry.applyEnabledIds(selection.enabledIds);

        const secretKeys = ["DATABASE_PASSWORD", "SECRET_KEY_BASE", "OIDC_CLIENT_SECRET"];
        const { composeYaml } = renderCompose(registry.enabled(), {
          domain: "example.test",
          allServices: registry.list(),
          serviceSecretKeys: new Map([
            ["dawarich-postgis", ["POSTGRES_PASSWORD"]],
            ["dawarich-app", secretKeys],
            ["dawarich-sidekiq", secretKeys],
          ]),
        });
        const compose = parseYaml(composeYaml) as {
          services: Record<
            string,
            {
              image: string;
              ports?: string[];
              volumes?: string[];
              environment?: Record<string, string>;
              secrets?: Array<{ source: string; target: string }>;
              labels?: Record<string, string>;
              depends_on?: Record<string, { condition: string }>;
            }
          >;
          volumes: Record<string, null>;
        };

        expect(Object.keys(compose.services).sort()).toEqual([
          "dawarich-app",
          "dawarich-postgis",
          "dawarich-redis",
          "dawarich-sidekiq",
          "traefik",
        ]);
        expect(compose.services["dawarich-postgis"]?.image).toBe(
          "ghcr.io/baosystems/postgis:17-3.5",
        );
        expect(compose.services["dawarich-redis"]?.image).toBe("redis:7.4-alpine");
        expect(compose.services["dawarich-app"]?.image).toBe("freikin/dawarich:1.10.3");
        expect(compose.services["dawarich-sidekiq"]?.image).toBe("freikin/dawarich:1.10.3");
        expect(compose.services["dawarich-postgis"]?.ports).toBeUndefined();
        expect(compose.services["dawarich-redis"]?.ports).toBeUndefined();
        expect(compose.services["dawarich-app"]?.depends_on).not.toHaveProperty("dawarich-sidekiq");

        const appVolumes = compose.services["dawarich-app"]?.volumes ?? [];
        const workerVolumes = compose.services["dawarich-sidekiq"]?.volumes ?? [];
        expect(appVolumes).toEqual(
          expect.arrayContaining([
            "openmapx-dawarich-public:/var/app/public",
            "openmapx-dawarich-watched:/var/app/tmp/imports/watched",
            "openmapx-dawarich-storage:/var/app/storage",
          ]),
        );
        expect(workerVolumes).toEqual(
          expect.arrayContaining([
            "openmapx-dawarich-public:/var/app/public",
            "openmapx-dawarich-watched:/var/app/tmp/imports/watched",
            "openmapx-dawarich-storage:/var/app/storage",
          ]),
        );
        expect(appVolumes.join("\n")).not.toContain("openmapx-dawarich-db-data");
        expect(Object.keys(compose.volumes).sort()).toEqual([
          "openmapx-dawarich-db-data",
          "openmapx-dawarich-public",
          "openmapx-dawarich-redis-data",
          "openmapx-dawarich-storage",
          "openmapx-dawarich-watched",
          "openmapx-traefik-acme",
        ]);
        expect(Object.keys(compose.volumes)).not.toContain("openmapx-pgdata");
        expect(Object.keys(compose.volumes)).not.toContain("openmapx-redisdata");

        for (const serviceId of ["dawarich-app", "dawarich-sidekiq"]) {
          const service = compose.services[serviceId];
          expect(service?.environment?.DATABASE_HOST).toBe("dawarich-postgis");
          expect(service?.environment?.DATABASE_NAME).toBe("dawarich_production");
          expect(service?.environment?.OIDC_CLIENT_ID).toBeDefined();
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Docker Compose interpolation syntax
          expect(service?.environment?.OIDC_ISSUER).toBe("https://${DOMAIN:-localhost}/api/auth");
          expect(service?.environment?.DATABASE_PASSWORD).toBeUndefined();
          expect(service?.environment?.SECRET_KEY_BASE).toBeUndefined();
          expect(service?.environment?.OIDC_CLIENT_SECRET).toBeUndefined();
          expect(service?.secrets).toEqual(
            secretKeys.map((target) => ({ source: `${serviceId}__${target}`, target })),
          );
        }
        expect(
          compose.services["dawarich-postgis"]?.environment?.POSTGRES_PASSWORD,
        ).toBeUndefined();
        expect(compose.services["dawarich-postgis"]?.secrets).toEqual([
          { source: "dawarich-postgis__POSTGRES_PASSWORD", target: "POSTGRES_PASSWORD" },
        ]);
        expect(composeYaml).not.toContain("password:-");
        expect(composeYaml).not.toContain("CHANGE_ME");

        const labels = compose.services["dawarich-app"]?.labels;
        expect(labels?.["traefik.http.routers.dawarich-app.rule"]).toBe(
          "Host(`timeline.example.test`)",
        );
        expect(labels?.["traefik.http.routers.dawarich-app.entrypoints"]).toBe("websecure");
        expect(labels?.["traefik.http.routers.dawarich-app.tls.certresolver"]).toBe("letsencrypt");
        expect(labels?.["traefik.http.services.dawarich-app.loadbalancer.server.port"]).toBe(
          "3000",
        );
        expect(composeYaml).not.toContain("PathPrefix(`/dawarich-app`)");
      });
    });

    describe("first-party manifest provenance", () => {
      const builtInManifestPaths = readdirSync(join(repoRoot, "services"), {
        withFileTypes: true,
      })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
        .map((e) => join(repoRoot, "services", e.name, "service.json"))
        .filter((p) => existsSync(p));

      it("finds every shipped service manifest", () => {
        expect(builtInManifestPaths.length).toBeGreaterThanOrEqual(20);
      });

      it("validates every shipped manifest under first-party provenance", () => {
        for (const path of builtInManifestPaths) {
          const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
          const result = validateServiceManifest(raw, { firstParty: true });
          expect(result.valid, `${path}: ${result.errors.join("; ")}`).toBe(true);
        }
      });

      it("declares an explicit mode for every first-party backup volume", () => {
        for (const path of builtInManifestPaths) {
          const raw = JSON.parse(readFileSync(path, "utf-8")) as {
            volumes?: Array<{ name: string; backup?: boolean; backupMode?: unknown }>;
          };
          for (const volume of raw.volumes ?? []) {
            if (volume.backup === true) {
              expect(volume.backupMode, `${path}: ${volume.name}`).toMatch(/^(tar|pg_dump)$/);
            }
          }
        }
      });

      it("rejects every shipped manifest when it arrives without first-party provenance", () => {
        for (const path of builtInManifestPaths) {
          const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
          const result = validateServiceManifest(raw, { firstParty: false });
          expect(result.valid, `${path} was accepted as a community manifest`).toBe(false);
        }
      });
    });
  },
);
