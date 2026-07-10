import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { execa } from "execa";
import {
  DEFAULT_VALHALLA_CONFIG_PATH,
  type DockerRunner,
  resolveContainer,
  TILE_DIR_PATH,
} from "./ensure-extract.js";

/** Hard-coded output filename of `valhalla_ways_to_edges` — no output flag exists. */
const WAY_EDGES_FILENAME = "way_edges.txt";

export interface WayEdge {
  forward: boolean;
  level: number;
  tile: number;
  index: number;
}

/**
 * Decodes a Valhalla `GraphId` 64-bit bitfield (source: `graphid.h`):
 * level = bits 0-2 (3 bits), tileid = bits 3-24 (22 bits), index = bits 25-45
 * (21 bits). Pure — no I/O.
 */
export function decodeGraphId(raw: bigint): { level: number; tile: number; index: number } {
  const level = Number(raw & 0x7n);
  const tile = Number((raw >> 3n) & 0x3fffffn);
  const index = Number((raw >> 25n) & 0x1fffffn);
  return { level, tile, index };
}

interface TrafficLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface RefreshWaysToEdgesDeps {
  runDocker?: DockerRunner;
  container?: string;
  configPath?: string;
  /**
   * Test seam: yields `way_edges.txt` lines without shelling out to docker.
   * Production callers omit this and get a real `docker exec <container> cat
   * <path>` stream.
   */
  readWayEdgesLines?: (container: string, path: string) => AsyncIterable<string>;
  /** Where to write the filtered JSON map. Defaults under `DATA_DIR`. */
  outputPath?: string;
  logger?: TrafficLogger;
}

export interface RefreshWaysToEdgesResult {
  wayCount: number;
  edgeCount: number;
}

async function defaultRunDocker(args: string[]) {
  const result = await execa("docker", args, { stdio: "pipe", reject: false });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout ?? "" };
}

/**
 * Streams `docker exec <container> cat <path>` line-by-line via `readline`
 * over the child's stdout pipe — never buffers the full file in memory. This
 * matters because on a planet graph `way_edges.txt` covers every routable way
 * and can be far too large to hold as a string or array.
 */
async function* defaultReadWayEdgesLines(container: string, path: string): AsyncGenerator<string> {
  const child = spawn("docker", ["exec", container, "cat", path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
  }
  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`ways-to-edges: "docker exec ${container} cat ${path}" exited ${exitCode}`);
  }
}

/** Path of the JSON way→edge map `refreshWaysToEdges` writes and `loadWaysToEdges` reads. */
export function defaultOutputPath(): string {
  return join(process.env.DATA_DIR ?? "/data", "traffic", "ways_to_edges.json");
}

/**
 * Parses one `way_edges.txt` line — `<osm_way_id>,<forward:0|1>,<graphid>[,
 * <forward>,<graphid>…]` — returning the way id and its decoded edges, or
 * `null` when the way id isn't in `coveredWayIds` (the line is skipped
 * without being fully parsed) or the line is blank/malformed.
 */
function parseWayEdgesLine(
  line: string,
  coveredWayIds: Set<number>,
): { wayId: number; edges: WayEdge[] } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(",");
  const wayId = Number(parts[0]);
  if (!Number.isFinite(wayId) || !coveredWayIds.has(wayId)) return null;

  const edges: WayEdge[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const forward = parts[i] === "1";
    const graphId = BigInt(parts[i + 1]);
    edges.push({ forward, ...decodeGraphId(graphId) });
  }
  return { wayId, edges };
}

/**
 * Runs `valhalla_ways_to_edges` in the Valhalla container, then stream-parses
 * the resulting `way_edges.txt` (written to `<mjolnir.tile_dir>/way_edges.txt`
 * — a hard-coded name, there is no output flag), keeping only lines whose way
 * id is in `coveredWayIds`.
 *
 * Scale seam: the stream-filter step never materializes the unfiltered
 * planet-scale file (every routable way) in memory — only covered lines are
 * parsed and kept. The resulting filtered JSON map is fine to hold fully in
 * memory up to roughly 10^5-10^6 covered ways; past that, swap the on-disk
 * storage for a tile-partitioned or binary keyed store behind the same
 * `loadWaysToEdges` signature.
 */
export async function refreshWaysToEdges(
  coveredWayIds: Set<number>,
  deps: RefreshWaysToEdgesDeps = {},
): Promise<RefreshWaysToEdgesResult> {
  const run = deps.runDocker ?? defaultRunDocker;
  const container = resolveContainer(deps);
  const configPath = deps.configPath ?? DEFAULT_VALHALLA_CONFIG_PATH;

  const build = await run(["exec", container, "valhalla_ways_to_edges", "-c", configPath]);
  if (build.exitCode !== 0) {
    throw new Error(
      `ways-to-edges: valhalla_ways_to_edges exited ${build.exitCode} on container "${container}"`,
    );
  }

  const wayEdgesPath = `${TILE_DIR_PATH}/${WAY_EDGES_FILENAME}`;
  const readLines = deps.readWayEdgesLines ?? defaultReadWayEdgesLines;

  const result: Record<number, WayEdge[]> = {};
  let edgeCount = 0;
  for await (const line of readLines(container, wayEdgesPath)) {
    const parsed = parseWayEdgesLine(line, coveredWayIds);
    if (!parsed) continue;
    result[parsed.wayId] = parsed.edges;
    edgeCount += parsed.edges.length;
  }

  const outputPath = deps.outputPath ?? defaultOutputPath();
  await mkdir(dirname(outputPath), { recursive: true });
  // Write + atomic rename so the live writer's every-2-min `loadWaysToEdges`
  // never reads a half-written map (truncate-then-write would expose torn JSON
  // during the ~large serialize), and so an overlapping refresh — the startup
  // bootstrap racing the 05:00 guard — can't interleave two writers on one path.
  const tmpPath = `${outputPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(result), "utf8");
  await rename(tmpPath, outputPath);

  const wayCount = Object.keys(result).length;
  deps.logger?.info("ways-to-edges: refreshed", { wayCount, edgeCount, outputPath });
  return { wayCount, edgeCount };
}

/** Reads the JSON map written by `refreshWaysToEdges` back into a `Map`. */
export async function loadWaysToEdges(
  deps: { path?: string } = {},
): Promise<Map<number, WayEdge[]>> {
  const path = deps.path ?? defaultOutputPath();
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, WayEdge[]>;
  return new Map(Object.entries(parsed).map(([wayId, edges]) => [Number(wayId), edges]));
}
