import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TransitousRunnerScript,
  transitousRunnerArgv,
} from "@openmapx/core/transitous-runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as genFullConfigRun } from "../../src/jobs/transitous/gen-full-config.js";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";
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
    runScript: async (run) => {
      if (run.script === "feed-proxy-vars-to-json") {
        writeFileSync(join(catalogDir, "out", "feed-proxy-vars.json"), "{}");
      }
    },
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
    const calls: TransitousRunnerScript[] = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      countries: ["de", "ch"],
      runScript: async (run) => {
        calls.push(run);
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = fx.catalogDir;
    await genFullConfigRun(ctx);
    const runtimeConfig = calls.find(
      (run) => run.script === "generate-motis-config" && !run.feedProxy,
    );
    expect(runtimeConfig).toEqual({
      script: "generate-motis-config",
      importOnly: false,
      feedProxy: false,
      countries: ["de", "ch"],
    });
    expect(transitousRunnerArgv(runtimeConfig as TransitousRunnerScript)).toEqual([
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
        - url: https://rt.triptix.tech/feed/de-vbb-0
`;

  // A ctx whose script runner simulates the --feed-proxy run producing
  // feed-proxy vars (the keys = the feeds our proxy serves), so the selective
  // RT rewrite has a feed-id set to act on.
  function ctxWithProxyVars(catalogDir: string, dataDir: string, proxyKeys: string[]) {
    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      countries: ["de"],
      runScript: async (run) => {
        if (run.script === "feed-proxy-vars-to-json") {
          const vars = Object.fromEntries(
            proxyKeys.map((k) => [k, { url: `https://origin.example/gtfsrt/${k}` }]),
          );
          writeFileSync(join(catalogDir, "out", "feed-proxy-vars.json"), JSON.stringify(vars));
        }
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;
    return ctx;
  }

  it("repoints only the feeds our proxy serves onto our feed-proxy (default URL)", async () => {
    const fx = setupCatalog(TEMPLATE_WITH_RT);
    const result = await genFullConfigRun(
      ctxWithProxyVars(fx.catalogDir, fx.dataDir, ["de-bvg-0"]),
    );
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ rtRewritten: 1 });
    const updated = readFileSync(fx.configPath, "utf-8");
    // de-bvg-0 is in our proxy set → repointed.
    expect(updated).toContain("http://motis-feed-proxy/feed/de-bvg-0");
    // de-vbb-0 is NOT served by our proxy → left on the origin rather than broken.
    expect(updated).toContain("https://rt.triptix.tech/feed/de-vbb-0");
  });

  it("uses an explicit feed-proxy URL override when provided", async () => {
    process.env.OPENMAPX_TRANSITOUS_FEED_PROXY_URL = "http://rt.openmapx.local";
    const fx = setupCatalog(TEMPLATE_WITH_RT);
    await genFullConfigRun(ctxWithProxyVars(fx.catalogDir, fx.dataDir, ["de-bvg-0"]));
    expect(readFileSync(fx.configPath, "utf-8")).toContain(
      "http://rt.openmapx.local/feed/de-bvg-0",
    );
  });

  it("falls back to the default URL when the env var is set but empty", async () => {
    // Compose injects `${OPENMAPX_TRANSITOUS_FEED_PROXY_URL:-}` as "" when the
    // operator hasn't set it — that empty string must NOT become the rewrite
    // target (which would yield a broken "/feed/de-bvg-0").
    process.env.OPENMAPX_TRANSITOUS_FEED_PROXY_URL = "";
    const fx = setupCatalog(TEMPLATE_WITH_RT);
    await genFullConfigRun(ctxWithProxyVars(fx.catalogDir, fx.dataDir, ["de-bvg-0"]));
    expect(readFileSync(fx.configPath, "utf-8")).toContain("http://motis-feed-proxy/feed/de-bvg-0");
  });

  it("rewrites the GBFS scalar and persists normalized proxy vars beside the config", async () => {
    const fx = setupCatalog(
      `${TEMPLATE_WITH_RT}gbfs:\n  proxy: https://rt.triptix.tech\n  feeds:\n    bvg:\n      url: https://rt.triptix.tech/feed/de-bvg-0\n`,
    );
    const result = await genFullConfigRun(
      ctxWithProxyVars(fx.catalogDir, fx.dataDir, ["de-bvg-0", "de-vbb-0"]),
    );
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ rtRewritten: 3, gbfsProxyRewritten: 1 });
    const updated = readFileSync(fx.configPath, "utf-8");
    expect(updated).toContain("  proxy: http://motis-feed-proxy");
    expect(updated).not.toContain("https://rt.triptix.tech");
    expect(
      JSON.parse(
        readFileSync(
          join(fx.catalogDir, "out", ".openmapx-feed-proxy", "feed-proxy-vars.json"),
          "utf-8",
        ),
      ),
    ).toHaveProperty("de-bvg-0");
    expect(
      readFileSync(
        join(fx.catalogDir, "out", ".openmapx-feed-proxy", "conf", "default.conf"),
        "utf-8",
      ),
    ).toContain('location "/feed/de-bvg-0"');
    expect(existsSync(join(fx.dataDir, "motis-feed-proxy"))).toBe(false);
  });

  it("fails instead of promoting GBFS entries absent from the local proxy", async () => {
    const fx = setupCatalog(
      `gbfs:\n  proxy: https://rt.triptix.tech\n  feeds:\n    missing:\n      url: https://rt.triptix.tech/feed/de-missing-0\n`,
    );
    const result = await genFullConfigRun(ctxWithProxyVars(fx.catalogDir, fx.dataDir, []));
    expect(result.status).toBe("error");
    expect(result.message).toContain("de-missing-0");
  });

  it("fails closed when a sovereign config retains a hosted realtime URL", async () => {
    const fx = setupCatalog(TEMPLATE_WITH_RT);
    const ctx = ctxWithProxyVars(fx.catalogDir, fx.dataDir, ["de-bvg-0"]);
    ctx.operationsPolicy = resolveOperationsProfile({
      profile: "regional-sovereign",
      countries: ["de"],
      source: "build",
      osmInput: "germany.osm.pbf",
    });
    const result = await genFullConfigRun(ctx);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/sovereign.*prohibited hosted runtime URLs/);
    expect(result.message).toContain("rt.triptix.tech/feed/de-vbb-0");
  });
});
