import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCompose, ServiceRegistry } from "../services";

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

    it("renders OSRM against a prepared osrm-graph product, not raw OSM PBFs", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const services = registry
        .list()
        .filter((service) => ["data-manager", "osrm"].includes(service.manifest.id));
      const result = renderCompose(services, { domain: "example.com" });
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

    it("renders TileServer with MBTiles, fonts, and styles data products", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const services = registry
        .list()
        .filter((service) => ["data-manager", "tileserver"].includes(service.manifest.id));
      const result = renderCompose(services, { domain: "example.com" });

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
          expect.objectContaining({
            source: "data/tile-styles",
            target: "data/tileserver/tile-styles",
            consumerService: "tileserver",
            dataType: "tile-styles",
          }),
        ]),
      );
      expect(result.composeYaml).toContain("./data/tileserver/tile-mbtiles:/data/mbtiles:ro");
      expect(result.composeYaml).toContain("./data/tileserver/tile-fonts:/data/fonts:ro");
      expect(result.composeYaml).toContain("./data/tileserver/tile-styles:/data/styles:ro");
    });

    it("renders OTP against a prepared otp-graph product, not raw OSM or GTFS inputs", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const services = registry
        .list()
        .filter((service) => ["data-manager", "otp"].includes(service.manifest.id));
      const result = renderCompose(services, { domain: "example.com" });
      const otpPlanEntry = result.hardlinkPlan.find((entry) => entry.consumerService === "otp");

      expect(otpPlanEntry).toEqual(
        expect.objectContaining({
          source: "data/otp-graph",
          target: "data/otp/otp-graph",
          dataType: "otp-graph",
        }),
      );
      expect(result.composeYaml).toContain("./data/otp/otp-graph:/var/opentripplanner:ro");
      expect(result.composeYaml).not.toContain("./data/otp/osm-pbf");
      expect(result.composeYaml).not.toContain("./data/otp/gtfs");
    });

    it("renders MOTIS against a prepared motis-data product, not raw OSM or GTFS mounts", async () => {
      const registry = new ServiceRegistry({ rootDir: repoRoot });
      await registry.load();

      const services = registry
        .list()
        .filter((service) => ["data-manager", "motis"].includes(service.manifest.id));
      const result = renderCompose(services, { domain: "example.com" });
      const motisPlanEntry = result.hardlinkPlan.find((entry) => entry.consumerService === "motis");

      expect(motisPlanEntry).toEqual(
        expect.objectContaining({
          source: "data/motis-data",
          target: "data/motis/motis-data",
          dataType: "motis-data",
        }),
      );
      expect(result.composeYaml).toContain("./data/motis/motis-data:/motis-data");
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
      const result = renderCompose(services, { domain: "example.com" });

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
  },
);
