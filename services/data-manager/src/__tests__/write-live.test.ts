import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WayEdge } from "../jobs/traffic/ways-to-edges.js";
import { writeLiveTraffic } from "../jobs/traffic/write-live.js";

/**
 * Hand-crafted USTAR tar fixture matching the CONFIRMED Valhalla
 * `traffic.tar` layout (validated against a real Valhalla 3.7.0 output on
 * staging, 2026-07-09):
 *   [index.bin: 512-byte USTAR header][index.bin data, padded to 512]
 *   [tile member: 512-byte USTAR header][32-byte TrafficTileHeader + N * 8
 *    zero TrafficSpeed records, padded to 512]
 * which places the tile member's DATA at byte offset 1536 (512 + 512 + 512).
 *
 * All offset math below is independent of `write-live.ts`'s own resolution
 * logic — it's recomputed directly from this fixture's layout so the tests
 * aren't circular.
 */

const USTAR_HEADER_SIZE = 512;
const TILE_DATA_OFFSET = 1536;
const TRAFFIC_TILE_HEADER_SIZE = 32;
const TRAFFIC_SPEED_RECORD_SIZE = 8;

function octalField(value: number, width: number): Buffer {
  const buf = Buffer.alloc(width, 0);
  const digits = value.toString(8).padStart(width - 1, "0");
  buf.write(digits, 0, "ascii");
  return buf;
}

/** Builds one 512-byte USTAR header with a correctly computed checksum. */
function buildUstarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(USTAR_HEADER_SIZE, 0);
  header.write(name, 0, "ascii");
  octalField(0o644, 8).copy(header, 100); // mode
  octalField(0, 8).copy(header, 108); // uid
  octalField(0, 8).copy(header, 116); // gid
  octalField(size, 12).copy(header, 124); // size
  octalField(0, 12).copy(header, 136); // mtime
  header.fill(0x20, 148, 156); // chksum placeholder = 8 ASCII spaces
  header[156] = "0".charCodeAt(0); // typeflag: regular file
  header.write("ustar", 257, "ascii");
  header.write("00", 263, "ascii"); // ustar version

  let sum = 0;
  for (let i = 0; i < USTAR_HEADER_SIZE; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function padTo512(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem, 0)]);
}

function buildTrafficTileHeader(baseGraphId: bigint, edgeCount: number): Buffer {
  const buf = Buffer.alloc(TRAFFIC_TILE_HEADER_SIZE, 0);
  buf.writeBigUInt64LE(baseGraphId, 0); // tile_id
  buf.writeBigUInt64LE(0n, 8); // last_update
  buf.writeUInt32LE(edgeCount, 16); // directed_edge_count
  buf.writeUInt32LE(3, 20); // traffic_tile_version
  buf.writeUInt32LE(0, 24);
  buf.writeUInt32LE(0, 28);
  return buf;
}

function buildFixtureTar(opts: { level: number; tile: number; edgeCount: number }): Buffer {
  const { level, tile, edgeCount } = opts;
  const baseGraphId = (BigInt(tile) << 3n) | BigInt(level);
  const tileMemberSize = TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * edgeCount;
  const tileName = `${level}/000/${String(tile).padStart(3, "0")}.gph`;

  const indexEntry = Buffer.alloc(16);
  indexEntry.writeBigUInt64LE(BigInt(TILE_DATA_OFFSET), 0); // offset
  indexEntry.writeUInt32LE(Number(baseGraphId), 8); // tile_id
  indexEntry.writeUInt32LE(tileMemberSize, 12); // size

  const indexHeader = buildUstarHeader("index.bin", indexEntry.length);
  const indexDataPadded = padTo512(indexEntry);

  const tileHeader = buildUstarHeader(tileName, tileMemberSize);
  const tileData = Buffer.concat([
    buildTrafficTileHeader(baseGraphId, edgeCount),
    Buffer.alloc(TRAFFIC_SPEED_RECORD_SIZE * edgeCount, 0),
  ]);
  const tileDataPadded = padTo512(tileData);

  // Two zero blocks mark end-of-archive, matching a real USTAR tar.
  return Buffer.concat([
    indexHeader,
    indexDataPadded,
    tileHeader,
    tileDataPadded,
    Buffer.alloc(1024, 0),
  ]);
}

/** Reads 8 raw bytes directly off disk at a byte offset computed independently of the writer. */
function readRecordBytes(tarPath: string, recordOffset: number): Buffer {
  const fd = openSync(tarPath, "r");
  try {
    const buf = Buffer.alloc(TRAFFIC_SPEED_RECORD_SIZE);
    readSync(fd, buf, 0, TRAFFIC_SPEED_RECORD_SIZE, recordOffset);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** Unpacks just `overall_encoded_speed` (bits 0-6) and `breakpoint1` (bits 28-35) for assertions. */
function decodeOverallAndBreakpoint1(buf: Buffer): { overall: number; breakpoint1: number } {
  const value = buf.readBigUInt64LE(0);
  const overall = Number(value & 0x7fn);
  const breakpoint1 = Number((value >> 28n) & 0xffn);
  return { overall, breakpoint1 };
}

const LEVEL = 2;
const TILE = 456;
const EDGE_COUNT = 6;
const FORWARD_INDEX = 2;
const BACKWARD_INDEX = 3;

function forwardRecordOffset(): number {
  return TILE_DATA_OFFSET + TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * FORWARD_INDEX;
}
function backwardRecordOffset(): number {
  return TILE_DATA_OFFSET + TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * BACKWARD_INDEX;
}

describe("writeLiveTraffic", () => {
  let dir: string;
  let tarPath: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openmapx-traffic-live-"));
    tarPath = join(dir, "traffic.tar");
    statePath = join(dir, "live-state.json");
    writeFileSync(tarPath, buildFixtureTar({ level: LEVEL, tile: TILE, edgeCount: EDGE_COUNT }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the CSV row's speed to the matching edge's record offset", async () => {
    const wayId = 5001;
    const waysToEdges = new Map<number, WayEdge[]>([
      [wayId, [{ forward: true, level: LEVEL, tile: TILE, index: FORWARD_INDEX }]],
    ]);

    const result = await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges,
      csv: `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,100,120,heavy`,
    });

    expect(result).toEqual({ written: 1, matched: 1, total: 1, outOfBounds: 0 });

    const { overall, breakpoint1 } = decodeOverallAndBreakpoint1(
      readRecordBytes(tarPath, forwardRecordOffset()),
    );
    expect(overall).toBe(50); // floor(100 / 2)
    expect(breakpoint1).toBe(255); // whole-edge breakpoint, valid record
  });

  it("zeroes a previously-written record once it disappears from a later CSV (staleness)", async () => {
    const wayId = 5002;
    const waysToEdges = new Map<number, WayEdge[]>([
      [wayId, [{ forward: true, level: LEVEL, tile: TILE, index: FORWARD_INDEX }]],
    ]);

    await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges,
      csv: `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,100,120,heavy`,
    });
    const written = decodeOverallAndBreakpoint1(readRecordBytes(tarPath, forwardRecordOffset()));
    expect(written.overall).toBe(50);

    const second = await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges,
      csv: "way_id,dir,current_kph,free_flow_kph,los",
    });
    expect(second).toEqual({ written: 0, matched: 0, total: 0, outOfBounds: 0 });

    const cleared = decodeOverallAndBreakpoint1(readRecordBytes(tarPath, forwardRecordOffset()));
    // encodeTrafficSpeed(null): overall = 127 (UNKNOWN_TRAFFIC_SPEED_RAW), breakpoint1 = 0 (invalid/no-data).
    expect(cleared.overall).toBe(127);
    expect(cleared.breakpoint1).toBe(0);
  });

  it("clears a record that stays in the CSV but becomes unresolvable (staleness leak fix)", async () => {
    const wayId = 5004;
    const csv = `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,100,120,heavy`;

    // Run 1: way is mapped, so it's written and recorded in the state file.
    const first = await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges: new Map<number, WayEdge[]>([
        [wayId, [{ forward: true, level: LEVEL, tile: TILE, index: FORWARD_INDEX }]],
      ]),
      csv,
    });
    expect(first).toEqual({ written: 1, matched: 1, total: 1, outOfBounds: 0 });
    expect(
      decodeOverallAndBreakpoint1(readRecordBytes(tarPath, forwardRecordOffset())).overall,
    ).toBe(50);

    // Run 2: SAME CSV row is still present, but the way has been dropped from
    // waysToEdges (e.g. a graph rebuild renumbered it away). The identity from
    // run 1 wasn't re-written, so it's re-resolved via idxMap (bypassing
    // waysToEdges) and cleared — not left stale.
    const second = await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges: new Map<number, WayEdge[]>(),
      csv,
    });
    expect(second).toEqual({ written: 0, matched: 0, total: 1, outOfBounds: 0 });

    const cleared = decodeOverallAndBreakpoint1(readRecordBytes(tarPath, forwardRecordOffset()));
    expect(cleared.overall).toBe(127);
    expect(cleared.breakpoint1).toBe(0);
  });

  it("skips clearing a persisted edge whose index is now out of bounds (rebuilt/shrunk tar)", async () => {
    // Simulate a previous cycle that wrote an edge which, after a traffic.tar
    // rebuild, now has an index past the current tile's directed_edge_count.
    // The clear path must re-resolve + bounds-check and SKIP — never zero at a
    // now-invalid offset that could land in an adjacent tile's header.
    const staleIndex = EDGE_COUNT; // one past the fixture tile's valid 0..5
    writeFileSync(
      statePath,
      JSON.stringify([{ level: LEVEL, tile: TILE, index: staleIndex }]),
      "utf8",
    );
    const before = readFileSync(tarPath);

    const result = await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges: new Map<number, WayEdge[]>(),
      csv: "way_id,dir,current_kph,free_flow_kph,los",
    });
    expect(result).toEqual({ written: 0, matched: 0, total: 0, outOfBounds: 0 });

    // No byte anywhere changed — the out-of-range would-be offset (and the
    // tile-header bytes it would have corrupted) are untouched.
    expect(readFileSync(tarPath)).toEqual(before);
  });

  it("skips clearing a persisted edge whose tile is absent from the current index.bin", async () => {
    // A tile that doesn't exist in the fixture's index.bin at all.
    writeFileSync(
      statePath,
      JSON.stringify([{ level: LEVEL, tile: TILE + 4242, index: 0 }]),
      "utf8",
    );
    const before = readFileSync(tarPath);

    const result = await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges: new Map<number, WayEdge[]>(),
      csv: "way_id,dir,current_kph,free_flow_kph,los",
    });
    expect(result).toEqual({ written: 0, matched: 0, total: 0, outOfBounds: 0 });

    expect(readFileSync(tarPath)).toEqual(before);
  });

  it("only writes the direction-matching edge, leaving the opposite direction untouched", async () => {
    const wayId = 5003;
    const waysToEdges = new Map<number, WayEdge[]>([
      [
        wayId,
        [
          { forward: true, level: LEVEL, tile: TILE, index: FORWARD_INDEX },
          { forward: false, level: LEVEL, tile: TILE, index: BACKWARD_INDEX },
        ],
      ],
    ]);

    const result = await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges,
      csv: `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,100,120,heavy`,
    });
    expect(result).toEqual({ written: 1, matched: 1, total: 1, outOfBounds: 0 });

    const forward = decodeOverallAndBreakpoint1(readRecordBytes(tarPath, forwardRecordOffset()));
    expect(forward.overall).toBe(50);

    const backwardBytes = readRecordBytes(tarPath, backwardRecordOffset());
    expect(backwardBytes).toEqual(Buffer.alloc(TRAFFIC_SPEED_RECORD_SIZE, 0));
  });

  it("counts a way missing from waysToEdges as unmatched and performs no write", async () => {
    const wayId = 9001;
    const waysToEdges = new Map<number, WayEdge[]>();

    const result = await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges,
      csv: `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,80,100,moderate`,
    });

    expect(result).toEqual({ written: 0, matched: 0, total: 1, outOfBounds: 0 });

    // Nothing in the tile's record region was touched.
    const forward = readRecordBytes(tarPath, forwardRecordOffset());
    const backward = readRecordBytes(tarPath, backwardRecordOffset());
    expect(forward).toEqual(Buffer.alloc(TRAFFIC_SPEED_RECORD_SIZE, 0));
    expect(backward).toEqual(Buffer.alloc(TRAFFIC_SPEED_RECORD_SIZE, 0));
  });

  it("skips (never writes) an edge whose index is past the tile's directed_edge_count", async () => {
    const wayId = 9002;
    // The fixture tile has EDGE_COUNT (6) records → valid indices 0..5. An
    // index of EDGE_COUNT is one past the end: a stale waysToEdges vs a
    // freshly rebuilt tar. It must be skipped, not written past the region.
    const outOfRangeIndex = EDGE_COUNT;
    const outOfRangeOffset =
      TILE_DATA_OFFSET + TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * outOfRangeIndex;
    const warn = vi.fn();

    const result = await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges: new Map<number, WayEdge[]>([
        [wayId, [{ forward: true, level: LEVEL, tile: TILE, index: outOfRangeIndex }]],
      ]),
      csv: `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,100,120,heavy`,
      logger: { warn },
    });

    expect(result).toEqual({ written: 0, matched: 1, total: 1, outOfBounds: 1 });
    expect(warn).toHaveBeenCalledWith(
      "traffic-live: edge index out of range, skipping write",
      expect.objectContaining({ index: outOfRangeIndex, directedEdgeCount: EDGE_COUNT }),
    );

    // The bytes at the out-of-range offset were NOT written (still zero).
    expect(readRecordBytes(tarPath, outOfRangeOffset)).toEqual(
      Buffer.alloc(TRAFFIC_SPEED_RECORD_SIZE, 0),
    );
  });

  it("counts every non-blank data row in total, including malformed ones (match-rate denominator)", async () => {
    const wayId = 5005;
    const waysToEdges = new Map<number, WayEdge[]>([
      [wayId, [{ forward: true, level: LEVEL, tile: TILE, index: FORWARD_INDEX }]],
    ]);
    // Three data rows: one good, one with a bad direction, one with a
    // non-numeric way id. All three count toward `total`; only the good one
    // matches and writes.
    const csv = [
      "way_id,dir,current_kph,free_flow_kph,los",
      `${wayId},f,100,120,heavy`,
      `${wayId},x,50,60,light`,
      "notanumber,f,40,60,light",
    ].join("\n");

    const result = await writeLiveTraffic({ tarPath, statePath, waysToEdges, csv });

    expect(result).toEqual({ written: 1, matched: 1, total: 3, outOfBounds: 0 });
  });
});
