/**
 * End-to-end Transitous pipeline against a real `motis-staging`
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
// The promote stage restarts the primary `motis` container (`docker restart
// motis`) and polls it at MOTIS_URL (default localhost:8081) after the atomic
// swap. The canary runs a primary alongside staging so that path is exercised
// for real rather than failing on a missing container.
const PRIMARY_SERVICE = "motis";
const PRIMARY_PORT = 8081;
// Generous wall-clock ceiling for the whole pipeline. It now performs TWO
// MOTIS imports + boots on a cold-cache runner — the staging import
// (motis-import) and the primary's re-import on promote's `docker restart motis`
// — so a tight budget would flake on a correct-but-slow run. This is a sanity
// cap against a pathological hang, not a perf SLA.
const PIPELINE_BUDGET_MS = 4 * 60_000;
// The pipeline invokes `docker compose up -d motis-staging` without an
// explicit `-p`, so docker derives the project name from the cwd basename
// (i.e. `ctx.dataDir`'s last segment). To keep teardown consistent we
// reuse the same default-derived project name. `process.pid` is folded
// into the dataDir name (see beforeAll) so the project name is unique.
// Note: the compose service pins `container_name: motis-staging` (mirroring
// the generated production compose so the stage's `docker exec motis-staging`
// resolves), so this suite must not run concurrently with itself — the fixed
// name would collide. CI serialises it via the workflow concurrency group.

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

/**
 * One MOTIS compose service. Both staging and the primary are identical apart
 * from name, published port, and the host data dir they mount.
 *
 * - `container_name` is pinned to match the generated production compose (the
 *   motis and motis-staging service manifests set `containerName`). The pipeline
 *   addresses these containers by bare name over the docker CLI — `docker exec
 *   motis-staging …` (motis-import) and `docker restart motis` (promote) — which
 *   only resolves with a fixed name; compose's default `<project>-<svc>-1` would
 *   not.
 * - The command mirrors the production manifests: `motis import` reads
 *   ./config.yml and writes the preprocessed `./data` folder (cwd is working_dir
 *   /motis-data); `motis server` then serves that folder. `server` takes no
 *   `-c` — passing one is an "unrecognised option" error.
 */
function motisService(name: string, hostPort: number, hostDataDir: string): string[] {
  return [
    `  ${name}:`,
    `    image: ${MOTIS_IMAGE}`,
    `    container_name: ${name}`,
    "    working_dir: /motis-data",
    '    entrypoint: ["/bin/sh", "-c"]',
    '    command: ["/motis import && /motis server"]',
    "    ports:",
    `      - "127.0.0.1:${hostPort}:8080"`,
    "    volumes:",
    `      - ${hostDataDir}:/motis-data`,
    '    restart: "no"',
  ];
}

/**
 * Compose file with both the staging and primary MOTIS services. The primary
 * (`motis`) backs the promote stage's `docker restart motis` + health poll on
 * MOTIS_URL (default localhost:8081); staging (`motis-staging`) backs
 * motis-import + motis-health on localhost:8082.
 */
function writeStagingCompose(
  dataDir: string,
  stagingDataDir: string,
  motisDataDir: string,
): string {
  const composeFile = join(dataDir, "docker-compose.yml");
  const yaml = [
    "services:",
    ...motisService(STAGING_SERVICE, STAGING_PORT, stagingDataDir),
    ...motisService(PRIMARY_SERVICE, PRIMARY_PORT, motisDataDir),
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
  // `--force-recreate`: the staging container from the first spec's pipeline is
  // still running with its original bind mount (which promote renamed away), so
  // a plain `up -d` (unchanged spec) would reuse it and ignore the freshly
  // repopulated data dir. Recreating it re-establishes the mount.
  await execa(
    "docker",
    ["compose", "-f", composeFile, "up", "-d", "--force-recreate", STAGING_SERVICE],
    {
      cwd,
      stdio: "pipe",
    },
  );
}

async function waitForStagingHealthy(deadlineMs: number): Promise<boolean> {
  const url = `http://127.0.0.1:${STAGING_PORT}/api/v1/map/initial`;
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

/**
 * Build a diagnostic string for a failed staging stage. The stage result only
 * carries the docker CLI error (e.g. a failed `docker exec`); the actual MOTIS
 * import failure lives in the container's logs. We fold both into the assertion
 * message so CI shows the root cause inline — the workflow's artifact upload
 * can't help here (the tmp dir is torn down in `afterAll` before it runs).
 */
async function stagingFailureDiagnostics(label: string, message?: string): Promise<string> {
  const lines = [`${label}${message ? `: ${message}` : ""}`];
  try {
    const logs = await execa("docker", ["logs", STAGING_SERVICE], { reject: false });
    if (logs.stdout) lines.push(`--- docker logs ${STAGING_SERVICE} (stdout) ---`, logs.stdout);
    if (logs.stderr) lines.push(`--- docker logs ${STAGING_SERVICE} (stderr) ---`, logs.stderr);
  } catch (err) {
    lines.push(`(could not fetch ${STAGING_SERVICE} logs: ${(err as Error).message})`);
  }
  return lines.join("\n");
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

    // Empty primary data dir so the `motis` container has a host-owned mount
    // target. The promote stage renames this dir during its atomic swap, so it
    // must exist (and be ours) up front.
    const motisDataDir = join(dataDir, "motis-data");
    mkdirSync(motisDataDir, { recursive: true });

    composeFile = writeStagingCompose(dataDir, stagingDataDir, motisDataDir);
    // Make sure we own a clean slate. `compose down` only reaps containers in
    // THIS run's (pid-derived) project; a crashed earlier run leaves pinned
    // `motis`/`motis-staging` containers under a different project that would
    // otherwise collide with our `up` ("container name already in use"). Force-
    // remove them by name first — best effort, ignore "no such container".
    await execa("docker", ["rm", "-f", PRIMARY_SERVICE, STAGING_SERVICE], {
      stdio: "pipe",
    }).catch(() => {});
    await composeDown(composeFile, dataDir);
    // Bring the primary `motis` container into existence so the promote stage's
    // `docker restart motis` has something to restart. With no config in
    // motis-data yet it imports, fails, and exits — that's expected; promote's
    // restart-after-swap revives it against the just-promoted data.
    await execa("docker", ["compose", "-f", composeFile, "up", "-d", PRIMARY_SERVICE], {
      cwd: dataDir,
      stdio: "pipe",
    });
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
      // short-circuit fails this spec. On failure we attach the container
      // logs so the real MOTIS error (not just the stage's CLI error) shows
      // up in the CI run.
      for (const stage of ["motis-import", "motis-health"] as const) {
        if (byStage[stage]?.status !== "ok") {
          const diag = await stagingFailureDiagnostics(stage, byStage[stage]?.message);
          expect(byStage[stage]?.status, diag).toBe("ok");
        }
      }
      expect(byStage.promote?.status, byStage.promote?.message ?? "promote").toBe("ok");

      // Staging container responded to the smoke probe directly. The
      // promote stage has now renamed staging → motis-data, so we
      // re-bring-up motis-staging via the host compose to satisfy the
      // direct probe assertion. We just confirm the swap happened on
      // disk.
      expect(existsSync(motisDataDir), `${motisDataDir} should exist after promote`).toBe(true);
      // The promote stage recreates an empty staging dir for the next
      // cycle. Either empty or freshly populated is acceptable.
      expect(existsSync(stagingDataDir as string)).toBe(true);

      // Sanity cap only — see PIPELINE_BUDGET_MS. The pipeline does two real
      // MOTIS imports+boots (staging + primary-on-promote), so we don't assert
      // a tight wall-clock; we just guard against a pathological hang and log
      // the elapsed time for visibility.
      console.error(`E9 pipeline elapsed: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(PIPELINE_BUDGET_MS);
    },
    PIPELINE_BUDGET_MS + 30_000,
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
    const dst = stagingDataDir;
    const src = join(dataDir as string, "motis-data");
    // This spec depends on the pipeline spec above having completed a promote
    // (which leaves the imported feeds at motis-data). If that didn't happen
    // — the spec above failed mid-promote — there's nothing to serve. Skip
    // with a clear reason rather than booting an empty container and reporting
    // a misleading 45s health timeout that buries the real failure.
    if (!existsSync(src)) {
      console.warn(
        `skipping direct-probe spec: ${src} is absent — the pipeline spec above did not complete a promote`,
      );
      testCtx.skip();
      return;
    }
    // Repopulate staging with only the IMPORT INPUTS (config + GTFS zips), not
    // the already-built `data/` dir or the import marker: the recreated
    // container's `/motis import` entrypoint rebuilds `data/` from scratch, and
    // importing on top of an existing `data/` is version-dependent.
    if (readdirSync(dst).length === 0) {
      for (const name of readdirSync(src)) {
        if (name === "data" || name.startsWith(".data-manager-import")) continue;
        cpSync(join(src, name), join(dst, name), { recursive: true });
      }
    }
    await composeUp(composeFile, dataDir as string);
    const healthy = await waitForStagingHealthy(Date.now() + 45_000);
    if (!healthy) {
      // Surface the container's own logs so a failure shows the MOTIS error
      // inline (afterAll tears the container down before any artifact upload).
      const diag = await stagingFailureDiagnostics("direct staging probe");
      expect(healthy, diag).toBe(true);
    }
    const res = await fetch(`http://127.0.0.1:${STAGING_PORT}/api/v1/map/initial`);
    expect(res.ok).toBe(true);
  }, 90_000);
});
