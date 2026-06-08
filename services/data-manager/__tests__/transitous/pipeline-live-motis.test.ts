/**
 * End-to-end Transitous pipeline against real `motis` + `motis-staging` Docker
 * containers, seeded with three tiny GTFS feeds (DE/CH/AT). Drives all 12 stages
 * so the previously-stubbed `assemble-staging`, `motis-import`, `motis-health`,
 * and `promote` paths actually exec MOTIS and observe the atomic swap — then
 * asserts the PRIMARY serves the promoted data (the real production goal).
 *
 * This exercises the real production layout: both containers bind-mount
 * pipeline-owned plain dirs (`data/motis/live`, `data/motis/staging`); the
 * pipeline assembles staging from the build output (`out/`), imports it in the
 * staging container, then atomically renames staging → live and restarts the
 * primary against it. There is no producer/hardlink indirection and no
 * `OPENMAPX_E9_STAGING_DIR` stub mirror — `assemble-staging` is the real thing.
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
 * Container lifecycle is owned by the test: each run starts with both containers
 * forcibly down, brings them up via a compose file generated into the test's tmp
 * dir, runs the pipeline, then tears everything down in `afterAll`. No reliance
 * on the operator's `infra/docker/data` tree.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// for real, ending in a direct HTTP probe of the promoted timetable.
const PRIMARY_SERVICE = "motis";
const PRIMARY_PORT = 8081;
// Generous wall-clock ceiling for the whole pipeline. It performs TWO MOTIS
// imports + boots on a cold-cache runner — the staging import (motis-import) and
// the primary's re-import on promote's `docker restart motis` — so a tight
// budget would flake on a correct-but-slow run. This is a sanity cap against a
// pathological hang, not a perf SLA.
const PIPELINE_BUDGET_MS = 4 * 60_000;
// Both containers pin `container_name` (motis / motis-staging) to mirror the
// generated production compose so the pipeline's bare-name `docker restart`
// resolves. This suite must therefore not run concurrently with itself — the
// fixed names would collide. CI serialises it via the workflow concurrency group.

const ORDERED_STAGES: StageName[] = [
  "prepare",
  "filter",
  "fetch",
  "validate",
  "gen-motis-config",
  "assemble-staging",
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
 * One MOTIS compose service mirroring the production manifests: pinned
 * `container_name` (the pipeline addresses it by bare name via the docker CLI),
 * a plain writable bind-mount of a pipeline-owned dir, and a wait-for-config
 * command so the container doesn't crash-loop on an empty dir before the
 * pipeline assembles/promotes one — exactly the manifests' command.
 */
function motisService(name: string, hostPort: number, hostDataDir: string): string[] {
  return [
    `  ${name}:`,
    `    image: ${MOTIS_IMAGE}`,
    `    container_name: ${name}`,
    "    working_dir: /motis-data",
    '    entrypoint: ["/bin/sh", "-c"]',
    '    command: ["until [ -f /motis-data/config.yml ]; do sleep 2; done; /motis import && /motis server || { echo failed; while true; do sleep 3600; done; }"]',
    "    ports:",
    `      - "127.0.0.1:${hostPort}:8080"`,
    "    volumes:",
    `      - ${hostDataDir}:/motis-data`,
    '    restart: "no"',
  ];
}

/**
 * Compose file with both the primary and staging MOTIS services, each bind-
 * mounting its pipeline-owned dir (`data/motis/live`, `data/motis/staging`).
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

async function probeOk(url: string, deadlineMs: number): Promise<boolean> {
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
 * Build a diagnostic string for a failed stage. The stage result only carries
 * the docker CLI error; the actual MOTIS import failure lives in the container's
 * logs. We fold both into the assertion message so CI shows the root cause inline
 * (the workflow's artifact upload can't help — the tmp dir is torn down in
 * `afterAll` before it runs).
 */
async function failureDiagnostics(
  label: string,
  service: string,
  message?: string,
): Promise<string> {
  const lines = [`${label}${message ? `: ${message}` : ""}`];
  try {
    const logs = await execa("docker", ["logs", "--tail", "80", service], { reject: false });
    if (logs.stdout) lines.push(`--- docker logs ${service} (stdout) ---`, logs.stdout);
    if (logs.stderr) lines.push(`--- docker logs ${service} (stderr) ---`, logs.stderr);
  } catch (err) {
    lines.push(`(could not fetch ${service} logs: ${(err as Error).message})`);
  }
  return lines.join("\n");
}

describeLive("transitous pipeline end-to-end against real motis containers", () => {
  let tmp: string | undefined;
  let composeFile: string | undefined;
  let dataDir: string | undefined;
  let imageAvailable = false;
  let daemonAvailable = false;
  let stagingDataDir: string | undefined;
  let motisDataDir: string | undefined;

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
    dataDir = join(tmp, `data-${process.pid}`);
    mkdirSync(dataDir, { recursive: true });
    // Pipeline-owned plain bind dirs, pre-created (host-owned) so docker doesn't
    // create them as root on first `up`. This mirrors the deploy step's
    // pre-create of writable `@infra:data/...` bind dirs.
    stagingDataDir = join(dataDir, "motis", "staging");
    motisDataDir = join(dataDir, "motis", "live");
    mkdirSync(stagingDataDir, { recursive: true });
    mkdirSync(motisDataDir, { recursive: true });

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

    // Catalog feed files: one per region, each referencing the matching fixture
    // zip via a `file://` url. `type: url` is what the stub fetch.py understands.
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

    composeFile = writeStagingCompose(dataDir, stagingDataDir, motisDataDir);
    // Clean slate. `compose down` only reaps containers in THIS run's project; a
    // crashed earlier run can leave pinned `motis`/`motis-staging` containers
    // under a different project that would collide with our `up`. Force-remove
    // them by name first — best effort, ignore "no such container".
    await execa("docker", ["rm", "-f", PRIMARY_SERVICE, STAGING_SERVICE], {
      stdio: "pipe",
    }).catch(() => {});
    await composeDown(composeFile, dataDir);
    // Bring BOTH containers up. They block in their wait-for-config loop (empty
    // dirs) until the pipeline assembles staging (motis-import restarts staging)
    // and promote swaps staging → live (then restarts the primary). The pipeline
    // only ever `docker restart`s these, never creates them — creation is the
    // deploy step's job, mirrored here.
    await execa("docker", ["compose", "-f", composeFile, "up", "-d"], {
      cwd: dataDir,
      stdio: "pipe",
    });
  }, 90_000);

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
    "runs all 12 stages, atomically swaps staging → live, and the primary serves the promoted data",
    async (testCtx) => {
      if (!daemonAvailable || !imageAvailable) {
        // beforeAll already logged the reason. Use vitest's `testCtx.skip()`
        // so CI surfaces a skip rather than a false-positive pass.
        testCtx.skip();
        return;
      }
      if (!dataDir || !stagingDataDir || !motisDataDir || !composeFile) {
        throw new Error("test setup did not complete");
      }

      const runner: CommandRunner = async (command, args, opts) => {
        if (command === "git") {
          // The stub catalog has a placeholder `.git`. Any git invocation (pull,
          // submodule update, reset, fetch, checkout) would fail against it; the
          // pipeline swallows pull failures but submodule update is
          // unconditional. Pretend every git call succeeded — the catalog tree
          // is already at the state we want.
          return;
        }
        await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "pipe" });
      };

      const ctx = buildJobContext({
        dataDir,
        store: new StateStore(dataDir),
        countries: ["de", "ch", "at"],
        runner,
        now: () => new Date().toISOString(),
      });

      const started = Date.now();
      const { results } = await runTransitousPipeline(ctx);
      const elapsed = Date.now() - started;

      expect(results.map((r) => r.stage)).toEqual(ORDERED_STAGES);
      const byStage = Object.fromEntries(results.map((r) => [r.stage, r]));

      // assemble-staging populated the staging mount from the build output (no
      // OPENMAPX_E9_STAGING_DIR stub mirror), so the previously-stubbed stages
      // now actually run. Assert "ok" (not "skipped") with container logs folded
      // into the message so the real MOTIS error surfaces inline on failure.
      expect(
        ["ok", "partial"].includes(byStage["assemble-staging"]?.status ?? ""),
        byStage["assemble-staging"]?.message ?? "assemble-staging",
      ).toBe(true);
      for (const stage of ["motis-import", "motis-health"] as const) {
        if (byStage[stage]?.status !== "ok") {
          const diag = await failureDiagnostics(stage, STAGING_SERVICE, byStage[stage]?.message);
          expect(byStage[stage]?.status, diag).toBe("ok");
        }
      }
      if (byStage.promote?.status !== "ok") {
        const diag = await failureDiagnostics("promote", PRIMARY_SERVICE, byStage.promote?.message);
        expect(byStage.promote?.status, diag).toBe("ok");
      }

      // The atomic swap happened on disk: live holds the imported timetable,
      // staging was recreated empty for the next cycle.
      expect(
        existsSync(join(motisDataDir, "data", "tt.bin")),
        "live data/tt.bin after promote",
      ).toBe(true);
      expect(existsSync(stagingDataDir)).toBe(true);

      // The real production goal: the PRIMARY (8081) serves the promoted data.
      // promote already polled it healthy before returning ok, so this confirms
      // the swapped-in dataset is what the live container is serving.
      const primaryUrl = `http://127.0.0.1:${PRIMARY_PORT}/api/v1/map/initial`;
      const primaryServes = await probeOk(primaryUrl, Date.now() + 30_000);
      if (!primaryServes) {
        const diag = await failureDiagnostics("primary serves promoted data", PRIMARY_SERVICE);
        expect(primaryServes, diag).toBe(true);
      }

      // Sanity cap only — see PIPELINE_BUDGET_MS. Two real MOTIS imports+boots,
      // so we don't assert a tight wall-clock; just guard against a hang.
      console.error(`E9 pipeline elapsed: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(PIPELINE_BUDGET_MS);
    },
    PIPELINE_BUDGET_MS + 30_000,
  );
});
