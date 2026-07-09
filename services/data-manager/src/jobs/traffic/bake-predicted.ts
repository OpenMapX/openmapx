import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { envString } from "../../utils/env.js";
import {
  DEFAULT_VALHALLA_CONFIG_PATH,
  type DockerRunner,
  type DockerRunResult,
  type EnsureTrafficExtractResult,
  ensureTrafficExtract as ensureTrafficExtractDefault,
  resolveContainer,
} from "./ensure-extract.js";
import { encodePredictedSpeeds, expandHourlyToBuckets } from "./predicted-encode.js";
import {
  loadWaysToEdges as loadWaysToEdgesDefault,
  type RefreshWaysToEdgesResult,
  refreshWaysToEdges as refreshWaysToEdgesDefault,
  type WayEdge,
} from "./ways-to-edges.js";

/**
 * Bakes OpenConditions' predicted-speed profiles into Valhalla's loose graph
 * tiles via `valhalla_add_predicted_traffic`, then rebuilds everything that
 * tool invalidates downstream (the `traffic.tar` live extract and the
 * way-to-edge map) before restarting Valhalla to pick it all up.
 *
 * Two DISTINCT tileid representations are in play, source-verified against
 * real staging tiles:
 * - A CSV row's `edge_id` column is the GraphId in RAW `level/tileid/index`
 *   string form, e.g. `0/3198/5`.
 * - The per-tile CSV FILE PATH the tool reads is keyed by Valhalla's
 *   `FileSuffix` — the SAME tileid, zero-padded and `/`-split (`tileSuffix`
 *   below), e.g. tile 3198 level 0 lives at `<csvdir>/0/003/198.csv`. The
 *   tool derives which tile a row belongs to FROM the file path it was read
 *   from, not from the row content — rows written to the wrong file are
 *   silently skipped by the tool, so this grouping must be exact.
 */

/** Hard-coded compile-time hierarchy tile sizes (degrees) Valhalla ships with. */
const TILE_SIZE_DEGREES_BY_LEVEL: Record<number, number> = { 0: 4, 1: 1, 2: 0.25 };

/** Container-visible directory `valhalla_add_predicted_traffic` reads the per-tile CSVs from. */
const PREDICTED_CSV_CONTAINER_DIR = "/custom_files/predicted-csv";

function tileCountForLevel(level: number): number {
  const size = TILE_SIZE_DEGREES_BY_LEVEL[level];
  if (size === undefined) {
    throw new Error(`bake-predicted: unknown Valhalla hierarchy level ${level}`);
  }
  return (360 / size) * (180 / size);
}

/**
 * Valhalla's `FileSuffix` for a tile: zero-pad `tileid` to a width equal to
 * the base-10 digit count of `(tileCount - 1)` for that level, rounded UP to
 * the nearest multiple of 3, then insert `/` every 3 digits. VALIDATED
 * against real staging tiles: `(0,3198)->"0/003/198"`, `(1,51313)->
 * "1/051/313"`, `(2,820133)->"2/000/820/133"`.
 */
export function tileSuffix(level: number, tileid: number): string {
  const maxId = tileCountForLevel(level) - 1;
  const digitCount = String(maxId).length;
  const width = Math.ceil(digitCount / 3) * 3;
  const padded = String(tileid).padStart(width, "0");
  const groups: string[] = [];
  for (let i = 0; i < padded.length; i += 3) groups.push(padded.slice(i, i + 3));
  return `${level}/${groups.join("/")}`;
}

/** One OpenConditions predicted-speed profile segment (`segments/profiles.json`). */
export interface ProfileSegment {
  /** OSM way id, transmitted as a string because it's a bigint on the wire. */
  way_id: string;
  dir: "f" | "b";
  free_flow_kph: number;
  constrained_kph: number;
  /** 168 hourly speeds, Sunday-first (`hourly[24*day + hour]`); `null` falls back to `free_flow_kph`. */
  hourly: (number | null)[];
}

interface TrafficLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface BakePredictedDeps {
  /** Base URL of the OpenConditions ingest extension (`GET {url}/segments/profiles.json`). */
  openConditionsUrl: string;
  /** Host-visible directory the per-tile CSVs are written to. Defaults under `DATA_DIR`. */
  csvDir?: string;
  /** Same directory as seen INSIDE the Valhalla container. Defaults to the `osm-pbf` shared mount point. */
  containerCsvDir?: string;
  container?: string;
  configPath?: string;
  /** Test seam: invoked instead of a real `fetch()` against `${openConditionsUrl}/segments/profiles.json`. */
  fetchProfiles?: () => Promise<ProfileSegment[]>;
  /** Test seam: invoked instead of the real `loadWaysToEdges`. */
  loadWaysToEdges?: () => Promise<Map<number, WayEdge[]>>;
  /** Test seam: invoked instead of `execa("docker", [...])`. */
  runDocker?: DockerRunner;
  /** Test seam: invoked instead of the real `ensureTrafficExtract`. */
  ensureTrafficExtract?: (deps: {
    force?: boolean;
    logger?: { info: (msg: string, extra?: Record<string, unknown>) => void };
  }) => Promise<EnsureTrafficExtractResult>;
  /** Test seam: invoked instead of the real `refreshWaysToEdges`. */
  refreshWaysToEdges?: (
    coveredWayIds: Set<number>,
    deps?: { logger?: { info: (msg: string, extra?: Record<string, unknown>) => void } },
  ) => Promise<RefreshWaysToEdgesResult>;
  logger?: TrafficLogger;
}

export interface BakePredictedResult {
  /** Number of profile segments fetched from OpenConditions. */
  segments: number;
  /** Total per-tile CSV rows written (after the forward/backward direction filter). */
  rows: number;
  /** Number of distinct tiles (CSV files) touched. */
  tiles: number;
  /** Whether `ensureTrafficExtract` rebuilt `traffic.tar` (always true — it's called with `force: true`). */
  built: boolean;
  wayCount: number;
  edgeCount: number;
}

function defaultCsvDir(): string {
  // Must be written to the ONE host directory both containers can see. Valhalla
  // mounts host `data/valhalla/osm-pbf` at `/custom_files` (its `osm-pbf`
  // consume mount), and data-manager reaches that SAME host dir through its own
  // `/data` mount at `/data/valhalla/osm-pbf`. It is NOT a purpose-built shared
  // bind mount — it's the Valhalla consumer's osm-pbf directory that
  // data-manager happens to also see. data-manager's own produce dir
  // (`/data/osm`) is a separate hardlink target Valhalla never reads without an
  // explicit `POST /link`, so writing there would make the bake a silent no-op.
  // Mirrors `cron.ts`'s `trafficTarPath` default, which resolves the same
  // host dir for `/custom_files/traffic.tar`.
  return envString(
    "TRAFFIC_PREDICTED_CSV_DIR",
    join(envString("DATA_DIR", "/data"), "valhalla", "osm-pbf", "predicted-csv"),
  );
}

async function defaultRunDocker(args: string[]): Promise<DockerRunResult> {
  const result = await execa("docker", args, { stdio: "pipe", reject: false });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout ?? "" };
}

async function defaultFetchProfiles(openConditionsUrl: string): Promise<ProfileSegment[]> {
  const res = await fetch(`${openConditionsUrl}/segments/profiles.json`);
  if (!res.ok) {
    throw new Error(`bake-predicted: OpenConditions profiles feed responded ${res.status}`);
  }
  return (await res.json()) as ProfileSegment[];
}

const SPEED_FIELD_MIN_KPH = 0;
/**
 * Defensive upper bound for the freeflow/constrained CSV fields. Real
 * Valhalla behavior for these single-byte fields near/above this value is
 * NOT validated in this test suite — flagged for operator acceptance on a
 * real bake.
 */
const SPEED_FIELD_MAX_KPH = 250;

/**
 * Rounds a freeflow/constrained speed to the CSV's integer field, clamping
 * only the upper bound. `0` is a legitimate "not set" sentinel for these
 * fields (unlike `expandHourlyToBuckets`'s bucket clamp, which floors at 5),
 * so it's never floored away — the caller always ships the field.
 */
function clampSpeedField(kph: number): number {
  const rounded = Math.round(kph);
  return Math.min(SPEED_FIELD_MAX_KPH, Math.max(SPEED_FIELD_MIN_KPH, rounded));
}

interface TileGroup {
  level: number;
  tile: number;
  lines: string[];
}

/**
 * Fetches OpenConditions' predicted-speed profiles, encodes each into
 * Valhalla's DCT-II payload, groups the resulting rows into per-tile CSVs at
 * their `tileSuffix` paths, runs `valhalla_add_predicted_traffic` against
 * them, then runs the rebuild chain the bake invalidates downstream: the
 * loose tiles grew, so the `traffic.tar` extract (sized to the graph's
 * directed-edge count) and the way-to-edge map are both stale. Order matters:
 * the bake must finish before `ensureTrafficExtract({ force: true })` rebuilds
 * the extract against the now-updated tiles — that call ALSO restarts Valhalla
 * itself, so no separate restart is issued here (a second restart would bounce
 * Valhalla twice). `refreshWaysToEdges` then re-derives the way-to-edge map
 * (consumed by data-manager's live-speed writer, not by Valhalla) against the
 * rebuilt graph, so it runs after the extract rebuild + restart.
 */
export async function bakePredicted(deps: BakePredictedDeps): Promise<BakePredictedResult> {
  const container = resolveContainer(deps);
  const configPath = deps.configPath ?? DEFAULT_VALHALLA_CONFIG_PATH;
  const run = deps.runDocker ?? defaultRunDocker;
  const csvDir = deps.csvDir ?? defaultCsvDir();
  const containerCsvDir = deps.containerCsvDir ?? PREDICTED_CSV_CONTAINER_DIR;

  const fetchProfiles = deps.fetchProfiles ?? (() => defaultFetchProfiles(deps.openConditionsUrl));
  const loadEdges = deps.loadWaysToEdges ?? (() => loadWaysToEdgesDefault());
  const ensureExtract = deps.ensureTrafficExtract ?? ensureTrafficExtractDefault;
  const refreshWays = deps.refreshWaysToEdges ?? refreshWaysToEdgesDefault;

  const [profiles, waysToEdges] = await Promise.all([fetchProfiles(), loadEdges()]);

  const tiles = new Map<string, TileGroup>();
  const coveredWayIds = new Set<number>();
  let rows = 0;

  for (const profile of profiles) {
    const wayId = Number(profile.way_id);
    if (!Number.isFinite(wayId)) continue;
    coveredWayIds.add(wayId);

    const edges = waysToEdges.get(wayId);
    if (!edges || edges.length === 0) continue;

    const forward = profile.dir === "f";
    const matching = edges.filter((edge) => edge.forward === forward);
    if (matching.length === 0) continue;

    const buckets = expandHourlyToBuckets(profile.hourly, profile.free_flow_kph);
    const base64 = encodePredictedSpeeds(buckets);
    const freeflow = clampSpeedField(profile.free_flow_kph);
    const constrained = clampSpeedField(profile.constrained_kph);

    for (const edge of matching) {
      const key = `${edge.level}:${edge.tile}`;
      let group = tiles.get(key);
      if (!group) {
        group = { level: edge.level, tile: edge.tile, lines: [] };
        tiles.set(key, group);
      }
      group.lines.push(
        `${edge.level}/${edge.tile}/${edge.index},${freeflow},${constrained},${base64}`,
      );
      rows++;
    }
  }

  await rm(csvDir, { recursive: true, force: true });
  await mkdir(csvDir, { recursive: true });
  for (const group of tiles.values()) {
    const filePath = join(csvDir, `${tileSuffix(group.level, group.tile)}.csv`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${group.lines.join("\n")}\n`, "utf8");
  }

  const bake = await run([
    "exec",
    container,
    "valhalla_add_predicted_traffic",
    "-c",
    configPath,
    containerCsvDir,
  ]);
  if (bake.exitCode !== 0) {
    throw new Error(
      `bake-predicted: valhalla_add_predicted_traffic exited ${bake.exitCode} on container "${container}"`,
    );
  }

  // Rebuild chain: the bake above rewrote the loose tiles in place, so the
  // edge-count-sized traffic.tar and the way->edge map are both stale now.
  // ensureTrafficExtract({ force: true }) rebuilds the extract AND restarts
  // Valhalla itself — no separate restart is issued here, so Valhalla bounces
  // exactly once. refreshWaysToEdges then re-derives the map (consumed by
  // data-manager, not Valhalla) against the rebuilt graph, after the restart.
  const extractResult = await ensureExtract({ force: true, logger: deps.logger });
  const waysResult = await refreshWays(coveredWayIds, { logger: deps.logger });

  const result: BakePredictedResult = {
    segments: profiles.length,
    rows,
    tiles: tiles.size,
    built: extractResult.built,
    wayCount: waysResult.wayCount,
    edgeCount: waysResult.edgeCount,
  };
  deps.logger?.info("bake-predicted: cycle complete", { ...result });
  return result;
}
