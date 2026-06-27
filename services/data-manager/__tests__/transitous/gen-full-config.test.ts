import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as genFullConfigRun } from "../../src/jobs/transitous/gen-full-config.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;
const ENV_KEYS = [
  "MOTIS_INCREMENTAL_RT_UPDATE",
  "MOTIS_ELEVATORS_URL",
  "MOTIS_ELEVATORS_AUTH",
  "MOTIS_OSR_FOOTPATH",
  "MOTIS_TILES",
  "MOTIS_REGION",
  "OPENMAPX_REGION",
  "OPENMAPX_TRANSITOUS_FEED_PROXY_URL",
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
  tmp = mkdtempSync(join(tmpdir(), "openmapx-gen-full-config-"));
  const catalogDir = join(tmp, ".transitous-catalog");
  const outDir = join(catalogDir, "out");
  mkdirSync(join(catalogDir, "src"), { recursive: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(catalogDir, "src", "generate-motis-config.py"), "");
  const configPath = join(outDir, "config.yml");
  writeFileSync(configPath, initialConfigYaml, "utf-8");
  return { dataDir: tmp, catalogDir, configPath };
}

function ctxFor(dataDir: string, catalogDir: string, countries: string[] = []) {
  const ctx = buildJobContext({
    dataDir,
    store: new StateStore(dataDir),
    countries,
    // Stub: the stage already wrote config.yml in setup. The feed-proxy
    // sub-step's vars JSON is intentionally absent → it warns and no-ops.
    runner: async () => {},
    now: () => "2026-05-01T00:00:00.000Z",
  });
  ctx.state.catalogDir = catalogDir;
  return ctx;
}

const TEMPLATE_WITH_OSM = `server:
  port: 8080
street_routing: true
osm: planet-latest.osm.pbf
timetable:
  datasets:
    foo:
      path: foo.gtfs.zip
`;

const TEMPLATE_WITH_TILES = `server:
  port: 8080
osm: planet-latest.osm.pbf
tiles:
  profile: /opt/motis/tiles-profiles/full.lua
  coastline: land-polygons-complete-4326.zip
timetable:
  datasets:
    foo:
      path: foo.gtfs.zip
`;

describe("gen-full-config osm region override (promote-config parity)", () => {
  it("points the runtime config's osm at the region pbf, matching gen-motis-config", async () => {
    process.env.OPENMAPX_REGION = "europe/germany";
    const fx = setupCatalog(TEMPLATE_WITH_OSM);
    const result = await genFullConfigRun(ctxFor(fx.dataDir, fx.catalogDir, ["de"]));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ osmRegionOverridden: true });
    // This is the regression: the serve config must NOT keep planet-latest, or
    // the post-promote `/motis import` verify-fails on a missing extract.
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/^osm: europe-germany\.osm\.pbf$/m);
  });

  it("leaves osm alone when no region is configured", async () => {
    const fx = setupCatalog(TEMPLATE_WITH_OSM);
    const result = await genFullConfigRun(ctxFor(fx.dataDir, fx.catalogDir, ["de"]));
    expect(result.artifacts).toMatchObject({ osmRegionOverridden: false });
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/^osm: planet-latest\.osm\.pbf$/m);
  });
});

describe("gen-full-config tiles disable (promote-config parity)", () => {
  it("strips the tiles block by default (stock motis image ships no tiles profile)", async () => {
    const fx = setupCatalog(TEMPLATE_WITH_TILES);
    const result = await genFullConfigRun(ctxFor(fx.dataDir, fx.catalogDir, ["de"]));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ tilesDisabled: true });
    const updated = readFileSync(fx.configPath, "utf-8");
    // The whole block (key + indented children) is gone, neighbours intact.
    expect(updated).not.toMatch(/^tiles:/m);
    expect(updated).not.toMatch(/tiles-profiles/);
    expect(updated).not.toMatch(/land-polygons/);
    expect(updated).toMatch(/^timetable:/m);
    expect(updated).toMatch(/^osm:/m);
  });

  it("keeps the tiles block when MOTIS_TILES=true", async () => {
    process.env.MOTIS_TILES = "true";
    const fx = setupCatalog(TEMPLATE_WITH_TILES);
    const result = await genFullConfigRun(ctxFor(fx.dataDir, fx.catalogDir, ["de"]));
    expect(result.artifacts).toMatchObject({ tilesDisabled: false });
    expect(readFileSync(fx.configPath, "utf-8")).toMatch(/^tiles:/m);
  });
});

describe("gen-full-config region scoping", () => {
  it("passes the configured countries (without --import-only) to the generator", async () => {
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
    await genFullConfigRun(ctx);
    const py = calls.find((c) => c.cmd === "python3" && !c.args.includes("--feed-proxy"));
    expect(py?.args).toEqual([
      "./src/generate-motis-config.py",
      "--skip-missing-files",
      "de",
      "ch",
    ]);
  });
});

describe("gen-full-config realtime independence", () => {
  const TEMPLATE_WITH_RT = `server:
  port: 8080
timetable:
  datasets:
    de-bvg:
      rt:
        - url: https://rt.triptix.tech/feed/de-bvg-0
`;

  it("repoints rt.triptix.tech onto our feed-proxy (default) so RT is infra-independent", async () => {
    const fx = setupCatalog(TEMPLATE_WITH_RT);
    const result = await genFullConfigRun(ctxFor(fx.dataDir, fx.catalogDir, ["de"]));
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ rtRewritten: 1 });
    const updated = readFileSync(fx.configPath, "utf-8");
    expect(updated).toContain("http://motis-feed-proxy/feed/de-bvg-0");
    expect(updated).not.toContain("rt.triptix.tech");
  });

  it("uses an explicit feed-proxy URL override when provided", async () => {
    process.env.OPENMAPX_TRANSITOUS_FEED_PROXY_URL = "http://rt.openmapx.local";
    const fx = setupCatalog(TEMPLATE_WITH_RT);
    await genFullConfigRun(ctxFor(fx.dataDir, fx.catalogDir, ["de"]));
    expect(readFileSync(fx.configPath, "utf-8")).toContain(
      "http://rt.openmapx.local/feed/de-bvg-0",
    );
  });
});
