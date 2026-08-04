import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCompose, ServiceRegistry, validateServiceManifest } from "../services";

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
