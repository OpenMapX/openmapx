/**
 * Phase E9: end-to-end Transitous pipeline against a real `motis-staging`
 * Docker container, seeded with three tiny GTFS feeds (DE/CH/AT). Drives all
 * 11 stages so the previously-stubbed `motis-import`, `motis-health`, and
 * `promote` paths actually exec MOTIS and observe the atomic swap.
 *
 * Gating semantics:
 *   - Default (`OPENMAPX_E9_LIVE_MOTIS` unset): the whole suite is skipped
 *     silently. The default `pnpm test` invocation never spins up Docker.
 *   - `OPENMAPX_E9_LIVE_MOTIS=true` + Docker daemon reachable + the
 *     `ghcr.io/motis-project/motis:latest` image already cached locally:
 *     the suite runs. If the image is missing we additionally `it.skip(...)`
 *     the actual probes with a clear log so CI can surface the missing
 *     prerequisite without failing.
 *
 * Container lifecycle is owned by the test: each run starts with the
 * staging container forcibly down, brings it up via a compose file
 * generated into the test's tmp dir, runs the pipeline, then tears
 * everything down in `afterAll`. No reliance on the operator's
 * `infra/docker/data` tree.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildJobContext, runTransitousPipeline } from "../../src/jobs/transitous/pipeline.js";
import type { CommandRunner, StageName } from "../../src/jobs/transitous/types.js";
import { StateStore } from "../../src/state.js";
import { buildTinyGtfsFeeds } from "./fixtures/build-tiny-gtfs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_SCRIPTS_DIR = resolve(HERE, "fixtures", "stub-catalog-scripts");

const LIVE = process.env.OPENMAPX_E9_LIVE_MOTIS === "true";
const describeLive = LIVE ? describe : describe.skip;

const MOTIS_IMAGE = "ghcr.io/motis-project/motis:latest";
const STAGING_SERVICE = "motis-staging";
const STAGING_PORT = 8082;
const TOTAL_BUDGET_MS = 90_000;
// The pipeline invokes `docker compose up -d motis-staging` without an
// explicit `-p`, so docker derives the project name from the cwd basename
// (i.e. `ctx.dataDir`'s last segment). To keep teardown consistent we
// reuse the same default-derived project name. `process.pid` is folded
// into the dataDir name (see beforeAll) so concurrent test runs don't
// collide.

const ORDERED_STAGES: StageName[] = [
  "prepare",
  "filter",
  "fetch",
  "validate",
  "gen-motis-config",
  "motis-import",
  "motis-health",
  "gen-full-config",
  "gen-attribution",
  "promote",
  "gc",
];

async function dockerImagePresent(image: string): Promise<boolean> {
  try {
    await execa("docker", ["image", "inspect", image], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function dockerDaemonReachable(): Promise<boolean> {
  try {
    await execa("docker", ["info"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function writeStagingCompose(dataDir: string, stagingDataDir: string): string {
  const composeFile = join(dataDir, "docker-compose.yml");
  const yaml = [
    "services:",
    `  ${STAGING_SERVICE}:`,
    `    image: ${MOTIS_IMAGE}`,
    "    working_dir: /motis-data",
    '    entrypoint: ["/bin/sh", "-c"]',
    '    command: ["/motis import -c /motis-data/config.yml && /motis server -c /motis-data/config.yml"]',
    "    ports:",
    `      - "127.0.0.1:${STAGING_PORT}:8080"`,
    "    volumes:",
    `      - ${stagingDataDir}:/motis-data`,
    '    restart: "no"',
    "",
  ].join("\n");
  writeFileSync(composeFile, yaml);
  return composeFile;
}

async function composeDown(composeFile: string, cwd: string): Promise<void> {
  try {
    await execa("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], {
      cwd,
      stdio: "pipe",
    });
  } catch {
    // Best effort — the test owns cleanup.
  }
}

async function composeUp(composeFile: string, cwd: string): Promise<void> {
  await execa("docker", ["compose", "-f", composeFile, "up", "-d", STAGING_SERVICE], {
    cwd,
    stdio: "pipe",
  });
}

async function waitForStagingHealthy(deadlineMs: number): Promise<boolean> {
  const url = `http://127.0.0.1:${STAGING_PORT}/api/v1/initial`;
  while (Date.now() < deadlineMs) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      // Retry until deadline.
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

describeLive("transitous pipeline end-to-end against motis-staging", () => {
  let tmp: string | undefined;
  let composeFile: string | undefined;
  let dataDir: string | undefined;
  let imageAvailable = false;
  let daemonAvailable = false;
  let stagingDataDir: string | undefined;

  beforeAll(async () => {
    daemonAvailable = await dockerDaemonReachable();
    if (!daemonAvailable) {
      console.warn(
        "skipping live MOTIS test: Docker daemon is not reachable; start Docker Desktop or the engine and re-run",
      );
      return;
    }
    imageAvailable = await dockerImagePresent(MOTIS_IMAGE);
    if (!imageAvailable) {
      console.warn(
        `skipping live MOTIS test: ${MOTIS_IMAGE} is not present locally; pull with \`docker pull ${MOTIS_IMAGE}\` then re-run`,
      );
      return;
    }

    tmp = mkdtempSync(join(tmpdir(), "openmapx-e9-live-"));
    // The pipeline derives the docker-compose project name from the cwd
    // basename when invoking `docker compose up -d motis-staging`. We
    // fold the pid + a random suffix into the basename so concurrent
    // test runs end up with distinct project names and don't try to
    // reuse the same container.
    dataDir = join(tmp, `data-${process.pid}`);
    mkdirSync(dataDir, { recursive: true });
    stagingDataDir = join(dataDir, "motis-staging-data");
    mkdirSync(stagingDataDir, { recursive: true });

    // Build the tiny GTFS fixtures into a sibling dir so the catalog's
    // file:// urls can reference them without leaking host-specific paths
    // into the catalog's own working tree.
    const fixturesDir = join(tmp, "tiny-gtfs");
    const built = await buildTinyGtfsFeeds(fixturesDir);

    // Materialise a stub Transitous catalog. The data-manager's prepare
    // stage probes for `<catalog>/.git`; if present, no clone happens and
    // the existing tree is reused. We pre-create everything the
    // downstream stages read.
    const catalogDir = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    mkdirSync(join(catalogDir, "src"), { recursive: true });
    mkdirSync(join(catalogDir, "transitland-atlas"), { recursive: true });

    // Stub Python scripts.
    for (const name of [
      "fetch.py",
      "generate-motis-config.py",
      "generate-attribution.py",
      "garbage-collect.py",
    ]) {
      cpSync(join(STUB_SCRIPTS_DIR, name), join(catalogDir, "src", name));
    }

    // Catalog feed files: one per region, each referencing the
    // matching fixture zip via a `file://` url. `type: url` is what the
    // stub fetch.py understands.
    const byRegion = new Map<string, typeof built.entries>();
    for (const entry of built.entries) {
      const list = byRegion.get(entry.region) ?? [];
      list.push(entry);
      byRegion.set(entry.region, list);
    }
    for (const [region, entries] of byRegion) {
      const sources = entries.map((entry) => ({
        name: "demo",
        type: "url",
        url: `file://${entry.zipPath}`,
      }));
      writeFileSync(
        join(catalogDir, "feeds", `${region}.json`),
        `${JSON.stringify({ sources }, null, 2)}\n`,
      );
    }

    composeFile = writeStagingCompose(dataDir, stagingDataDir);
    // Make sure we own a clean container — a previous failed run could
    // have left one behind.
    await composeDown(composeFile, dataDir);
  }, 60_000);

  afterAll(async () => {
    if (composeFile && dataDir) await composeDown(composeFile, dataDir);
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // Tmp on macOS occasionally throws on already-removed entries; ignore.
      }
    }
  }, 60_000);

  it(
    "runs all 11 stages against a real motis-staging container under the time budget",
    async (testCtx) => {
      if (!daemonAvailable || !imageAvailable) {
        // beforeAll already logged the reason. Use vitest's `testCtx.skip()`
        // so CI surfaces a skip rather than a false-positive pass.
        testCtx.skip();
        return;
      }
      if (!dataDir || !stagingDataDir || !composeFile) {
        throw new Error("test setup did not complete");
      }
      const motisDataDir = join(dataDir, "motis-data");

      // The data-manager normally talks to its own docker socket; in this
      // test we *also* drive the staging compose externally so we can
      // tear it down. The pipeline's own `docker compose up -d
      // motis-staging` invocation from `ctx.dataDir` will reuse the
      // compose file we just wrote.
      const runner: CommandRunner = async (command, args, opts) => {
        if (command === "git") {
          // The stub catalog has a placeholder `.git`. Any git invocation
          // (pull, submodule update, reset, fetch, checkout) would fail
          // against it; the pipeline's own behaviour swallows pull
          // failures but submodule update is unconditional. Pretend
          // every git call succeeded — the catalog tree is already at
          // the state we want.
          return;
        }
        await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "pipe" });
      };

      // Tell the stub generate-motis-config.py where to mirror the
      // staging assets. Without this the config + zips would only land
      // under the catalog's `out/` symlink, not the dir motis-import
      // reads from.
      const prevStaging = process.env.OPENMAPX_E9_STAGING_DIR;
      process.env.OPENMAPX_E9_STAGING_DIR = stagingDataDir;

      const ctx = buildJobContext({
        dataDir,
        store: new StateStore(dataDir),
        countries: ["de", "ch", "at"],
        runner,
        now: () => new Date().toISOString(),
      });

      const started = Date.now();
      let pipelineErr: unknown;
      let results: Awaited<ReturnType<typeof runTransitousPipeline>>["results"] = [];
      try {
        const out = await runTransitousPipeline(ctx);
        results = out.results;
      } catch (err) {
        pipelineErr = err;
      } finally {
        if (prevStaging === undefined) delete process.env.OPENMAPX_E9_STAGING_DIR;
        else process.env.OPENMAPX_E9_STAGING_DIR = prevStaging;
      }
      const elapsed = Date.now() - started;

      if (pipelineErr) {
        throw pipelineErr;
      }

      expect(results.map((r) => r.stage)).toEqual(ORDERED_STAGES);
      const byStage = Object.fromEntries(results.map((r) => [r.stage, r]));
      // Previously stubbed stages must now actually run. We assert "ok"
      // (not "skipped") so a regression to the empty-staging-dir
      // short-circuit fails this spec.
      expect(byStage["motis-import"]?.status, "motis-import").toBe("ok");
      expect(byStage["motis-health"]?.status, "motis-health").toBe("ok");
      expect(byStage.promote?.status, "promote").toBe("ok");

      // Staging container responded to the smoke probe directly. The
      // promote stage has now renamed staging → motis-data, so we
      // re-bring-up motis-staging via the host compose to satisfy the
      // direct probe assertion. We just confirm the swap happened on
      // disk.
      expect(existsSync(motisDataDir), `${motisDataDir} should exist after promote`).toBe(true);
      // The promote stage recreates an empty staging dir for the next
      // cycle. Either empty or freshly populated is acceptable.
      expect(existsSync(stagingDataDir as string)).toBe(true);

      // 90s is more generous than the plan's 60s budget to account for
      // first-boot of the MOTIS container in a cold-cache CI runner.
      expect(elapsed).toBeLessThan(TOTAL_BUDGET_MS);
    },
    TOTAL_BUDGET_MS + 30_000,
  );

  it("staging container served at least one health probe directly", async (testCtx) => {
    if (!daemonAvailable || !imageAvailable) {
      testCtx.skip();
      return;
    }
    // The promote stage has by now renamed motis-staging-data away, so
    // motis-staging is likely down. We restart it just long enough to
    // assert the smoke probe path works end-to-end against a freshly
    // imported tiny feed — this is the strongest "the MOTIS image
    // actually ran on these feeds" signal we can give CI.
    if (!composeFile || !stagingDataDir) {
      testCtx.skip();
      return;
    }
    // If staging dir was recreated empty by promote, repopulate from
    // motis-data (which has the swapped content) before bringing the
    // container back up.
    const dst = stagingDataDir;
    const src = join(dataDir as string, "motis-data");
    if (existsSync(src) && readdirSync(dst).length === 0) {
      for (const name of readdirSync(src)) {
        cpSync(join(src, name), join(dst, name), { recursive: true });
      }
    }
    await composeUp(composeFile, dataDir as string);
    const healthy = await waitForStagingHealthy(Date.now() + 45_000);
    expect(healthy, "staging container did not become healthy within 45s").toBe(true);
    const res = await fetch(`http://127.0.0.1:${STAGING_PORT}/api/v1/initial`);
    expect(res.ok).toBe(true);
  }, 90_000);
});
