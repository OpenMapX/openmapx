import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as genMotisConfigRun } from "../../src/jobs/transitous/gen-motis-config.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;
let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.MOTIS_INCREMENTAL_RT_UPDATE;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.MOTIS_INCREMENTAL_RT_UPDATE;
  else process.env.MOTIS_INCREMENTAL_RT_UPDATE = originalEnv;
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
timetable:
  update_interval: 60
  incremental_rt_update: false
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
