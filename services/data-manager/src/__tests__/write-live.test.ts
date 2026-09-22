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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EdgeOverride, edgeKey } from "../jobs/traffic/conditions-to-edges.js";
import { createLiveTrafficWriter } from "../jobs/traffic/live-writer-client.js";
import { encodeClosedTrafficSpeed, encodeTrafficSpeed } from "../jobs/traffic/traffic-speed.js";
import type { WayEdge } from "../jobs/traffic/ways-to-edges.js";
import { writeLiveTraffic as writeDirect } from "../jobs/traffic/write-live.js";

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

/** Reads a 32-byte TrafficTileHeader off disk, independent of the writer's own offsets. */
function readTileHeader(tarPath: string, dataOffset: number) {
  const fd = openSync(tarPath, "r");
  try {
    const h = Buffer.alloc(TRAFFIC_TILE_HEADER_SIZE);
    readSync(fd, h, 0, TRAFFIC_TILE_HEADER_SIZE, dataOffset);
    return {
      tileId: h.readBigUInt64LE(0),
      lastUpdate: h.readBigUInt64LE(8),
      directedEdgeCount: h.readUInt32LE(16),
      version: h.readUInt32LE(20),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * The invariants a real Valhalla checks when it loads a traffic tile — if any
 * drift, Valhalla silently DISCARDS the whole tile (bug #4's signature). Any
 * write path that corrupts the header fails here even though the unit under
 * test never runs Valhalla.
 */
function expectTileValhallaValid(
  tarPath: string,
  dataOffset: number,
  expected: { baseGraphId: bigint; edgeCount: number; version: number },
): void {
  const h = readTileHeader(tarPath, dataOffset);
  expect(h.tileId).toBe(expected.baseGraphId);
  expect(h.directedEdgeCount).toBe(expected.edgeCount);
  expect(h.version).toBe(expected.version);
}

function forwardRecordOffset(): number {
  return TILE_DATA_OFFSET + TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * FORWARD_INDEX;
}
function backwardRecordOffset(): number {
  return TILE_DATA_OFFSET + TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * BACKWARD_INDEX;
}

describe.each(["direct", "worker"] as const)("writeLiveTraffic %s", (mode) => {
  const owner = createLiveTrafficWriter();
  const writeLiveTraffic = mode === "direct" ? writeDirect : owner.write;
  afterAll(() => owner.close());
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

    expect(result).toEqual({
      written: 1,
      matched: 1,
      total: 1,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });

    const { overall, breakpoint1 } = decodeOverallAndBreakpoint1(
      readRecordBytes(tarPath, forwardRecordOffset()),
    );
    expect(overall).toBe(50); // floor(100 / 2)
    expect(breakpoint1).toBe(255); // whole-edge breakpoint, valid record
  });

  it("keeps the tile header Valhalla-valid across write then staleness-clear cycles", async () => {
    const baseGraphId = (BigInt(TILE) << 3n) | BigInt(LEVEL);
    const wayId = 5001;
    const waysToEdges = new Map<number, WayEdge[]>([
      [wayId, [{ forward: true, level: LEVEL, tile: TILE, index: FORWARD_INDEX }]],
    ]);
    const valid = { baseGraphId, edgeCount: EDGE_COUNT, version: 3 };

    // Cycle 1 — write a live speed.
    await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges,
      csv: `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,100,120,heavy`,
    });
    // directed_edge_count (offset 16), version (20), tile_id (0) must all survive
    // — Valhalla silently discards the entire tile if the count is garbage.
    expectTileValhallaValid(tarPath, TILE_DATA_OFFSET, valid);
    // last_update (offset 8), not offset 16, is stamped with a recent epoch.
    expect(readTileHeader(tarPath, TILE_DATA_OFFSET).lastUpdate).toBeGreaterThan(1_700_000_000n);

    // Cycle 2 — the edge disappears, so the staleness path clears it. That write
    // path must not corrupt the header either.
    await writeLiveTraffic({
      tarPath,
      statePath,
      waysToEdges,
      csv: "way_id,dir,current_kph,free_flow_kph,los",
    });
    expectTileValhallaValid(tarPath, TILE_DATA_OFFSET, valid);
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
    expect(second).toEqual({
      written: 0,
      matched: 0,
      total: 0,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });

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
    expect(first).toEqual({
      written: 1,
      matched: 1,
      total: 1,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });
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
    expect(second).toEqual({
      written: 0,
      matched: 0,
      total: 1,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });

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
    expect(result).toEqual({
      written: 0,
      matched: 0,
      total: 0,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });

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
    expect(result).toEqual({
      written: 0,
      matched: 0,
      total: 0,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });

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
    expect(result).toEqual({
      written: 1,
      matched: 1,
      total: 1,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });

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

    expect(result).toEqual({
      written: 0,
      matched: 0,
      total: 1,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });

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

    expect(result).toEqual({
      written: 0,
      matched: 1,
      total: 1,
      outOfBounds: 1,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });
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

    expect(result).toEqual({
      written: 1,
      matched: 1,
      total: 3,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: [],
    });
  });
});

const EMPTY_CSV = "way_id,dir,current_kph,free_flow_kph,los\n";
const FORWARD_EDGE: WayEdge = { forward: true, level: LEVEL, tile: TILE, index: FORWARD_INDEX };
const BACKWARD_EDGE: WayEdge = { forward: false, level: LEVEL, tile: TILE, index: BACKWARD_INDEX };

function overrideMap(
  ...entries: (EdgeOverride & { edge: WayEdge })[]
): Map<string, EdgeOverride & { edge: WayEdge }> {
  return new Map(entries.map((entry) => [edgeKey(entry.edge), entry]));
}

describe.each(["direct", "worker"] as const)("writeLiveTraffic overrides %s", (mode) => {
  const owner = createLiveTrafficWriter();
  const writeLiveTraffic = mode === "direct" ? writeDirect : owner.write;
  afterAll(() => owner.close());
  let dir: string;
  let tarPath: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openmapx-traffic-live-ovr-"));
    tarPath = join(dir, "traffic.tar");
    statePath = join(dir, "live-state.json");
    writeFileSync(tarPath, buildFixtureTar({ level: LEVEL, tile: TILE, edgeCount: EDGE_COUNT }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("retains every overlapping contributor and rejects partial contributors", async () => {
    const result = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map(),
      overrides: overrideMap(
        {
          closed: true,
          observationId: "winner",
          contributorIds: ["winner", "overlap", "partial"],
          edge: FORWARD_EDGE,
        },
        {
          closed: true,
          observationId: "partial",
          contributorIds: ["partial"],
          edge: { ...BACKWARD_EDGE, index: EDGE_COUNT + 1 },
        },
      ),
    });
    expect(result.appliedObservationIds).toEqual(["overlap", "winner"]);
  });

  it("rejects a corrupt tile index before any byte write or file extension", async () => {
    const bad = readFileSync(tarPath);
    bad.writeBigUInt64LE(BigInt(bad.length + 4096), 512);
    writeFileSync(tarPath, bad);
    await expect(
      writeLiveTraffic({
        tarPath,
        statePath,
        csv: EMPTY_CSV,
        waysToEdges: new Map(),
        overrides: overrideMap({ closed: true, observationId: "a", edge: FORWARD_EDGE }),
      }),
    ).rejects.toThrow(/traffic/i);
    expect(readFileSync(tarPath)).toEqual(bad);
  });

  it("refuses writes while the authority holds a graph-maintenance fence", async () => {
    const before = readFileSync(tarPath);
    writeFileSync(join(dir, ".traffic-maintenance.json"), "{}");
    await expect(
      writeLiveTraffic({ tarPath, statePath, csv: EMPTY_CSV, waysToEdges: new Map() }),
    ).rejects.toThrow(/maintenance/);
    expect(readFileSync(tarPath)).toEqual(before);
  });

  it("keys an edge exactly as the writer keys the identity it persists", () => {
    expect(edgeKey(FORWARD_EDGE)).toBe(`${LEVEL}:${TILE}:${FORWARD_INDEX}`);
  });

  it("writes a closed record for an override edge that has no CSV row", async () => {
    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides: overrideMap({ closed: true, observationId: "a:1", edge: FORWARD_EDGE }),
    });

    expect(res).toEqual({
      written: 1,
      matched: 0,
      total: 0,
      outOfBounds: 0,
      closedEdges: 1,
      cappedEdges: 0,
      overridesUnresolved: 0,
      appliedObservationIds: ["a:1"],
    });
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeClosedTrafficSpeed());
  });

  it("caps a live speed and writes the cap alone when there is no live speed", async () => {
    const wayId = 6001;
    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,100,120,free_flow\n`,
      waysToEdges: new Map<number, WayEdge[]>([[wayId, [FORWARD_EDGE, BACKWARD_EDGE]]]),
      overrides: overrideMap(
        { closed: false, capKph: 60, observationId: "rw", edge: FORWARD_EDGE },
        { closed: false, capKph: 60, observationId: "rw", edge: BACKWARD_EDGE },
      ),
    });

    // `written` is 2, not 3: the forward edge's CSV row and its cap merge into
    // ONE planned record because both key on `level:tile:index`.
    expect(res).toEqual({
      written: 1,
      matched: 1,
      total: 1,
      outOfBounds: 0,
      closedEdges: 0,
      cappedEdges: 1,
      overridesUnresolved: 1,
      appliedObservationIds: [],
    });
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeTrafficSpeed(60));
    expect(readRecordBytes(tarPath, backwardRecordOffset())).toEqual(Buffer.alloc(8));
  });

  it("persists a write-ahead journal and expires effects without any upstream fetch", async () => {
    const { expireLiveTraffic } = await import("../jobs/traffic/write-live.js");
    await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map(),
      validUntil: new Date(Date.now() + 1000).toISOString(),
      overrides: overrideMap({ closed: true, observationId: "leased", edge: FORWARD_EDGE }),
      writeId: "95a348cc-14ba-4823-9e32-c72935188acb",
      engineBootId: "e2630bd0-5a85-4c93-9b7d-cf174bd0dd45",
      graphGeneration: "routing-graph-epoch",
    });
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeClosedTrafficSpeed());
    const committed = JSON.parse(readFileSync(`${statePath}.journal.json`, "utf8"));
    expect(committed).toMatchObject({
      phase: "committed",
      writeId: "95a348cc-14ba-4823-9e32-c72935188acb",
      engineBootId: "e2630bd0-5a85-4c93-9b7d-cf174bd0dd45",
      routingGraphGeneration: "routing-graph-epoch",
    });
    await expireLiveTraffic({ tarPath, statePath, now: Date.now() + 2000 });
    const cleared = JSON.parse(readFileSync(`${statePath}.journal.json`, "utf8"));
    expect(cleared.writeId).not.toBe(committed.writeId);
    expect(cleared.engineBootId).toBeNull();
    expect(cleared.routingGraphGeneration).toBeNull();
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeTrafficSpeed(null));
  });

  it("recovers an orphaned traffic extract even when both state files are missing", async () => {
    const { expireLiveTraffic } = await import("../jobs/traffic/write-live.js");
    const { rm } = await import("node:fs/promises");
    await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map(),
      overrides: overrideMap({ closed: true, observationId: "orphan", edge: FORWARD_EDGE }),
    });
    await rm(statePath);
    await rm(`${statePath}.journal.json`);
    await expireLiveTraffic({ tarPath, statePath });
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeTrafficSpeed(null));
  });

  it("clears orphaned records when the journal is missing and legacy state is empty", async () => {
    const { expireLiveTraffic } = await import("../jobs/traffic/write-live.js");
    const { rm } = await import("node:fs/promises");
    await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map(),
      overrides: overrideMap({ closed: true, observationId: "orphan", edge: FORWARD_EDGE }),
    });
    writeFileSync(statePath, "[]");
    await rm(`${statePath}.journal.json`);

    await expireLiveTraffic({ tarPath, statePath });

    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeTrafficSpeed(null));
    expect(JSON.parse(readFileSync(`${statePath}.journal.json`, "utf8"))).toMatchObject({
      phase: "committed",
      uncertain: false,
    });
  });

  it("retries a pending uncertain journal with a full clear", async () => {
    const { expireLiveTraffic } = await import("../jobs/traffic/write-live.js");
    await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map(),
      overrides: overrideMap({ closed: true, observationId: "orphan", edge: FORWARD_EDGE }),
    });
    const journal = JSON.parse(readFileSync(`${statePath}.journal.json`, "utf8"));
    writeFileSync(statePath, "[]");
    writeFileSync(
      `${statePath}.journal.json`,
      JSON.stringify({
        ...journal,
        phase: "pending",
        identities: [],
        uncertain: true,
      }),
    );

    await expireLiveTraffic({ tarPath, statePath });

    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeTrafficSpeed(null));
    expect(JSON.parse(readFileSync(`${statePath}.journal.json`, "utf8"))).toMatchObject({
      phase: "committed",
      uncertain: false,
    });
  });

  it("clears all live records when journal contents are corrupt", async () => {
    const { expireLiveTraffic } = await import("../jobs/traffic/write-live.js");
    await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map(),
      overrides: overrideMap({ closed: true, observationId: "leased", edge: FORWARD_EDGE }),
      writeId: "95a348cc-14ba-4823-9e32-c72935188acb",
      engineBootId: "e2630bd0-5a85-4c93-9b7d-cf174bd0dd45",
      graphGeneration: "routing-graph-epoch",
    });
    writeFileSync(`${statePath}.journal.json`, "{broken");
    await expireLiveTraffic({ tarPath, statePath });
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeTrafficSpeed(null));
  });

  it("keeps the live speed when it is already below the cap", async () => {
    const wayId = 6002;
    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,40,120,heavy\n`,
      waysToEdges: new Map<number, WayEdge[]>([[wayId, [FORWARD_EDGE]]]),
      overrides: overrideMap({
        closed: false,
        capKph: 80,
        observationId: "rw",
        edge: FORWARD_EDGE,
      }),
    });

    expect(res.cappedEdges).toBe(1);
    // The cap was in force even though the live speed already satisfied it.
    expect(res.appliedObservationIds).toEqual(["rw"]);
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeTrafficSpeed(40));
  });

  it("closes an edge that also has a live speed (a closure outranks any speed)", async () => {
    const wayId = 6003;
    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: `way_id,dir,current_kph,free_flow_kph,los\n${wayId},f,100,120,free_flow\n`,
      waysToEdges: new Map<number, WayEdge[]>([[wayId, [FORWARD_EDGE]]]),
      overrides: overrideMap({ closed: true, observationId: "a:2", edge: FORWARD_EDGE }),
    });

    expect(res.closedEdges).toBe(1);
    expect(res.written).toBe(1);
    expect(res.appliedObservationIds).toEqual(["a:2"]);
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeClosedTrafficSpeed());
  });

  it("a lifted closure is cleared to unknown on the next cycle", async () => {
    await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides: overrideMap({ closed: true, observationId: "a:1", edge: FORWARD_EDGE }),
    });
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeClosedTrafficSpeed());

    await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides: new Map(),
    });

    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeTrafficSpeed(null));
  });

  it("skips (never writes) an override edge whose index is past the tile's edge count", async () => {
    const outOfRangeIndex = EDGE_COUNT;
    const outOfRangeOffset =
      TILE_DATA_OFFSET + TRAFFIC_TILE_HEADER_SIZE + TRAFFIC_SPEED_RECORD_SIZE * outOfRangeIndex;
    const warn = vi.fn();

    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides: overrideMap({
        closed: true,
        observationId: "a:3",
        edge: { forward: true, level: LEVEL, tile: TILE, index: outOfRangeIndex },
      }),
      logger: { warn },
    });

    // Both counters fire: `outOfBounds` is the tar/way-map version-mismatch
    // signal regardless of source, `overridesUnresolved` is "overrides that
    // could not be applied at all".
    expect(res).toEqual({
      written: 0,
      matched: 0,
      total: 0,
      outOfBounds: 1,
      closedEdges: 0,
      cappedEdges: 0,
      overridesUnresolved: 1,
      // The closure never reached the tar, so its observation must NOT be
      // credited: a caller that trusted this would skip its own exclusion.
      appliedObservationIds: [],
    });
    expect(readRecordBytes(tarPath, outOfRangeOffset)).toEqual(
      Buffer.alloc(TRAFFIC_SPEED_RECORD_SIZE, 0),
    );
  });

  it("counts (without warning) an override edge whose tile is absent from index.bin", async () => {
    const warn = vi.fn();
    const before = readFileSync(tarPath);

    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides: overrideMap({
        closed: true,
        observationId: "a:4",
        edge: { forward: true, level: LEVEL, tile: TILE + 4242, index: 0 },
      }),
      logger: { warn },
    });

    // A missing tile is NOT a tar/way-map mismatch (it's a way this Valhalla
    // graph doesn't have), so it must not inflate `outOfBounds` — but a dropped
    // closure can't vanish without a trace either.
    expect(res.written).toBe(0);
    expect(res.outOfBounds).toBe(0);
    expect(res.overridesUnresolved).toBe(1);
    // Nothing was written, so nothing may be claimed as applied.
    expect(res.appliedObservationIds).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(readFileSync(tarPath)).toEqual(before);
  });

  it("withdraws an observation whose edges were only PARTLY written", async () => {
    // One closure spanning two edges: the forward edge resolves, the second is
    // past the tile's edge count. Crediting it would make the router drop the
    // event's point exclusions entirely, leaving the unwritten edge both open
    // in the graph and unexcluded on the request.
    const warn = vi.fn();
    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides: overrideMap(
        { closed: true, observationId: "a:7", edge: FORWARD_EDGE },
        {
          closed: true,
          observationId: "a:7",
          edge: { forward: true, level: LEVEL, tile: TILE, index: EDGE_COUNT },
        },
      ),
      logger: { warn },
    });

    expect(res.written).toBe(1);
    expect(res.closedEdges).toBe(1);
    expect(res.overridesUnresolved).toBe(1);
    expect(res.appliedObservationIds).toEqual([]);
    // The edge that DID resolve is still closed in the tar — the withdrawal is
    // about what we claim, not about writing less.
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeClosedTrafficSpeed());
  });

  it("still credits an observation whose every edge was written", async () => {
    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides: overrideMap(
        { closed: true, observationId: "a:8", edge: FORWARD_EDGE },
        { closed: true, observationId: "a:8", edge: BACKWARD_EDGE },
      ),
    });

    expect(res.written).toBe(2);
    expect(res.overridesUnresolved).toBe(0);
    expect(res.appliedObservationIds).toEqual(["a:8"]);
  });

  it("withdrawing one observation leaves another fully-written one credited", async () => {
    const warn = vi.fn();
    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides: overrideMap(
        { closed: true, observationId: "partial", edge: FORWARD_EDGE },
        {
          closed: true,
          observationId: "partial",
          edge: { forward: true, level: LEVEL, tile: TILE, index: EDGE_COUNT },
        },
        { closed: true, observationId: "complete", edge: BACKWARD_EDGE },
      ),
      logger: { warn },
    });

    expect(res.appliedObservationIds).toEqual(["complete"]);
  });

  it("keeps an edge closed when a cap override also lands on it", async () => {
    // Two overrides on ONE edge can only happen when the caller's map keys
    // disagree with `edgeKey`; the writer must still not let a cap revive a
    // closed edge, rather than trusting the upstream map's invariant.
    const overrides = new Map<string, EdgeOverride & { edge: WayEdge }>([
      ["closure", { closed: true, observationId: "a:6", edge: FORWARD_EDGE }],
      ["cap", { closed: false, capKph: 30, observationId: "rw", edge: FORWARD_EDGE }],
    ]);

    const res = await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides,
    });

    expect(res.written).toBe(1);
    expect(res.closedEdges).toBe(1);
    expect(res.cappedEdges).toBe(0);
    // Both restrictions are satisfied; retain the cap contributor for future removal.
    expect(res.appliedObservationIds).toEqual(["a:6", "rw"]);
    expect(readRecordBytes(tarPath, forwardRecordOffset())).toEqual(encodeClosedTrafficSpeed());
  });

  it("stamps the tile's last_update when only an override was written", async () => {
    await writeLiveTraffic({
      tarPath,
      statePath,
      csv: EMPTY_CSV,
      waysToEdges: new Map<number, WayEdge[]>(),
      overrides: overrideMap({ closed: true, observationId: "a:5", edge: FORWARD_EDGE }),
    });

    expectTileValhallaValid(tarPath, TILE_DATA_OFFSET, {
      baseGraphId: (BigInt(TILE) << 3n) | BigInt(LEVEL),
      edgeCount: EDGE_COUNT,
      version: 3,
    });
    expect(readTileHeader(tarPath, TILE_DATA_OFFSET).lastUpdate).toBeGreaterThan(1_700_000_000n);
  });
});
