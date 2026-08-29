/**
 * End-to-end Transitous pipeline against real `motis` + `motis-staging` Docker
 * containers, seeded with three tiny GTFS feeds (DE/CH/AT). Drives all 14 stages
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
 *     so the default `pnpm test` invocation never spins up Docker. The pinned
 *     image canary remains a required weekly and manual release workflow.
 *   - `OPENMAPX_E9_LIVE_MOTIS=true` + Docker daemon reachable + the
 *     `ghcr.io/motis-project/motis:2.11.0` image already cached locally:
 *     the suite runs. If the image is missing we additionally `it.skip(...)`
 *     the actual probes with a clear log so a local run surfaces the missing
 *     prerequisite. The required workflow pre-pulls both images, so a missing
 *     image there is a hard failure rather than a skip.
 *
 * Container lifecycle is owned by the test: each run starts with both containers
 * forcibly down, brings them up via a compose file generated into the test's tmp
 * dir, runs the pipeline, then tears everything down in `afterAll`. No reliance
 * on the operator's `infra/docker/data` tree.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDepartures,
  getRoute,
  getRouteStops,
  getRoutesForStop,
  getRoutesInBbox,
  getStopPlatforms,
  getStops,
  getStopTimetable,
} from "@integrations/transit-motis/adapter";
import {
  motisLocalInstance,
  motisLocalReachabilityInstance,
  setMotisLocalUrl,
} from "@integrations/transit-motis/instances";
import {
  checkMotisReachabilityDestinations,
  getMotisReachabilitySeeds,
} from "@integrations/transit-motis/reachability";
import { transitousRunnerArgv } from "@openmapx/core/transitous-runner";
import { TRANSIT_WALK_PROFILE } from "@openmapx/mobility-core/transit-reachability";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readCandidateManifest } from "../../src/jobs/transitous/candidate.js";
import { buildJobContext, runTransitousPipeline } from "../../src/jobs/transitous/pipeline.js";
import { run as runPromote } from "../../src/jobs/transitous/promote.js";
import { TRANSIT_SOURCE_MANIFEST_FILENAME } from "../../src/jobs/transitous/source-manifest.js";
import type { CommandRunner, StageName } from "../../src/jobs/transitous/types.js";
import { StateStore } from "../../src/state.js";
import { buildTinyGtfsFeeds } from "./fixtures/build-tiny-gtfs.js";

const fixtureOpsState = vi.hoisted(() => ({
  gbfsLock: {
    commit: "1".repeat(40),
    url: "https://example.test/unconfigured-e9-registry.csv",
    sha256: "0".repeat(64),
    lockedAt: "2026-07-15T00:00:00.000Z",
    lockedBy: "e9-fixture",
  },
}));

// Production routes host mutations through the private operations agent. This
// isolated canary deliberately owns its four disposable containers, so model
// the same typed boundary while executing those narrowly-scoped effects against
// the fixture containers. Catalog pins are returned through the inspect
// operations exactly as they are in production; no production guard is bypassed.
vi.mock("../../src/ops-client.js", () => ({
  runOpsOperation: vi.fn(
    async (operation: { kind: string; candidateId?: string; preparedRunId?: string }) => {
      const { execa: run } = await import("execa");
      switch (operation.kind) {
        case "transitousLock.inspect":
          return {
            active: {
              ref: `main@${"a".repeat(40)}`,
              submodules: {},
              lockedAt: "2026-07-15T00:00:00.000Z",
              lockedBy: "e9-fixture",
            },
            proposed: null,
          };
        case "gbfsCatalogLock.inspect":
          return { ...fixtureOpsState.gbfsLock };
        case "motis.staging.restart":
          await run("docker", ["restart", "motis-staging"], { stdio: "pipe" });
          return { changed: true };
        case "motis.staging.stop":
          await run("docker", ["stop", "motis-staging"], { reject: false, stdio: "pipe" });
          return { changed: true };
        case "motis.primary.promote":
          await run("docker", ["restart", "motis"], { stdio: "pipe" });
          return { activeRunId: operation.preparedRunId };
        case "feedProxy.validateAndReload":
          await run("docker", ["exec", "motis-feed-proxy", "nginx", "-t"], { stdio: "pipe" });
          await run("docker", ["exec", "motis-feed-proxy", "nginx", "-s", "reload"], {
            stdio: "pipe",
          });
          return { candidateId: operation.candidateId, reloaded: true };
        default:
          throw new Error(`Unexpected E9 ops operation: ${operation.kind}`);
      }
    },
  ),
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_SCRIPTS_DIR = resolve(HERE, "fixtures", "stub-catalog-scripts");

const LIVE = process.env.OPENMAPX_E9_LIVE_MOTIS === "true";
const describeLive = LIVE ? describe : describe.skip;

const MOTIS_IMAGE = "ghcr.io/motis-project/motis:2.11.0";
const STAGING_SERVICE = "motis-staging";
const STAGING_PORT = 8082;
// The promote stage restarts the primary `motis` container (`docker restart
// motis`) and polls it at MOTIS_URL (default localhost:8081) after the atomic
// swap. The canary runs a primary alongside staging so that path is exercised
// for real, ending in a direct HTTP probe of the promoted timetable.
const PRIMARY_SERVICE = "motis";
const PRIMARY_PORT = 8081;
const FEED_PROXY_SERVICE = "motis-feed-proxy";
const GBFS_FIXTURE_SERVICE = "gbfs-fixture";
const GBFS_FIXTURE_PORT = 18_083;
// The existing human-readable XML is the source of this 400-byte PBF. MOTIS
// 2.11's street importer accepts OSM PBF only; keeping the tiny generated
// artifact as base64 avoids committing an opaque binary fixture.
const BERLIN_TINY_OSM_PBF_BASE64 =
  "AAAADQoJT1NNSGVhZGVyGFUQSBpReJzjkuJoWLR3RbJAw7I37SkSDd9OHW5nVmjY8nlyO7MSn39xbnByRmpuom6YgZ6ZEpdLal5xql9+SmpxEyNvfnFuZmmuvqGeoaWeAQAnRhqIAAAACwoHT1NNRGF0YRhoENcBGmN4nONi4WLgYhA6xyh0mpFLgAkK2KC0VhSXACMaEBJgQANSGCJKGCJaAkxoIk5iC7Z//cIM5f3/wAJleRk2TJ9T37BVYsE/rgfbeA/M4gGiBe/5Hxzl+H85Eat4EIZ1APJ9I7YAAAAMCgdPU01EYXRhGJ0BEOgBGpcBeJzjyuBi4GLPyEzPKE+s5GLJS8xN5eIuSi3OTEnNK8lMzOHid7VU8MsvKslQCC4pSk0tASoHCQXnlyKEBIEC4anFJQrO+Xl5qckl+UVgIddEZCGhGikFjlQhJkYmKSZmFiUuDkYBBgkGBQYNVicOJigAqkiDqmBDVSEGUyHFkQ5VwY6igolNBCiXAZXjQJXjEwEA2NEpHA==";
// Generous wall-clock ceiling for the whole lifecycle scenario. It performs a
// successful promotion, imports a deliberately rejected candidate, and then
// performs a second successful promotion, so a tight budget would flake on a
// correct-but-slow cold-cache runner. This is a sanity cap, not a perf SLA.
const LIVE_SCENARIO_BUDGET_MS = 12 * 60_000;
// Both containers pin `container_name` (motis / motis-staging) to mirror the
// generated production compose so the pipeline's bare-name `docker restart`
// resolves. This suite must therefore not run concurrently with itself — the
// fixed names would collide. CI serialises it via the workflow concurrency group.

const ORDERED_STAGES: StageName[] = [
  "prepare",
  "filter",
  "preflight",
  "compile-gbfs",
  "fetch",
  "validate",
  "gen-full-config",
  "gen-attribution",
  "assemble-staging",
  "stage-proxy",
  "motis-import",
  "motis-health",
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
    "    extra_hosts:",
    '      - "rt.triptix.tech:127.0.0.1"',
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
  gbfsFixtureDir: string,
): string {
  const composeFile = join(dataDir, "docker-compose.yml");
  const yaml = [
    "services:",
    ...motisService(STAGING_SERVICE, STAGING_PORT, stagingDataDir),
    ...motisService(PRIMARY_SERVICE, PRIMARY_PORT, motisDataDir),
    `  ${FEED_PROXY_SERVICE}:`,
    "    image: nginx:1.27-alpine",
    `    container_name: ${FEED_PROXY_SERVICE}`,
    "    volumes:",
    `      - ${join(dataDir, "motis-feed-proxy", "conf")}:/etc/nginx/conf.d`,
    "    extra_hosts:",
    '      - "rt.triptix.tech:127.0.0.1"',
    '    restart: "no"',
    `  ${GBFS_FIXTURE_SERVICE}:`,
    "    image: nginx:1.27-alpine",
    `    container_name: ${GBFS_FIXTURE_SERVICE}`,
    "    ports:",
    `      - "${GBFS_FIXTURE_PORT}:80"`,
    "    volumes:",
    `      - ${gbfsFixtureDir}:/usr/share/nginx/html:ro`,
    '    restart: "no"',
    "",
  ].join("\n");
  writeFileSync(composeFile, yaml);
  return composeFile;
}

function writeTinyGbfsFixture(directory: string, base: string): void {
  mkdirSync(directory, { recursive: true });
  const writeJson = (name: string, value: unknown): void =>
    writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
  const timestamp = Math.floor(Date.now() / 1_000);
  writeJson("gbfs.json", {
    last_updated: timestamp,
    ttl: 60,
    version: "2.3",
    data: {
      en: {
        feeds: [
          { name: "system_information", url: `${base}/system_information.json` },
          { name: "station_information", url: `${base}/station_information.json` },
          { name: "station_status", url: `${base}/station_status.json` },
          { name: "vehicle_types", url: `${base}/vehicle_types.json` },
          { name: "geofencing_zones", url: `${base}/geofencing_zones.json` },
        ],
      },
    },
  });
  writeJson("system_information.json", {
    last_updated: timestamp,
    ttl: 60,
    version: "2.3",
    data: {
      system_id: "openmapx-e9-rentals",
      language: "en",
      name: "OpenMapX E9 Rentals",
      operator: "OpenMapX test fixture",
      timezone: "Europe/Berlin",
      license_id: "CC0-1.0",
      url: "https://openmapx.example.test/e9",
    },
  });
  writeJson("vehicle_types.json", {
    last_updated: timestamp,
    ttl: 60,
    version: "2.3",
    data: {
      vehicle_types: [
        {
          vehicle_type_id: "bike",
          form_factor: "bicycle",
          propulsion_type: "human",
          return_constraint: "any_station",
        },
      ],
    },
  });
  writeJson("station_information.json", {
    last_updated: timestamp,
    ttl: 60,
    version: "2.3",
    data: {
      stations: [
        {
          station_id: "e9-station",
          name: "E9 Hauptbahnhof Bikes",
          lat: 52.525,
          lon: 13.369,
          capacity: 8,
          rental_uris: { web: "https://openmapx.example.test/rent/e9-station" },
          vehicle_type_capacity: { bike: 8 },
        },
      ],
    },
  });
  writeJson("station_status.json", {
    last_updated: timestamp,
    ttl: 60,
    version: "2.3",
    data: {
      stations: [
        {
          station_id: "e9-station",
          num_vehicles_available: 2,
          vehicle_types_available: [{ vehicle_type_id: "bike", count: 2 }],
          num_docks_available: 6,
          vehicle_docks_available: [{ vehicle_type_ids: ["bike"], count: 6 }],
          is_installed: true,
          is_renting: true,
          is_returning: true,
          last_reported: timestamp,
        },
      ],
    },
  });
  writeJson("geofencing_zones.json", {
    last_updated: timestamp,
    ttl: 60,
    version: "2.3",
    data: {
      geofencing_zones: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "MultiPolygon",
              coordinates: [
                [
                  [
                    [13.36, 52.51],
                    [13.39, 52.51],
                    [13.39, 52.54],
                    [13.36, 52.54],
                    [13.36, 52.51],
                  ],
                ],
              ],
            },
            properties: {
              name: "E9 service area",
              rules: [
                {
                  vehicle_type_ids: ["bike"],
                  ride_allowed: true,
                  ride_through_allowed: true,
                  maximum_speed_kph: 15,
                  station_parking: true,
                },
              ],
            },
          },
        ],
      },
    },
  });
}

function dockerReachableHostAddress(): string {
  const interfaces = networkInterfaces();
  const preferredNames = ["en0", "eth0", ...Object.keys(interfaces).sort()];
  for (const name of preferredNames) {
    const address = interfaces[name]?.find(
      (candidate) => candidate.family === "IPv4" && !candidate.internal,
    )?.address;
    if (address) return address;
  }
  throw new Error("E9 fixture could not find a non-loopback IPv4 address reachable from Docker");
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

function civilDate(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Build a diagnostic string for a failed stage. The stage result only carries
 * the docker CLI error; the actual MOTIS import failure lives in the container's
 * logs. We fold both into the assertion message so CI shows the root cause inline.
 * On GitHub Actions, the temporary directory is retained until the workflow's
 * artifact upload step runs, and `afterAll` writes a bounded container-log
 * snapshot there before teardown; local executions still clean it up.
 */
async function failureDiagnostics(
  label: string,
  service: string,
  message?: string,
): Promise<string> {
  const lines = [`${label}${message ? `: ${message}` : ""}`];
  try {
    const logs = await execa("docker", ["logs", "--tail", "200", service], { reject: false });
    if (logs.stdout) lines.push(`--- docker logs ${service} (stdout) ---`, logs.stdout);
    if (logs.stderr) lines.push(`--- docker logs ${service} (stderr) ---`, logs.stderr);
  } catch (err) {
    lines.push(`(could not fetch ${service} logs: ${(err as Error).message})`);
  }
  // Container-side view of the mount MOTIS imports from. On an import failure the
  // container entrypoint drops into a keep-alive sleep (see motisService), so
  // `exec` still works — this shows the archive sizes MOTIS itself sees, which
  // reveals a hardlink/bind-mount that resolved to an empty or unreadable file.
  try {
    const view = await execa("docker", ["exec", service, "sh", "-c", "ls -la /motis-data"], {
      reject: false,
    });
    if (view.stdout) lines.push(`--- ${service}:/motis-data (container view) ---`, view.stdout);
    if (view.exitCode !== 0 && view.stderr)
      lines.push(`--- ${service} exec stderr ---`, view.stderr);
  } catch (err) {
    lines.push(`(could not inspect ${service}:/motis-data: ${(err as Error).message})`);
  }
  return lines.join("\n");
}

/**
 * Host-side view of the assembled staging dir: entry names, byte sizes, and
 * whether each `*.zip` still opens with a valid local-file-header magic
 * (`PK\x03\x04`). This distinguishes the two very different roots of a MOTIS
 * import `iostream error`: assemble-staging produced a bad/zero-byte archive
 * (the host sees it broken) vs. the container can't read a structurally-valid
 * archive the host sees intact (a bind-mount/hardlink visibility problem on the
 * runner's storage driver).
 */
function stagingDirReport(dir: string): string {
  const lines = [`--- host view of staging dir ${dir} ---`];
  try {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          lines.push(`  ${name}/  (dir)`);
          continue;
        }
        let note = "";
        if (name.endsWith(".zip")) {
          const head = readFileSync(p).subarray(0, 4);
          const ok = head[0] === 0x50 && head[1] === 0x4b; // "PK"
          note = ok
            ? "  zip-magic OK"
            : `  BAD zip-magic <${[...head].map((b) => b.toString(16).padStart(2, "0")).join(" ")}>`;
        }
        lines.push(`  ${name}  ${st.size}B${note}`);
      } catch (err) {
        lines.push(`  ${name}  (stat failed: ${(err as Error).message})`);
      }
    }
  } catch (err) {
    lines.push(`  (could not read staging dir: ${(err as Error).message})`);
  }
  return lines.join("\n");
}

async function writeCiDiagnostics(tmpDir: string, stagingDir: string): Promise<void> {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const diagnostics = await Promise.all(
    [STAGING_SERVICE, PRIMARY_SERVICE].map((service) =>
      failureDiagnostics(`CI container diagnostics for ${service}`, service),
    ),
  );
  try {
    writeFileSync(
      join(tmpDir, "motis-container-diagnostics.log"),
      `${diagnostics.join("\n")}\n${stagingDirReport(stagingDir)}\n`,
      "utf-8",
    );
  } catch {
    // Diagnostics must never hide the original test result or block cleanup.
  }
}

describeLive("transitous pipeline end-to-end against real motis containers", () => {
  let tmp: string | undefined;
  let composeFile: string | undefined;
  let dataDir: string | undefined;
  let imageAvailable = false;
  let daemonAvailable = false;
  let stagingDataDir: string | undefined;
  let motisDataDir: string | undefined;
  let gbfsFixtureDir: string | undefined;
  let gbfsBaseUrl = "";
  let gbfsRegistryCsv = "";

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

    // The canary's three tiny GTFS feeds import in seconds, so the pipeline's
    // production-scale health waits — 30 min for staging (motis-health) and
    // 20 min for the primary after the swap (promote) — dwarf this test's 12 min
    // scenario budget. Left at their defaults, ANY failure to become healthy manifests
    // as an opaque "Test timed out" with the pipeline still mid-poll: the
    // `failureDiagnostics` calls below (which fold `docker logs motis-staging`
    // into the assertion message) never run, so CI shows a bare timeout with no
    // container logs. Cap both waits well under the test timeout so a broken
    // staging/primary fails fast WITH diagnostics. Respect an explicit override.
    process.env.MOTIS_IMPORT_TIMEOUT_MS ??= "300000";
    process.env.MOTIS_PROMOTE_RESTART_TIMEOUT_MS ??= "120000";
    process.env.MOTIS_HEALTH_PLAN_FROM_LAT ??= "52.525";
    process.env.MOTIS_HEALTH_PLAN_FROM_LNG ??= "13.369";
    process.env.MOTIS_HEALTH_PLAN_TO_LAT ??= "52.521";
    process.env.MOTIS_HEALTH_PLAN_TO_LNG ??= "13.413";

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
    mkdirSync(join(dataDir, "motis-feed-proxy", "conf"), { recursive: true });
    // MOTIS runs as `uid=100(motis)` and imports IN PLACE — it writes the compiled
    // timetable (`data/tt.bin`, …) into the mounted dir. On a native Linux bind
    // mount (CI) these dirs stay owned by the host runner user (uid 1001, mode
    // 755), so the container's `motis` user can't write and `motis import` dies
    // with "basic_ios::clear: iostream error". macOS Docker Desktop hides this by
    // remapping bind-mount ownership to the container user; production's deploy
    // step pre-creates the bind dirs container-writable. Replicate that here so a
    // real cross-uid write is possible — otherwise the canary fails on the runner
    // for a reason that never reaches production.
    chmodSync(stagingDataDir, 0o777);
    chmodSync(motisDataDir, 0o777);

    // Build the tiny GTFS fixtures into a sibling dir so the catalog's
    // file:// urls can reference them without leaking host-specific paths
    // into the catalog's own working tree.
    const fixturesDir = join(tmp, "tiny-gtfs");
    const built = await buildTinyGtfsFeeds(fixturesDir);
    gbfsFixtureDir = join(tmp, "tiny-gbfs");
    gbfsBaseUrl = `http://${dockerReachableHostAddress()}:${GBFS_FIXTURE_PORT}`;
    writeTinyGbfsFixture(gbfsFixtureDir, gbfsBaseUrl);

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

    // Tiny OSM extract covering the Berlin fixture area. The stub config
    // generator copies it into `out/` and enables `street_routing` — MOTIS 2.x
    // hard-refuses a config with a `gbfs:` section unless street routing (and
    // therefore an OSM PBF input) is enabled.
    writeFileSync(
      join(catalogDir, "berlin-tiny.osm.pbf"),
      Buffer.from(BERLIN_TINY_OSM_PBF_BASE64, "base64"),
    );

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

    // The versioned overlay remains available for operator patches/quarantine;
    // the E9 feed itself is injected by the pinned registry compiler below.
    const feedsOverlayPath = join(dataDir, "feeds-overlay.json");
    writeFileSync(
      feedsOverlayPath,
      `${JSON.stringify(
        {
          version: 3,
          sources: [],
          patches: [],
          quarantine: [],
        },
        null,
        2,
      )}\n`,
    );

    const registryCommit = "1".repeat(40);
    gbfsRegistryCsv =
      `Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL\n` +
      `DE,OpenMapX E9 Rentals,Berlin,openmapx-e9-rentals,https://openmapx.example.test/e9,${gbfsBaseUrl}/gbfs.json,2.3,\n`;
    fixtureOpsState.gbfsLock.url = `https://raw.githubusercontent.com/MobilityData/gbfs/${registryCommit}/systems.csv`;
    fixtureOpsState.gbfsLock.sha256 = createHash("sha256").update(gbfsRegistryCsv).digest("hex");
    mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
    writeFileSync(
      join(tmp, "infra", "docker", "gbfs-catalog.lock.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          source: "mobilitydata-gbfs",
          commit: registryCommit,
          url: `https://raw.githubusercontent.com/MobilityData/gbfs/${registryCommit}/systems.csv`,
          sha256: createHash("sha256").update(gbfsRegistryCsv).digest("hex"),
          lockedAt: "2026-07-15T00:00:00.000Z",
          lockedBy: "e9-fixture",
        },
        null,
        2,
      )}\n`,
    );

    composeFile = writeStagingCompose(dataDir, stagingDataDir, motisDataDir, gbfsFixtureDir);
    // Clean slate. `compose down` only reaps containers in THIS run's project; a
    // crashed earlier run can leave pinned `motis`/`motis-staging` containers
    // under a different project that would collide with our `up`. Force-remove
    // them by name first — best effort, ignore "no such container".
    await execa(
      "docker",
      ["rm", "-f", PRIMARY_SERVICE, STAGING_SERVICE, FEED_PROXY_SERVICE, GBFS_FIXTURE_SERVICE],
      { stdio: "pipe" },
    ).catch(() => {});
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
    if (tmp && stagingDataDir) await writeCiDiagnostics(tmp, stagingDataDir);
    if (composeFile && dataDir) await composeDown(composeFile, dataDir);
    if (tmp && process.env.GITHUB_ACTIONS !== "true") {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // Tmp on macOS occasionally throws on already-removed entries; ignore.
      }
    }
  }, 60_000);

  it(
    "imports, queries, rejects a bad candidate, promotes a new epoch, and rejects stale IDs",
    async (testCtx) => {
      if (!daemonAvailable || !imageAvailable) {
        // beforeAll already logged the reason. Use vitest's `testCtx.skip()`
        // so CI surfaces a skip rather than a false-positive pass.
        testCtx.skip();
        return;
      }
      if (!dataDir || !stagingDataDir || !motisDataDir || !composeFile || !gbfsFixtureDir || !tmp) {
        throw new Error("test setup did not complete");
      }
      const fixtureDataDir = dataDir;
      const fixtureRepoRoot = tmp;
      const fixtureCatalogDir = join(fixtureDataDir, ".transitous-catalog");

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

      const makeContext = () =>
        buildJobContext({
          dataDir: fixtureDataDir,
          repoRoot: fixtureRepoRoot,
          store: new StateStore(fixtureDataDir),
          countries: ["de", "ch", "at"],
          feedsOverlayPath: join(fixtureDataDir, "feeds-overlay.json"),
          runner,
          // Exercise the same closed typed argv mapping as the private runner,
          // but execute the fixture's harmless Python scripts in-process. The
          // test checkout contains only these four purpose-built stubs.
          runScript: async (run) => {
            await execa("python3", transitousRunnerArgv(run), {
              cwd: fixtureCatalogDir,
              stdio: "pipe",
            });
          },
          now: () => new Date().toISOString(),
        });
      const runFixturePipeline = async (
        ctx: ReturnType<typeof makeContext>,
        options?: Parameters<typeof runTransitousPipeline>[1],
      ) => {
        const nativeFetch = globalThis.fetch;
        const oldCatalogEnabled = process.env.MOTIS_GBFS_CATALOG_ENABLED;
        const oldMaxAdditions = process.env.MOTIS_GBFS_CATALOG_MAX_ADDITIONS;
        const oldPrivateFeedHosts = process.env.OPENMAPX_ALLOW_PRIVATE_FEED_HOSTS;
        const privateFeedHosts = new Set(
          (oldPrivateFeedHosts ?? "")
            .split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        );
        // safeFetchJson validates DNS before invoking fetch. This fixture host
        // exists only on the Docker network, so explicitly declare it for the
        // test while preserving any operator-provided allowlist entries.
        privateFeedHosts.add(new URL(gbfsBaseUrl).hostname);
        process.env.MOTIS_GBFS_CATALOG_ENABLED = "true";
        process.env.MOTIS_GBFS_CATALOG_MAX_ADDITIONS = "5";
        process.env.OPENMAPX_ALLOW_PRIVATE_FEED_HOSTS = [...privateFeedHosts].join(",");
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("raw.githubusercontent.com/MobilityData/gbfs/")) {
            return new Response(gbfsRegistryCsv, { headers: { "content-type": "text/csv" } });
          }
          if (url.startsWith(`${gbfsBaseUrl}/`)) {
            const filename = new URL(url).pathname.slice(1);
            return new Response(readFileSync(join(gbfsFixtureDir as string, filename)), {
              headers: { "content-type": "application/json" },
            });
          }
          return nativeFetch(input, init);
        }) as typeof fetch;
        try {
          return await runTransitousPipeline(ctx, options);
        } finally {
          globalThis.fetch = nativeFetch;
          if (oldCatalogEnabled === undefined) delete process.env.MOTIS_GBFS_CATALOG_ENABLED;
          else process.env.MOTIS_GBFS_CATALOG_ENABLED = oldCatalogEnabled;
          if (oldMaxAdditions === undefined) delete process.env.MOTIS_GBFS_CATALOG_MAX_ADDITIONS;
          else process.env.MOTIS_GBFS_CATALOG_MAX_ADDITIONS = oldMaxAdditions;
          if (oldPrivateFeedHosts === undefined)
            delete process.env.OPENMAPX_ALLOW_PRIVATE_FEED_HOSTS;
          else process.env.OPENMAPX_ALLOW_PRIVATE_FEED_HOSTS = oldPrivateFeedHosts;
        }
      };

      const started = Date.now();
      const firstCtx = makeContext();
      const { results } = await runFixturePipeline(firstCtx);

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
      for (const stage of ["stage-proxy", "motis-import", "motis-health"] as const) {
        if (byStage[stage]?.status !== "ok") {
          const diag = await failureDiagnostics(stage, STAGING_SERVICE, byStage[stage]?.message);
          expect(byStage[stage]?.status, `${diag}\n${stagingDirReport(stagingDataDir)}`).toBe("ok");
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

      // The immutable active source manifest contains every tiny GTFS source
      // that was selected, acquired, imported, and promoted with this epoch.
      const firstCandidate = readCandidateManifest(motisDataDir);
      expect(firstCandidate.epoch).toBe(firstCtx.jobId);
      const capabilitySnapshot = JSON.parse(
        readFileSync(join(motisDataDir, "mobility-capabilities.json"), "utf-8"),
      ) as {
        reachability?: {
          hasStreetRouting?: boolean;
          oneToManyIntermodalVerified?: boolean;
          maxOneToManySize?: number;
        };
      };
      expect(capabilitySnapshot.reachability).toMatchObject({
        hasStreetRouting: true,
        oneToManyIntermodalVerified: true,
      });
      expect(capabilitySnapshot.reachability?.maxOneToManySize ?? 0).toBeGreaterThan(0);
      const liveSourceManifestPath = join(motisDataDir, TRANSIT_SOURCE_MANIFEST_FILENAME);
      const firstSourceManifestText = readFileSync(liveSourceManifestPath, "utf-8");
      const firstSourceManifest = JSON.parse(firstSourceManifestText) as {
        version: number;
        sources: Array<{ sourceId: string; artifact: { sizeBytes: number; sha256: string } }>;
      };
      expect(firstSourceManifest.version).toBe(1);
      expect(firstSourceManifest.sources.map((source) => source.sourceId)).toEqual([
        "catalog:at:demo",
        "catalog:ch:demo",
        "catalog:de:demo",
      ]);
      expect(
        firstSourceManifest.sources.every(
          (source) => source.artifact.sizeBytes > 0 && source.artifact.sha256.length === 64,
        ),
      ).toBe(true);

      // The real production goal: the PRIMARY (8081) serves the promoted data.
      // promote already polled it healthy before returning ok, so this confirms
      // the swapped-in dataset is what the live container is serving.
      const primaryUrl = `http://127.0.0.1:${PRIMARY_PORT}/api/v1/map/initial`;
      const primaryServes = await probeOk(primaryUrl, Date.now() + 30_000);
      if (!primaryServes) {
        const diag = await failureDiagnostics("primary serves promoted data", PRIMARY_SERVICE);
        expect(primaryServes, diag).toBe(true);
      }

      // Exercise the product adapter against the live pinned server, not a
      // mocked response: stop/departure lookup, platform normalization,
      // civil-day timetable, map/routes, and experimental route-details.
      setMotisLocalUrl(`http://127.0.0.1:${PRIMARY_PORT}`);
      const berlinStops = await getStops(motisLocalInstance, [13.3, 52.49, 13.46, 52.54]);
      expect(berlinStops.length).toBeGreaterThanOrEqual(4);
      const hbfPlatform = berlinStops.find(
        (stop) => stop.name === "Berlin Hauptbahnhof" && stop.platformCode === "1",
      );
      expect(hbfPlatform, JSON.stringify(berlinStops, null, 2)).toMatchObject({
        platformCode: "1",
      });
      expect(hbfPlatform?.parentStationId).toBeTruthy();
      const queryTime = new Date();
      queryTime.setUTCSeconds(0, 0);
      const reachabilityQuery = {
        origin: { lng: 13.369, lat: 52.525 },
        queryTime: queryTime.toISOString(),
        direction: "depart-at" as const,
        thresholdsMinutes: [90],
        walkProfileId: TRANSIT_WALK_PROFILE.id,
      };
      const reachabilitySeeds = await getMotisReachabilitySeeds(
        motisLocalInstance,
        reachabilityQuery,
      );
      expect(reachabilitySeeds.length).toBeGreaterThan(0);
      const exactReachability = await checkMotisReachabilityDestinations(
        motisLocalReachabilityInstance,
        {
          ...reachabilityQuery,
          destinations: [
            {
              id: "berlin-hbf",
              lng: hbfPlatform?.lng ?? 13.369,
              lat: hbfPlatform?.lat ?? 52.525,
            },
          ],
        },
        capabilitySnapshot.reachability?.maxOneToManySize ?? 1,
      );
      expect(exactReachability.results).toEqual([
        expect.objectContaining({ id: "berlin-hbf", reachable: true }),
      ]);
      const platforms = await getStopPlatforms(motisLocalInstance, hbfPlatform?.id ?? "");
      expect(platforms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: hbfPlatform?.id, platformCode: "1" }),
        ]),
      );
      const departures = await getDepartures(motisLocalInstance, hbfPlatform?.id ?? "", 24 * 60, {
        datasetEpoch: firstCandidate.epoch,
      });
      expect(departures.length).toBeGreaterThan(0);
      expect(departures[0]?.platform ?? departures[0]?.scheduledPlatform).toBe("1");
      const timetable = await getStopTimetable(
        motisLocalInstance,
        hbfPlatform?.id ?? "",
        civilDate("Europe/Berlin"),
        firstCandidate.epoch,
      );
      const timetableDiagnostic =
        timetable.length === 0 && hbfPlatform
          ? await fetch(
              `http://127.0.0.1:${PRIMARY_PORT}/api/v1/stoptimes?stopId=${encodeURIComponent(hbfPlatform.id.slice(3))}&n=0&window=0`,
            ).then((response) => response.text())
          : "";
      expect(timetable.length, timetableDiagnostic).toBeGreaterThan(0);
      expect(
        timetable.every((entry) => entry.provenance?.datasetEpoch === firstCandidate.epoch),
      ).toBe(true);

      const firstRoutes = await getRoutesInBbox(
        motisLocalInstance,
        [13.3, 52.49, 13.46, 52.54],
        firstCandidate.epoch,
        11,
      );
      expect(firstRoutes.length).toBeGreaterThan(0);
      const firstPattern = firstRoutes.find((route) => route.shortName === "S1") ?? firstRoutes[0];
      expect(firstPattern?.id).toMatch(/^ms:rp:/);
      expect(firstPattern?.geometry).toBeDefined();
      const routeDetail = await getRoute(
        motisLocalInstance,
        firstPattern?.id ?? "",
        firstCandidate.epoch,
      );
      expect(routeDetail?.geometry).toBeDefined();
      const orderedStops = await getRouteStops(
        motisLocalInstance,
        firstPattern?.id ?? "",
        firstCandidate.epoch,
      );
      expect(orderedStops.map((stop) => stop.name)).toEqual(
        expect.arrayContaining([
          "Berlin Zoologischer Garten",
          "Berlin Hauptbahnhof",
          "Berlin Alexanderplatz",
          "Berlin Ostbahnhof",
        ]),
      );
      expect(orderedStops).toHaveLength(4);

      // Calendar-independent routes-for-stop via the tiny zoom-11 bbox probe:
      // the pattern serving Hauptbahnhof must be discoverable from the stop
      // itself, with the same epoch-bound pattern identity.
      const routesAtHbf = await getRoutesForStop(
        motisLocalInstance,
        hbfPlatform?.id ?? "",
        firstCandidate.epoch,
      );
      expect(routesAtHbf.map((route) => route.id)).toContain(firstPattern?.id);

      // Build and import a second candidate, then corrupt one hashed artifact
      // before promotion. The promotion must fail closed without changing the
      // live epoch or immutable source manifest.
      const failedCtx = makeContext();
      const failedBuild = await runFixturePipeline(failedCtx, { stopAt: "motis-health" });
      expect(failedBuild.results.at(-1)).toMatchObject({ stage: "motis-health", status: "ok" });
      const failedCandidate = readCandidateManifest(stagingDataDir);
      expect(failedCandidate.epoch).toBe(failedCtx.jobId);
      expect(failedCandidate.epoch).not.toBe(firstCandidate.epoch);
      const stagedSourceManifestPath = join(stagingDataDir, TRANSIT_SOURCE_MANIFEST_FILENAME);
      writeFileSync(
        stagedSourceManifestPath,
        `${readFileSync(stagedSourceManifestPath, "utf-8")} `,
      );
      const failedPromotion = await runPromote(failedCtx);
      expect(failedPromotion.status).toBe("error");
      expect(failedPromotion.message).toMatch(/Candidate artifact hash mismatch/);
      expect(readCandidateManifest(motisDataDir).epoch).toBe(firstCandidate.epoch);
      expect(readFileSync(liveSourceManifestPath, "utf-8")).toBe(firstSourceManifestText);
      expect(await probeOk(primaryUrl, Date.now() + 10_000)).toBe(true);

      // A later healthy candidate is promoted with a fresh epoch. IDs minted
      // from the first epoch are rejected before route-details is queried.
      const secondCtx = makeContext();
      const secondRun = await runFixturePipeline(secondCtx);
      expect(secondRun.results.find((result) => result.stage === "promote")?.status).toBe("ok");
      const secondCandidate = readCandidateManifest(motisDataDir);
      expect(secondCandidate.epoch).toBe(secondCtx.jobId);
      expect(secondCandidate.epoch).not.toBe(firstCandidate.epoch);
      expect(
        await getRoute(motisLocalInstance, firstPattern?.id ?? "", secondCandidate.epoch),
      ).toBeNull();
      expect(readFileSync(liveSourceManifestPath, "utf-8")).toContain("catalog:de:demo");

      const rentalsResponse = await fetch(
        `http://127.0.0.1:${PRIMARY_PORT}/api/v1/rentals?min=52.51,13.35&max=52.54,13.40&withProviders=true&withStations=true&withVehicles=true&withZones=true`,
      );
      expect(rentalsResponse.ok).toBe(true);
      const rentals = (await rentalsResponse.json()) as {
        providers?: unknown[];
        stations?: unknown[];
        zones?: unknown[];
      };
      expect(rentals.providers?.length ?? 0).toBeGreaterThan(0);
      expect(rentals.stations?.length ?? 0).toBeGreaterThan(0);
      expect(rentals.zones?.length ?? 0).toBeGreaterThan(0);
      expect(existsSync(join(motisDataDir, "gbfs-source-index.json"))).toBe(true);

      const proxyLogs = await execa("docker", ["logs", FEED_PROXY_SERVICE], { reject: false });
      expect(`${proxyLogs.stdout}\n${proxyLogs.stderr}`).toContain("/gbfs.json");
      expect(`${proxyLogs.stdout}\n${proxyLogs.stderr}`).toContain("/station_status.json");
      expect(readFileSync(join(motisDataDir, "config.yml"), "utf-8")).not.toContain(
        "rt.triptix.tech",
      );

      // Sanity cap only — see LIVE_SCENARIO_BUDGET_MS. Multiple real MOTIS
      // imports and boots run here, so only guard against a pathological hang.
      const elapsed = Date.now() - started;
      console.error(`E9 live MOTIS lifecycle elapsed: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(LIVE_SCENARIO_BUDGET_MS);
    },
    LIVE_SCENARIO_BUDGET_MS + 30_000,
  );
});
