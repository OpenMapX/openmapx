import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { envString } from "@openmapx/core/server-env";
import { encodeTrafficSpeed } from "./traffic-speed.js";
import type { WayEdge } from "./ways-to-edges.js";

/**
 * Writes live OpenConditions speed feed values directly into a running
 * Valhalla `traffic.tar` extract — the binary layout below is VALIDATED
 * against a real Valhalla 3.7.0 output (staging round-trip, 2026-07-09).
 *
 * Layout:
 * - The tar's first member is `index.bin`: packed 16-byte little-endian
 *   entries `{ u64 offset, u32 tile_id, u32 size }`. `offset` is the
 *   member's tar DATA offset (not the header offset, no +512 needed).
 *   `tile_id` is the tile's BASE GraphId, `(tileid << 3) | level`. `size` is
 *   the tile member's data length, so `(size - 32) / 8` is that tile's
 *   `directed_edge_count` (matches the header's own count — validated).
 * - Each tile member's data is a 32-byte `TrafficTileHeader` (`tile_id u64,
 *   last_update u64, directed_edge_count u32, traffic_tile_version u32,
 *   spare u32x2`) followed by `directed_edge_count` 8-byte `TrafficSpeed`
 *   records (see `traffic-speed.ts`).
 * - A given edge's record byte offset is `tile_data_offset + 32 + 8 *
 *   edge_index` — confirmed by a real round-trip write/read on staging.
 */

const USTAR_HEADER_SIZE = 512;
const USTAR_SIZE_FIELD_OFFSET = 124;
const USTAR_SIZE_FIELD_LENGTH = 12;
const INDEX_BIN_ENTRY_SIZE = 16;
const TRAFFIC_TILE_HEADER_SIZE = 32;
// `last_update` (u64) follows `tile_id` (u64) — offset 8, NOT 16. Offset 16 is
// `directed_edge_count`; an 8-byte write there corrupts the count (and the
// version u32 after it) so Valhalla reads a garbage edge count and discards the
// whole traffic tile — silently dropping every live speed in it.
const TRAFFIC_TILE_LAST_UPDATE_OFFSET = 8;
const TRAFFIC_SPEED_RECORD_SIZE = 8;

interface TrafficLogger {
  warn: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface WriteLiveTrafficDeps {
  /** Path to the Valhalla `traffic.tar` extract, as seen by this process. */
  tarPath: string;
  /** Raw `way_id,dir,current_kph,free_flow_kph,los` CSV body (header + rows). */
  csv: string;
  waysToEdges: Map<number, WayEdge[]>;
  /** Where the write-state (successfully-written edge identities) is persisted. Defaults under `DATA_DIR`. */
  statePath?: string;
  logger?: TrafficLogger;
}

export interface WriteLiveTrafficResult {
  /** Number of `TrafficSpeed` records actually written this cycle. */
  written: number;
  /** Number of CSV rows whose way_id was found in `waysToEdges`. */
  matched: number;
  /** Total CSV data rows (every non-blank line after the header, malformed included). */
  total: number;
  /**
   * Edges skipped because `edge.index` fell outside the tile's
   * `directed_edge_count` — a stale `waysToEdges` relative to a freshly
   * rebuilt `traffic.tar`. Never written; surfaced so the extract-guard cron
   * knows to rebuild.
   */
  outOfBounds: number;
}

interface CsvRow {
  wayId: number;
  dir: "f" | "b";
  currentKph: number | null;
}

/** One index.bin entry: where a tile's data lives and how many records it has. */
interface TileEntry {
  dataOffset: number;
  directedEdgeCount: number;
}

/**
 * A tar-STABLE edge identifier — the graph coordinates of one directed edge.
 * The state file persists these (NOT absolute byte offsets), because a
 * `traffic.tar` rebuild shifts every tile's offset/size while `{level, tile,
 * index}` still names the same edge. Persisting offsets would let the clear
 * path zero a stale offset into an adjacent tile's header or past EOF in the
 * live mmapped file after a rebuild; persisting identity lets the clear path
 * re-resolve + bounds-check against the CURRENT index.bin instead.
 */
interface EdgeIdentity {
  level: number;
  tile: number;
  index: number;
}

/** A resolved, in-bounds write target plus the identity that produced it. */
interface ResolvedOffset {
  recordOffset: number;
  dataOffset: number;
  identity: EdgeIdentity;
}

function identityKey(id: EdgeIdentity): string {
  return `${id.level}:${id.tile}:${id.index}`;
}

/**
 * Re-resolves one edge identity to its record byte offset through the CURRENT
 * index map, with the SAME bounds check as the write path. Returns `null` when
 * the tile is absent from this tar or the index is out of range — in either
 * case the edge no longer exists here (a rebuilt/shrunk tar), so its record is
 * already fresh-zero and clearing it would be both unnecessary and unsafe.
 */
function resolveIdentityOffset(idxMap: Map<bigint, TileEntry>, id: EdgeIdentity): number | null {
  const baseGraphId = (BigInt(id.tile) << 3n) | BigInt(id.level);
  const entry = idxMap.get(baseGraphId);
  if (entry === undefined) return null;
  if (id.index < 0 || id.index >= entry.directedEdgeCount) return null;
  return entry.dataOffset + TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * id.index;
}

function defaultStatePath(): string {
  return join(envString("DATA_DIR", "/data"), "traffic", "live-state.json");
}

function readOctalField(buf: Buffer, offset: number, length: number): number {
  const raw = buf
    .toString("ascii", offset, offset + length)
    .replace(/\0/g, "")
    .trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

/**
 * Reads the first (index.bin) USTAR member and parses its packed 16-byte
 * entries into `baseGraphId -> { dataOffset, directedEdgeCount }`. The record
 * count is derived from the entry's `size` field (`(size - 32) / 8`) — kept so
 * writes can be bounds-checked against the live tile before touching the file.
 */
function parseIndexBin(fd: number): Map<bigint, TileEntry> {
  const header = Buffer.alloc(USTAR_HEADER_SIZE);
  readSync(fd, header, 0, USTAR_HEADER_SIZE, 0);
  const size = readOctalField(header, USTAR_SIZE_FIELD_OFFSET, USTAR_SIZE_FIELD_LENGTH);

  const data = Buffer.alloc(size);
  readSync(fd, data, 0, size, USTAR_HEADER_SIZE);

  const map = new Map<bigint, TileEntry>();
  const entryCount = Math.floor(size / INDEX_BIN_ENTRY_SIZE);
  for (let i = 0; i < entryCount; i++) {
    const base = i * INDEX_BIN_ENTRY_SIZE;
    const offset = data.readBigUInt64LE(base);
    const tileId = data.readUInt32LE(base + 8);
    const memberSize = data.readUInt32LE(base + 12);
    const directedEdgeCount = Math.floor(
      (memberSize - TRAFFIC_TILE_HEADER_SIZE) / TRAFFIC_SPEED_RECORD_SIZE,
    );
    map.set(BigInt(tileId), { dataOffset: Number(offset), directedEdgeCount });
  }
  return map;
}

/** `way_id,dir,current_kph,free_flow_kph,los` — header line, then rows. */
function parseCsv(csv: string): { rows: CsvRow[]; total: number } {
  const lines = csv.split(/\r?\n/);
  const rows: CsvRow[] = [];
  let total = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === "") continue;
    // Every non-blank data line counts toward the match-rate denominator,
    // even malformed ones — a rising malformed-row count is itself signal.
    total++;
    const parts = line.split(",");
    const wayId = Number(parts[0]);
    const dirRaw = parts[1]?.trim();
    if (!Number.isFinite(wayId) || (dirRaw !== "f" && dirRaw !== "b")) continue;
    const kphRaw = parts[2]?.trim();
    let currentKph: number | null = null;
    if (kphRaw) {
      const parsed = Number(kphRaw);
      currentKph = Number.isFinite(parsed) ? parsed : null;
    }
    rows.push({ wayId, dir: dirRaw, currentKph });
  }
  return { rows, total };
}

/**
 * Resolves the edges of `wayId` whose `forward` flag matches `dir` to their
 * in-bounds tar-file record offsets. A way whose tile isn't in `idxMap` (a way
 * in our spine that isn't in this Valhalla graph — expected in small numbers
 * from OSM-vintage drift) is silently dropped. An edge whose `index` falls
 * outside the tile's `directed_edge_count` (a stale `waysToEdges` vs a freshly
 * rebuilt tar) is NEVER written — it's counted in `outOfBounds` and logged, so
 * the caller can surface the version mismatch and trigger a rebuild.
 */
function resolveOffsets(
  waysToEdges: Map<number, WayEdge[]>,
  idxMap: Map<bigint, TileEntry>,
  wayId: number,
  dir: "f" | "b",
  onOutOfBounds?: (edge: WayEdge, directedEdgeCount: number) => void,
): ResolvedOffset[] {
  const edges = waysToEdges.get(wayId);
  if (!edges) return [];
  const forward = dir === "f";
  const result: ResolvedOffset[] = [];
  for (const edge of edges) {
    if (edge.forward !== forward) continue;
    const baseGraphId = (BigInt(edge.tile) << 3n) | BigInt(edge.level);
    const entry = idxMap.get(baseGraphId);
    if (entry === undefined) continue;
    if (edge.index < 0 || edge.index >= entry.directedEdgeCount) {
      onOutOfBounds?.(edge, entry.directedEdgeCount);
      continue;
    }
    const recordOffset =
      entry.dataOffset + TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * edge.index;
    result.push({
      recordOffset,
      dataOffset: entry.dataOffset,
      identity: { level: edge.level, tile: edge.tile, index: edge.index },
    });
  }
  return result;
}

async function loadPreviousIdentities(statePath: string): Promise<EdgeIdentity[] | null> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const identities: EdgeIdentity[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === "object" &&
        Number.isFinite((entry as EdgeIdentity).level) &&
        Number.isFinite((entry as EdgeIdentity).tile) &&
        Number.isFinite((entry as EdgeIdentity).index)
      ) {
        const { level, tile, index } = entry as EdgeIdentity;
        identities.push({ level, tile, index });
      }
    }
    return identities;
  } catch {
    // Missing (first run) or corrupt (crash mid-write) state file: no known
    // set of previously-written edges to clear. A corrupt file can't be
    // trusted to tell us what's actually stale, so treat it as "nothing to
    // reconcile" — this cycle's writes still land and become the new state.
    return null;
  }
}

async function saveIdentities(
  statePath: string,
  identities: Iterable<EdgeIdentity>,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify([...identities]), "utf8");
}

/**
 * Writes the current CSV's live speeds into `tarPath`'s traffic tiles, in
 * place on the same inode (never temp-file + rename — the Valhalla router
 * mmaps the tar once at startup and never re-opens it, so a rename would
 * leave it reading the dead inode forever). An 8-byte aligned `writeSync` at
 * a `recordOffset` has a rare torn-read window under concurrent readers that
 * self-heals on the next cycle; a guaranteed-untorn single-store write would
 * need an mmap (e.g. `mmap-io`) — deferred to keep v1 free of a native dep.
 *
 * The writer owns staleness: Valhalla never expires live speeds on its own.
 * Staleness is tracked by the set of tar-stable edge IDENTITIES (`{level,
 * tile, index}`) successfully written each cycle, persisted in the state file.
 * At cycle end, every previously-written identity NOT re-written this cycle is
 * RE-RESOLVED through the current index.bin (same bounds check as the write
 * path) and, if it still resolves in-bounds, zeroed (`encodeTrafficSpeed(null)`,
 * the "unknown" sentinel). This covers a row dropping out of the CSV, its way
 * being dropped from `waysToEdges`, and its tile vanishing — so no edge keeps a
 * stale live speed once we stop successfully writing it.
 *
 * Identities (not absolute offsets) are persisted precisely so the clear path
 * stays bounds-safe across a `traffic.tar` rebuild: a rebuild shifts every
 * tile's offset/size, so a persisted absolute offset could zero into an
 * adjacent tile's header or past EOF. Re-resolving identity against the CURRENT
 * index.bin either lands on the same edge's record or skips (tile gone / index
 * now out of range — the record is already fresh-zero in the rebuilt tar).
 *
 * A write is NEVER emitted at an offset past a tile's record region on either
 * path: an out-of-range edge index (a stale `waysToEdges` vs a just-rebuilt
 * tar) is skipped — on the write path it's surfaced via `outOfBounds`, on the
 * clear path it's silently skipped as already-fresh.
 */
export async function writeLiveTraffic(
  deps: WriteLiveTrafficDeps,
): Promise<WriteLiveTrafficResult> {
  const statePath = deps.statePath || defaultStatePath();
  const { rows, total } = parseCsv(deps.csv);

  const fd = openSync(deps.tarPath, "r+");
  try {
    const idxMap = parseIndexBin(fd);
    const previousIdentities = await loadPreviousIdentities(statePath);
    const clearedRecord = encodeTrafficSpeed(null);

    let matched = 0;
    let written = 0;
    let outOfBounds = 0;
    // Keyed by identity so the reconciliation below can compare "written this
    // cycle" vs "previous" on tar-stable coordinates, never on byte offsets.
    const writtenIdentities = new Map<string, EdgeIdentity>();
    const touchedTileDataOffsets = new Set<number>();

    const noteOutOfBounds = (edge: WayEdge, directedEdgeCount: number): void => {
      outOfBounds++;
      deps.logger?.warn("traffic-live: edge index out of range, skipping write", {
        level: edge.level,
        tile: edge.tile,
        index: edge.index,
        directedEdgeCount,
      });
    };

    for (const row of rows) {
      const edges = deps.waysToEdges.get(row.wayId);
      if (!edges || edges.length === 0) continue;
      matched++;

      const offsets = resolveOffsets(deps.waysToEdges, idxMap, row.wayId, row.dir, noteOutOfBounds);
      if (offsets.length === 0) continue;

      const record = encodeTrafficSpeed(row.currentKph);
      for (const { recordOffset, dataOffset, identity } of offsets) {
        writeSync(fd, record, 0, TRAFFIC_SPEED_RECORD_SIZE, recordOffset);
        written++;
        writtenIdentities.set(identityKey(identity), identity);
        touchedTileDataOffsets.add(dataOffset);
      }
    }

    // Staleness reconciliation: clear every edge we wrote LAST cycle that we
    // did NOT re-write THIS cycle. Each stale identity is RE-RESOLVED through
    // the current index.bin (with the write path's bounds check) — so an edge
    // whose tile vanished or whose index is now out of range in a rebuilt tar
    // is safely skipped rather than zeroed at a now-invalid offset. A row that
    // stayed in the CSV but left `waysToEdges` still clears here, because its
    // identity re-resolves via idxMap directly, bypassing `waysToEdges`.
    if (previousIdentities !== null) {
      for (const identity of previousIdentities) {
        if (writtenIdentities.has(identityKey(identity))) continue;
        const clearOffset = resolveIdentityOffset(idxMap, identity);
        if (clearOffset === null) continue;
        writeSync(fd, clearedRecord, 0, TRAFFIC_SPEED_RECORD_SIZE, clearOffset);
      }
    }

    // Stamp each touched tile's `last_update` (offset 8) with the current epoch
    // seconds so operators can see tile freshness — and, critically, so the
    // write lands on `last_update` rather than clobbering `directed_edge_count`
    // at offset 16.
    if (touchedTileDataOffsets.size > 0) {
      const nowBuf = Buffer.alloc(8);
      nowBuf.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), 0);
      for (const dataOffset of touchedTileDataOffsets) {
        writeSync(fd, nowBuf, 0, 8, dataOffset + TRAFFIC_TILE_LAST_UPDATE_OFFSET);
      }
    }

    await saveIdentities(statePath, writtenIdentities.values());

    return { written, matched, total, outOfBounds };
  } finally {
    closeSync(fd);
  }
}
