import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { envString } from "@openmapx/core/server-env";
import { atomicWriteFile } from "../../utils/atomic-write.js";
import { type EdgeOverride, edgeKey } from "./conditions-to-edges.js";
import { recordTrafficGraphSuccess, trafficEvidencePath } from "./evidence.js";
import { readTrafficGraphGeneration } from "./graph-generation.js";
import { encodeClosedTrafficSpeed, encodeTrafficSpeed } from "./traffic-speed.js";
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
  /** Earliest source, policy or observation deadline; also capped to two minutes. */
  validUntil?: string;
  graphGeneration?: string;
  /** Identifies this publication to the engine-owned response attestation. */
  writeId?: string;
  engineBootId?: string;
  /** Epoch captured before trace resolution; rechecked under the writer lock. */
  expectedGraphGeneration?: string;
  /** Raw `way_id,dir,current_kph,free_flow_kph,los` CSV body (header + rows). */
  csv: string;
  waysToEdges: Map<number, WayEdge[]>;
  /**
   * Per-directed-edge closures and speed caps from bound road conditions,
   * keyed by `edgeKey` (`level:tile:index`). Merged ON TOP of the live speeds:
   * a closure outranks any speed, a cap yields `min(live, cap)`. An override
   * edge is written even when the CSV has no row for it, and its identity
   * joins the staleness set — so a lifted closure reverts next cycle.
   */
  overrides?: Map<string, EdgeOverride & { edge: WayEdge }>;
  /** Where the write-state (successfully-written edge identities) is persisted. Defaults under `DATA_DIR`. */
  statePath?: string;
  /** Versioned dashboard evidence path. Defaults beside `statePath`. */
  evidencePath?: string;
  logger?: TrafficLogger;
}

export interface WriteLiveTrafficResult {
  /**
   * Number of `TrafficSpeed` records actually written this cycle — one per
   * edge, so an edge carrying both a CSV speed and an override counts once.
   */
  written: number;
  /** Number of CSV rows whose way_id was found in `waysToEdges`. */
  matched: number;
  /** Total CSV data rows (every non-blank line after the header, malformed included). */
  total: number;
  /**
   * Edges (from the CSV or from `overrides`) skipped because `edge.index` fell
   * outside the tile's `directed_edge_count` — a stale `waysToEdges` relative
   * to a freshly rebuilt `traffic.tar`. Never written; surfaced so the
   * extract-guard cron knows to rebuild.
   */
  outOfBounds: number;
  /** Records written as CLOSED because an override closed that edge. */
  closedEdges: number;
  /**
   * Records written with a speed cap override in force. Counts the cap being
   * applied to the edge, including when the live speed was already below it.
   */
  cappedEdges: number;
  /**
   * Override edges that could NOT be applied because their tile is absent from
   * this tar or their index is out of range — a closure that silently does
   * nothing is exactly what an operator needs to see. Kept separate from
   * `outOfBounds` (the tar/way-map version-mismatch signal): a missing tile is
   * an expected way-vintage gap, not a mismatch. An out-of-range override edge
   * therefore increments BOTH counters.
   */
  overridesUnresolved: number;
  /**
   * Sorted observation ids whose EVERY override edge was written this cycle.
   * One unresolved edge (see `overridesUnresolved`) removes the observation
   * from this list, even when its other edges were written: the consumer drops
   * ALL of an event's per-request exclusions once it sees the id here, so a
   * partially-applied event must not appear — the graph would be closed on
   * some of its edges and wide open on the rest, with nothing excluding them.
   */
  appliedObservationIds: string[];
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

/** One edge's merged outcome for this cycle: the live speed after overrides. */
interface PlannedWrite {
  offset: ResolvedOffset;
  /** Speed to encode; `null` writes the "unknown" sentinel. Ignored when `closed`. */
  kph: number | null;
  closed: boolean;
  /** A speed cap override applied to this edge (for reporting only). */
  capped: boolean;
  /**
   * The observation whose override determined this record, or `null` for a
   * plain CSV speed. Only set once the edge resolved in-bounds, so it reports
   * what actually reached the tar.
   */
  observationId: string | null;
  contributorIds: string[];
}

/**
 * Resolves one edge identity to its write target through the CURRENT index
 * map. Returns `null` when the tile is absent from this tar (a way in our
 * spine that isn't in this Valhalla graph) or the index is out of range (a
 * stale way→edge map vs a freshly rebuilt tar) — in either case the edge does
 * not exist here, so a write at that offset could land in an adjacent tile's
 * header or past EOF.
 *
 * `onOutOfBounds` fires ONLY for the in-tar-but-out-of-range case, which is
 * the version mismatch worth surfacing; a missing tile is expected in small
 * numbers and stays silent. The clear path passes no callback: for it, both
 * cases mean "already fresh-zero, nothing to clear".
 */
function resolveIdentityOffset(
  idxMap: Map<bigint, TileEntry>,
  id: EdgeIdentity,
  onOutOfBounds?: (id: EdgeIdentity, directedEdgeCount: number) => void,
): ResolvedOffset | null {
  const baseGraphId = (BigInt(id.tile) << 3n) | BigInt(id.level);
  const entry = idxMap.get(baseGraphId);
  if (entry === undefined) return null;
  if (id.index < 0 || id.index >= entry.directedEdgeCount) {
    onOutOfBounds?.(id, entry.directedEdgeCount);
    return null;
  }
  return {
    recordOffset:
      entry.dataOffset + TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * id.index,
    dataOffset: entry.dataOffset,
    identity: { level: id.level, tile: id.tile, index: id.index },
  };
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
  const fileSize = fstatSync(fd).size;
  const header = Buffer.alloc(USTAR_HEADER_SIZE);
  if (
    readSync(fd, header, 0, header.length, 0) !== header.length ||
    header.toString("ascii", 0, 100).replace(/\0.*$/s, "") !== "index.bin"
  )
    throw new Error("Invalid traffic tar index header");
  const size = readOctalField(header, USTAR_SIZE_FIELD_OFFSET, USTAR_SIZE_FIELD_LENGTH);
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size % INDEX_BIN_ENTRY_SIZE !== 0 ||
    size > 64 * 1024 * 1024 ||
    size + USTAR_HEADER_SIZE > fileSize
  )
    throw new Error("Invalid traffic tar index size");
  const data = Buffer.alloc(size);
  if (readSync(fd, data, 0, size, USTAR_HEADER_SIZE) !== size)
    throw new Error("Truncated traffic tar index");
  const map = new Map<bigint, TileEntry>();
  const ranges: Array<[number, number]> = [];
  const minimumOffset =
    USTAR_HEADER_SIZE + Math.ceil(size / USTAR_HEADER_SIZE) * USTAR_HEADER_SIZE + USTAR_HEADER_SIZE;
  for (let base = 0; base < size; base += INDEX_BIN_ENTRY_SIZE) {
    const offset = Number(data.readBigUInt64LE(base));
    const tileId = data.readUInt32LE(base + 8);
    const memberSize = data.readUInt32LE(base + 12);
    if (
      !Number.isSafeInteger(offset) ||
      offset < minimumOffset ||
      offset % USTAR_HEADER_SIZE !== 0 ||
      memberSize < TRAFFIC_TILE_HEADER_SIZE ||
      (memberSize - TRAFFIC_TILE_HEADER_SIZE) % TRAFFIC_SPEED_RECORD_SIZE !== 0 ||
      offset + memberSize > fileSize ||
      map.has(BigInt(tileId))
    )
      throw new Error("Invalid traffic tile bounds");
    const directedEdgeCount = (memberSize - TRAFFIC_TILE_HEADER_SIZE) / TRAFFIC_SPEED_RECORD_SIZE;
    const tileHeader = Buffer.alloc(TRAFFIC_TILE_HEADER_SIZE);
    if (
      readSync(fd, tileHeader, 0, tileHeader.length, offset) !== tileHeader.length ||
      tileHeader.readBigUInt64LE(0) !== BigInt(tileId) ||
      tileHeader.readUInt32LE(16) !== directedEdgeCount ||
      tileHeader.readUInt32LE(20) !== 3
    )
      throw new Error("Invalid traffic tile header");
    ranges.push([offset, offset + memberSize]);
    map.set(BigInt(tileId), { dataOffset: offset, directedEdgeCount });
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i][0] < ranges[i - 1][1]) throw new Error("Overlapping traffic tiles");
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
  onOutOfBounds?: (id: EdgeIdentity, directedEdgeCount: number) => void,
): ResolvedOffset[] {
  const edges = waysToEdges.get(wayId);
  if (!edges) return [];
  const forward = dir === "f";
  const result: ResolvedOffset[] = [];
  for (const edge of edges) {
    if (edge.forward !== forward) continue;
    const resolved = resolveIdentityOffset(idxMap, edge, onOutOfBounds);
    if (resolved !== null) result.push(resolved);
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
  await atomicWriteFile(statePath, JSON.stringify([...identities]), {
    durability: "full",
    mode: 0o600,
  });
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
 * Bound road conditions arrive as `overrides` and are merged on top of the CSV
 * speeds per edge: a closure wins over any speed (written as a CLOSED record,
 * NOT as speed 0-via-`encodeTrafficSpeed`, and never as the no-data sentinel),
 * a cap yields `min(live, cap)`, and a cap on an edge with no live speed is
 * written on its own. Override edges are ordinary writes in every other
 * respect — same bounds check, same identity set — so a lifted closure or an
 * expired cap is cleared by the staleness pass on the very next cycle. An
 * observation is credited in `appliedObservationIds` only when EVERY one of its
 * override edges survived that bounds check — a single unresolved edge
 * withdraws the whole observation, because the consumer treats the id as
 * "the graph has all of this event" and stops excluding any of it.
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
async function writeLiveTrafficLocked(deps: WriteLiveTrafficDeps): Promise<WriteLiveTrafficResult> {
  if (existsSync(join(dirname(deps.tarPath), ".traffic-maintenance.json")))
    throw new Error("Traffic graph maintenance is in progress");
  const statePath = deps.statePath || defaultStatePath();
  const { rows, total } = parseCsv(deps.csv);

  const fd = openSync(deps.tarPath, "r+");
  try {
    const idxMap = parseIndexBin(fd);
    const file = fstatSync(fd);
    const graphGeneration = createHash("sha256")
      .update(
        JSON.stringify([
          file.dev,
          file.ino,
          file.birthtimeMs,
          file.size,
          deps.graphGeneration ?? null,
          [...idxMap].map(([key, value]) => [String(key), value]),
        ]),
      )
      .digest("hex");
    let previousIdentities = await loadPreviousIdentities(statePath);
    let clearAll = false;
    try {
      const journal = await readJournal(statePath);
      if (journal === null) {
        // A legacy identity list, including a valid empty list, cannot prove
        // that the current tar contains no records written before journaling
        // was introduced. Absence of the journal therefore means the whole
        // extract is uncertain and must be reconciled.
        clearAll = true;
      } else {
        if (journal.graphGeneration !== graphGeneration || journal.uncertain === true)
          clearAll = true;
        else previousIdentities = journal.identities;
      }
    } catch {
      clearAll = true;
    }
    if (previousIdentities === null) {
      try {
        await readFile(statePath);
        clearAll = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        clearAll = true;
      }
    }
    const clearedRecord = encodeTrafficSpeed(null);

    let matched = 0;
    let written = 0;
    let outOfBounds = 0;
    let closedEdges = 0;
    let cappedEdges = 0;
    let overridesUnresolved = 0;
    const writtenObservationIds = new Set<string>();
    // Observations with at least one override edge that did NOT resolve. They
    // are subtracted from the written set at the end, so a partially-applied
    // event never claims the graph covers it.
    const unresolvedObservationIds = new Set<string>();
    // Keyed by identity so the reconciliation below can compare "written this
    // cycle" vs "previous" on tar-stable coordinates, never on byte offsets.
    const writtenIdentities = new Map<string, EdgeIdentity>();
    const touchedTileDataOffsets = new Set<number>();

    const noteOutOfBounds = (id: EdgeIdentity, directedEdgeCount: number): void => {
      outOfBounds++;
      deps.logger?.warn("traffic-live: edge index out of range, skipping write", {
        level: id.level,
        tile: id.tile,
        index: id.index,
        directedEdgeCount,
      });
    };

    // Everything to write is PLANNED per edge before a single byte moves, so an
    // edge that has both a live speed and an override resolves to exactly one
    // record — `planned`'s key is the same `level:tile:index` the state file
    // persists, which is what lets the two sources merge instead of racing.
    const planned = new Map<string, PlannedWrite>();

    for (const row of rows) {
      const edges = deps.waysToEdges.get(row.wayId);
      if (!edges || edges.length === 0) continue;
      matched++;

      const offsets = resolveOffsets(deps.waysToEdges, idxMap, row.wayId, row.dir, noteOutOfBounds);
      for (const offset of offsets) {
        planned.set(edgeKey(offset.identity), {
          offset,
          kph: row.currentKph,
          closed: false,
          capped: false,
          observationId: null,
          contributorIds: [],
        });
      }
    }

    for (const override of deps.overrides?.values() ?? []) {
      const offset = resolveIdentityOffset(idxMap, override.edge, noteOutOfBounds);
      if (offset === null) {
        overridesUnresolved++;
        for (const id of override.contributorIds ?? [override.observationId])
          unresolvedObservationIds.add(id);
        continue;
      }
      const key = edgeKey(override.edge);
      const previous = planned.get(key);
      if (override.closed) {
        // A closure outranks any live speed: the record becomes CLOSED, never
        // a (possibly very low) speed the costing would still route over.
        planned.set(key, {
          offset,
          kph: null,
          closed: true,
          capped: false,
          observationId: override.observationId,
          contributorIds: [
            ...new Set([
              ...(previous?.contributorIds ?? []),
              ...(override.contributorIds ?? [override.observationId]),
            ]),
          ],
        });
        continue;
      }
      if (
        !previous?.closed &&
        (previous?.kph == null ||
          previous.kph < 2 ||
          !Number.isFinite(override.capKph) ||
          override.capKph < 2)
      ) {
        overridesUnresolved++;
        for (const id of override.contributorIds ?? [override.observationId])
          unresolvedObservationIds.add(id);
        continue;
      }
      // `closed` survives the merge so a cap can never revive an edge a closure
      // already took, without the writer having to trust the caller's map.
      const closed = previous?.closed ?? false;
      planned.set(key, {
        offset,
        kph: previous?.kph != null ? Math.min(previous.kph, override.capKph) : override.capKph,
        closed,
        capped: !closed,
        // A cap that lost to an existing closure changed nothing on this edge,
        // so the closure's observation stays the one credited with the record.
        observationId: closed ? (previous?.observationId ?? null) : override.observationId,
        contributorIds: [
          ...new Set([
            ...(previous?.contributorIds ?? []),
            ...(override.contributorIds ?? [override.observationId]),
          ]),
        ],
      });
    }

    const identities = new Map((previousIdentities ?? []).map((id) => [edgeKey(id), id]));
    for (const { offset } of planned.values())
      identities.set(edgeKey(offset.identity), offset.identity);
    const requestedDeadline =
      deps.validUntil === undefined ? Date.now() + 120_000 : Date.parse(deps.validUntil);
    if (!Number.isFinite(requestedDeadline)) throw new Error("Invalid traffic write deadline");
    const validUntil = Math.min(requestedDeadline, Date.now() + 120_000);
    const journal: TrafficJournal = {
      schemaVersion: 1,
      graphGeneration,
      phase: "pending",
      writeId: deps.writeId ?? randomUUID(),
      routingGraphGeneration: deps.graphGeneration ?? null,
      engineBootId: deps.engineBootId ?? null,
      validUntil,
      identities: [...identities.values()],
      ...(clearAll ? { uncertain: true } : {}),
    };
    if (
      deps.expectedGraphGeneration &&
      (await readTrafficGraphGeneration(dirname(deps.tarPath))) !== deps.expectedGraphGeneration
    )
      throw new Error("Traffic graph changed during planning");
    await saveJournal(statePath, journal);
    if (clearAll) {
      // Unknown journal state: clear every current record in place, never guess
      // whether an old edge identity still names the same road after a rebuild.
      for (const entry of idxMap.values()) {
        const start = entry.dataOffset + TRAFFIC_TILE_HEADER_SIZE;
        const end = start + entry.directedEdgeCount * TRAFFIC_SPEED_RECORD_SIZE;
        for (let offset = start; offset < end; offset += 1024 * 1024) {
          const block = Buffer.alloc(Math.min(1024 * 1024, end - offset));
          if (readSync(fd, block, 0, block.length, offset) !== block.length)
            throw new Error("Truncated traffic records during recovery");
          let changed = false;
          for (let i = 0; i < block.length; i += TRAFFIC_SPEED_RECORD_SIZE) {
            if (((block.readBigUInt64LE(i) >> 28n) & 0xffn) !== 0n) {
              clearedRecord.copy(block, i);
              changed = true;
            }
          }
          if (changed) writeSync(fd, block, 0, block.length, offset);
        }
      }
    }
    if (validUntil <= Date.now()) planned.clear();
    for (const { offset, kph, closed, capped, contributorIds } of planned.values()) {
      const record = closed ? encodeClosedTrafficSpeed() : encodeTrafficSpeed(kph);
      writeSync(fd, record, 0, TRAFFIC_SPEED_RECORD_SIZE, offset.recordOffset);
      written++;
      if (closed) closedEdges++;
      if (capped) cappedEdges++;
      // Recorded only here, after the record is on disk; the unresolved set is
      // subtracted below so a partly-written observation drops out entirely.
      for (const id of contributorIds) writtenObservationIds.add(id);
      writtenIdentities.set(edgeKey(offset.identity), offset.identity);
      touchedTileDataOffsets.add(offset.dataOffset);
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
        if (writtenIdentities.has(edgeKey(identity))) continue;
        const stale = resolveIdentityOffset(idxMap, identity);
        if (stale === null) continue;
        writeSync(fd, clearedRecord, 0, TRAFFIC_SPEED_RECORD_SIZE, stale.recordOffset);
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

    fsyncSync(fd);
    await saveIdentities(statePath, writtenIdentities.values());
    await saveJournal(statePath, {
      ...journal,
      phase: "committed",
      identities: [...writtenIdentities.values()],
      uncertain: false,
    });

    const result = {
      written,
      matched,
      total,
      outOfBounds,
      closedEdges,
      cappedEdges,
      overridesUnresolved,
      appliedObservationIds: [...writtenObservationIds]
        .filter((id) => !unresolvedObservationIds.has(id))
        .sort(),
    };
    try {
      await recordTrafficGraphSuccess(deps.evidencePath ?? trafficEvidencePath(statePath), {
        ...result,
        graphIdentity: deps.expectedGraphGeneration ?? null,
        validUntil: new Date(validUntil).toISOString(),
      });
    } catch (evidenceErr) {
      // The binary publication and runtime state are already durable. Evidence
      // is an observation sidecar; a filesystem failure must not make callers
      // fall back to an older applied-condition set or report the write as
      // failed after traffic.tar was changed.
      deps.logger?.warn("traffic-live: publication evidence write failed", {
        err: (evidenceErr as Error).message,
      });
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

interface TrafficJournal {
  schemaVersion: 1;
  graphGeneration: string;
  writeId?: string;
  routingGraphGeneration?: string | null;
  engineBootId?: string | null;
  phase: "pending" | "committed";
  validUntil: number;
  identities: EdgeIdentity[];
  uncertain?: boolean;
}

async function readJournal(statePath: string): Promise<TrafficJournal | null> {
  let raw: string;
  try {
    raw = await readFile(`${statePath}.journal.json`, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const value = JSON.parse(raw) as TrafficJournal;
  if (
    value.schemaVersion !== 1 ||
    !value.graphGeneration ||
    !["pending", "committed"].includes(value.phase) ||
    !Number.isFinite(value.validUntil) ||
    value.validUntil > Date.now() + 120_000 ||
    (value.uncertain !== undefined && typeof value.uncertain !== "boolean") ||
    !Array.isArray(value.identities) ||
    value.identities.some(
      (id) => !id || ![id.level, id.tile, id.index].every((n) => Number.isSafeInteger(n) && n >= 0),
    )
  )
    throw new Error("Corrupt traffic journal");
  return value;
}
async function saveJournal(statePath: string, journal: TrafficJournal): Promise<void> {
  await atomicWriteFile(`${statePath}.journal.json`, JSON.stringify(journal), {
    durability: "full",
    mode: 0o600,
    createParentDirectory: true,
  });
}

/** Bounded acquisition: the independent supervisor fences a hung owner. */
async function withTrafficLock<T>(statePath: string, work: () => Promise<T>): Promise<T> {
  const lock = `${statePath}.lock`;
  await mkdir(dirname(statePath), { recursive: true });
  await mkdir(lock, { mode: 0o700 });
  try {
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      { mode: 0o600 },
    );
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function writeLiveTraffic(
  deps: WriteLiveTrafficDeps,
): Promise<WriteLiveTrafficResult> {
  return withTrafficLock(deps.statePath || defaultStatePath(), () => writeLiveTrafficLocked(deps));
}

/** No network, source parsing or way-map loading: safe to run in a separate process. */
export async function expireLiveTraffic(deps: {
  tarPath: string;
  statePath: string;
  now?: number;
}): Promise<boolean> {
  return withTrafficLock(deps.statePath, async () => {
    try {
      const journal = await readJournal(deps.statePath);
      if (journal?.phase === "committed" && journal.validUntil > (deps.now ?? Date.now()))
        return false;
    } catch {
      /* Corrupt journal forces a complete, bounds-checked clear. */
    }
    await writeLiveTrafficLocked({
      ...deps,
      csv: "way_id,dir,current_kph,free_flow_kph,los\n",
      waysToEdges: new Map(),
    });
    return true;
  });
}
