import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as genMotisConfigRun } from "../../src/jobs/transitous/gen-motis-config.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;
const ENV_KEYS = [
  "MOTIS_INCREMENTAL_RT_UPDATE",
  "MOTIS_ELEVATORS_URL",
  "MOTIS_ELEVATORS_AUTH",
  "MOTIS_OSR_FOOTPATH",
  "MOTIS_ROUTE_SHAPES",
  "MOTIS_TILES",
  "MOTIS_REGION",
  "OPENMAPX_REGION",
] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function setupCatalog(initialConfigYaml: string): {
  dataDir: string;
  catalogDir: string;
  configPath: string;
} {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-gen-motis-config-"));
  const catalogDir = join(tmp, ".transitous-catalog");
  const outDir = join(catalogDir, "out");
  mkdirSync(join(catalogDir, "src"), { recursive: true });
  mkdirSync(outDir, { recursive: true });
  // The stage looks for `src/generate-motis-config.py` to decide whether to
  // run. The runner is a stub, so the file body doesn't matter.
  writeFileSync(join(catalogDir, "src", "generate-motis-config.py"), "");
  const configPath = join(outDir, "config.yml");
  writeFileSync(configPath, initialConfigYaml, "utf-8");
  return { dataDir: tmp, catalogDir, configPath };
}

function ctxFor(dataDir: string, catalogDir: string) {
  const ctx = buildJobContext({
    dataDir,
    store: new StateStore(dataDir),
    runner: async () => {
      /* stub: the stage already wrote config.yml in our test setup */
    },
    now: () => "2026-05-01T00:00:00.000Z",
  });
  // The stage reads `state.catalogDir` first; fall back wires to ctx.catalogDir.
  ctx.state.catalogDir = catalogDir;
  return ctx;
}

const TEMPLATE = `server:
  port: 8080
osr_footpath: false
elevators: false
timetable:
  update_interval: 60
  incremental_rt_update: false
  datasets:
    foo:
      path: foo.gtfs.zip
`;

const TEMPLATE_WITH_OSM = `server:
  port: 8080
street_routing: true
osm: planet-latest.osm.pbf
timetable:
  datasets:
    foo:
      path: foo.gtfs.zip
`;

describe("gen-motis-config incremental_rt_update override", () => {
  it("flips the flag to true when MOTIS_INCREMENTAL_RT_UPDATE=true", async () => {
    process.env.MOTIS_INCREMENTAL_RT_UPDATE = "true";
    const fx = setupCatalog(TEMPLATE);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ incrementalRtOverridden: true });
    const updated = readFileSync(fx.configPath, "utf-8");
    expect(updated).toMatch(/incremental_rt_update:\s*true/);
  });

  it("leaves the flag alone when the env var is unset", async () => {
    delete process.env.MOTIS_INCREMENTAL_RT_UPDATE;
    const fx = setupCatalog(TEMPLATE);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ incrementalRtOverridden: false });
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/incremental_rt_update:\s*false/);
  });

  it("is a no-op when the desired value already matches", async () => {
    process.env.MOTIS_INCREMENTAL_RT_UPDATE = "false";
    const fx = setupCatalog(TEMPLATE);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.artifacts).toMatchObject({ incrementalRtOverridden: false });
  });

  it("accepts truthy aliases (1, yes, on)", async () => {
    for (const value of ["1", "yes", "on"]) {
      process.env.MOTIS_INCREMENTAL_RT_UPDATE = value;
      const fx = setupCatalog(TEMPLATE);
      const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
      expect(result.artifacts).toMatchObject({ incrementalRtOverridden: true });
      rmSync(fx.dataDir, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("ignores unparseable env values without throwing", async () => {
    process.env.MOTIS_INCREMENTAL_RT_UPDATE = "maybe";
    const fx = setupCatalog(TEMPLATE);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ incrementalRtOverridden: false });
  });
});

describe("gen-motis-config elevators override", () => {
  it("injects an elevators block (with auth header) when MOTIS_ELEVATORS_URL is set", async () => {
    process.env.MOTIS_ELEVATORS_URL = "https://fasta.example/api";
    process.env.MOTIS_ELEVATORS_AUTH = "Bearer secret";
    const fx = setupCatalog(TEMPLATE);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ elevatorsOverridden: true });
    const updated = readFileSync(fx.configPath, "utf-8");
    expect(updated).toMatch(/elevators:\n {2}url: https:\/\/fasta\.example\/api/);
    expect(updated).toMatch(/headers:\n {4}Authorization: Bearer secret/);
    // Other top-level keys remain intact.
    expect(updated).toMatch(/^timetable:/m);
  });

  it("leaves elevators disabled when the env var is unset", async () => {
    const fx = setupCatalog(TEMPLATE);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.artifacts).toMatchObject({ elevatorsOverridden: false });
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/elevators:\s*false/);
  });
});

describe("gen-motis-config region scoping", () => {
  it("passes the configured countries as region args to the generator", async () => {
    const fx = setupCatalog(TEMPLATE_WITH_OSM);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: ["de", "ch"],
      runner: async (cmd, args) => {
        calls.push({ cmd, args });
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = fx.catalogDir;
    await genMotisConfigRun(ctx);
    const py = calls.find((c) => c.cmd === "python3");
    expect(py?.args).toEqual([
      "./src/generate-motis-config.py",
      "--import-only",
      "--skip-missing-files",
      "de",
      "ch",
    ]);
  });

  it("passes no region arg when countries is empty (global build)", async () => {
    const fx = setupCatalog(TEMPLATE_WITH_OSM);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: [],
      runner: async (cmd, args) => {
        calls.push({ cmd, args });
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = fx.catalogDir;
    await genMotisConfigRun(ctx);
    const py = calls.find((c) => c.cmd === "python3");
    expect(py?.args).toEqual([
      "./src/generate-motis-config.py",
      "--import-only",
      "--skip-missing-files",
    ]);
  });
});

describe("gen-motis-config osm region override", () => {
  it("points osm at the region pbf from OPENMAPX_REGION", async () => {
    process.env.OPENMAPX_REGION = "europe/germany";
    const fx = setupCatalog(TEMPLATE_WITH_OSM);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ osmRegionOverridden: true });
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/^osm: europe-germany\.osm\.pbf$/m);
  });

  it("prefers MOTIS_REGION over OPENMAPX_REGION", async () => {
    process.env.OPENMAPX_REGION = "europe/germany";
    process.env.MOTIS_REGION = "europe/france";
    const fx = setupCatalog(TEMPLATE_WITH_OSM);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.artifacts).toMatchObject({ osmRegionOverridden: true });
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/^osm: europe-france\.osm\.pbf$/m);
  });

  it("maps the planet region to planet.osm.pbf", async () => {
    process.env.OPENMAPX_REGION = "planet";
    const fx = setupCatalog(TEMPLATE_WITH_OSM);
    await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    // The template already says planet-latest; planet → planet.osm.pbf is a change.
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/^osm: planet\.osm\.pbf$/m);
  });

  it("leaves osm alone when no region is configured", async () => {
    const fx = setupCatalog(TEMPLATE_WITH_OSM);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.artifacts).toMatchObject({ osmRegionOverridden: false });
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/^osm: planet-latest\.osm\.pbf$/m);
  });

  it("is a no-op for a transit-only config with no osm key", async () => {
    process.env.OPENMAPX_REGION = "europe/germany";
    const fx = setupCatalog(TEMPLATE); // no `osm:` line
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ osmRegionOverridden: false });
    expect(readFileSync(fx.configPath, "utf-8")).not.toMatch(/^osm:/m);
  });
});

describe("gen-motis-config osr_footpath override", () => {
  it("flips osr_footpath to true when MOTIS_OSR_FOOTPATH=true", async () => {
    process.env.MOTIS_OSR_FOOTPATH = "true";
    const fx = setupCatalog(TEMPLATE);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.artifacts).toMatchObject({ osrFootpathOverridden: true });
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/osr_footpath:\s*true/);
  });

  it("leaves osr_footpath alone when the env var is unset", async () => {
    const fx = setupCatalog(TEMPLATE);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.artifacts).toMatchObject({ osrFootpathOverridden: false });
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/osr_footpath:\s*false/);
  });
});

const TEMPLATE_WITH_SHAPES = `server:
  port: 8080
street_routing: true
osm: planet-latest.osm.pbf
timetable:
  with_shapes: true
  datasets:
    foo:
      path: foo.gtfs.zip
`;

describe("gen-motis-config route_shapes override", () => {
  it("injects a route_shapes block nested in timetable when MOTIS_ROUTE_SHAPES=missing", async () => {
    process.env.MOTIS_ROUTE_SHAPES = "missing";
    const fx = setupCatalog(TEMPLATE_WITH_SHAPES);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.artifacts).toMatchObject({ routeShapesOverridden: true });
    const written = readFileSync(fx.configPath, "utf-8");
    // Nested one level under timetable (2-space indent), directly after
    // with_shapes: mode, a rail-scoped clasz block, then the max_stops safeguard.
    expect(written).toMatch(
      /^ {2}with_shapes: true\n {2}route_shapes:\n {4}mode: missing\n {4}clasz:\n {6}BUS: false\n {6}COACH: false\n {4}max_stops: 300$/m,
    );
  });

  it("maps MOTIS_ROUTE_SHAPES=all to mode: all", async () => {
    process.env.MOTIS_ROUTE_SHAPES = "all";
    const fx = setupCatalog(TEMPLATE_WITH_SHAPES);
    await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/route_shapes:\n {4}mode: all/);
  });

  it("leaves the config untouched when MOTIS_ROUTE_SHAPES is unset", async () => {
    const fx = setupCatalog(TEMPLATE_WITH_SHAPES);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.artifacts).toMatchObject({ routeShapesOverridden: false });
    expect(readFileSync(fx.configPath, "utf-8")).not.toContain("route_shapes:");
  });

  it("does not inject when with_shapes is absent", async () => {
    process.env.MOTIS_ROUTE_SHAPES = "missing";
    const fx = setupCatalog(TEMPLATE_WITH_OSM);
    const result = await genMotisConfigRun(ctxFor(fx.dataDir, fx.catalogDir));
    expect(result.artifacts).toMatchObject({ routeShapesOverridden: false });
    expect(readFileSync(fx.configPath, "utf-8")).not.toContain("route_shapes:");
  });
});
