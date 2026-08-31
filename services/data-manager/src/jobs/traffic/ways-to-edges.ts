import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runOpsOperation } from "../../ops-client.js";
import { atomicWriteFile } from "../../utils/atomic-write.js";

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
  /**
   * Test seam: yields `way_edges.txt` lines without reading the shared mount.
   * Production callers omit this and stream the real file.
   */
  readWayEdgesLines?: (path: string) => AsyncIterable<string>;
  /** Where to write the filtered JSON map. Defaults under `DATA_DIR`. */
  outputPath?: string;
  /** Test seam: where `valhalla_ways_to_edges` left its output. */
  wayEdgesPath?: string;
  logger?: TrafficLogger;
}

export interface RefreshWaysToEdgesResult {
  wayCount: number;
  edgeCount: number;
}

/**
 * `valhalla_ways_to_edges` writes `<tile_dir>/way_edges.txt` inside the Valhalla
 * container, but that tile directory is the shared OSM producer mount, so the
 * file is readable here directly. Streaming it line-by-line matters: on a planet
 * graph it covers every routable way and is far too large to hold as a string.
 */
export function defaultWayEdgesPath(): string {
  return join(process.env.DATA_DIR ?? "/data", "osm", "valhalla_tiles", WAY_EDGES_FILENAME);
}

async function* defaultReadWayEdgesLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, "utf8") });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
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
  // Producing `way_edges.txt` is host authority and belongs to the agent; the
  // covered-way filter below is data-manager's own concern and stays here.
  await runOpsOperation({ kind: "valhalla.traffic.refreshWaysToEdges" });

  const wayEdgesPath = deps.wayEdgesPath ?? defaultWayEdgesPath();
  const readLines = deps.readWayEdgesLines ?? defaultReadWayEdgesLines;

  const result: Record<number, WayEdge[]> = {};
  let edgeCount = 0;
  for await (const line of readLines(wayEdgesPath)) {
    const parsed = parseWayEdgesLine(line, coveredWayIds);
    if (!parsed) continue;
    result[parsed.wayId] = parsed.edges;
    edgeCount += parsed.edges.length;
  }

  const outputPath = deps.outputPath ?? defaultOutputPath();
  // The map is rebuildable; readers need atomic visibility without blocking on fsync.
  await atomicWriteFile(outputPath, JSON.stringify(result), {
    durability: "visibility",
    createParentDirectory: true,
  });

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
