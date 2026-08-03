import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import type { CanonicalOfflinePackageRequest, OfflinePackageBbox } from "@openmapx/core";

const PMTILES_HEADER_LENGTH = 127;
const PMTILES_ROOT_MAX_COMPRESSED_LENGTH = 16_257;
const PMTILES_MAGIC = "PMTiles";
const PMTILES_VERSION = 3;
const INTERNAL_COMPRESSION_GZIP = 2;
const TILE_COMPRESSION_NONE = 1;
const TILE_COMPRESSION_GZIP = 2;
const TILE_TYPE_MVT = 1;

export interface PmtilesPackageOptions {
  sourceMbtilesPath: string;
  destinationPath: string;
  request: CanonicalOfflinePackageRequest;
}

export interface PmtilesPackageMetadata {
  byteLength: number;
  sha256: string;
  etag: string;
  bounds: OfflinePackageBbox;
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  tileCompression: "none" | "gzip";
  attribution: string[];
  sourceBytesRead: number;
  destinationBytesWritten: number;
  temporaryBytesPeak: number;
}

interface PmtilesHeader {
  rootOffset: bigint;
  rootLength: bigint;
  metadataOffset: bigint;
  metadataLength: bigint;
  leafOffset: bigint;
  leafLength: bigint;
  tileDataOffset: bigint;
  tileDataLength: bigint;
  addressedTiles: bigint;
  tileEntries: bigint;
  tileContents: bigint;
  clustered: boolean;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  bounds: OfflinePackageBbox;
  centerZoom: number;
  center: { longitude: number; latitude: number };
}

interface TileEntry {
  tileId: bigint;
  offset: bigint;
  length: number;
  runLength: number;
  data?: Buffer;
}

interface DirectorySections {
  root: Buffer;
  leaves: Buffer;
  leafCount: number;
}

function writeVarint(value: bigint): Buffer {
  if (value < 0n) throw new Error("PMTiles varint cannot encode a negative value");
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function readVarint(buffer: Buffer, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7n;
    if (shift > 70n) throw new Error("invalid PMTiles varint");
  }
  throw new Error("truncated PMTiles varint");
}

function encodeDirectory(entries: TileEntry[]): Buffer {
  if (entries.length === 0) throw new Error("PMTiles directory cannot be empty");
  const parts: Buffer[] = [writeVarint(BigInt(entries.length))];
  let previousTileId = 0n;
  for (const entry of entries) {
    parts.push(writeVarint(entry.tileId - previousTileId));
    previousTileId = entry.tileId;
  }
  for (const entry of entries) parts.push(writeVarint(BigInt(entry.runLength)));
  for (const entry of entries) parts.push(writeVarint(BigInt(entry.length)));
  let nextByte = 0n;
  entries.forEach((entry, index) => {
    parts.push(writeVarint(index > 0 && entry.offset === nextByte ? 0n : entry.offset + 1n));
    nextByte = entry.offset + BigInt(entry.length);
  });
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

function decodeDirectory(encoded: Buffer, compression: number): TileEntry[] {
  if (compression !== INTERNAL_COMPRESSION_GZIP) {
    throw new Error(`unsupported PMTiles internal compression ${compression}`);
  }
  const buffer = gunzipSync(encoded);
  let cursor = 0;
  const countResult = readVarint(buffer, cursor);
  cursor = countResult.next;
  const count = Number(countResult.value);
  if (!Number.isSafeInteger(count) || count <= 0)
    throw new Error("invalid PMTiles directory count");

  const entries: TileEntry[] = Array.from({ length: count }, () => ({
    tileId: 0n,
    offset: 0n,
    length: 0,
    runLength: 0,
  }));
  let previousTileId = 0n;
  for (const entry of entries) {
    const result = readVarint(buffer, cursor);
    cursor = result.next;
    previousTileId += result.value;
    entry.tileId = previousTileId;
  }
  for (const entry of entries) {
    const result = readVarint(buffer, cursor);
    cursor = result.next;
    entry.runLength = Number(result.value);
  }
  for (const entry of entries) {
    const result = readVarint(buffer, cursor);
    cursor = result.next;
    entry.length = Number(result.value);
  }
  let previousOffset = 0n;
  let previousLength = 0;
  entries.forEach((entry, index) => {
    const result = readVarint(buffer, cursor);
    cursor = result.next;
    entry.offset =
      result.value === 0n && index > 0
        ? previousOffset + BigInt(previousLength)
        : result.value - 1n;
    previousOffset = entry.offset;
    previousLength = entry.length;
  });
  return entries;
}

function rotateHilbert(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
  if (ry === 0) {
    if (rx === 1) {
      x = n - 1 - x;
      y = n - 1 - y;
    }
    return [y, x];
  }
  return [x, y];
}

function zxyToTileId(z: number, x: number, y: number): bigint {
  const n = 2 ** z;
  let d = 0;
  let currentX = x;
  let currentY = y;
  for (let size = n / 2; size > 0; size = Math.floor(size / 2)) {
    const rx = (currentX & size) > 0 ? 1 : 0;
    const ry = (currentY & size) > 0 ? 1 : 0;
    d += size * size * ((3 * rx) ^ ry);
    [currentX, currentY] = rotateHilbert(size, currentX, currentY, rx, ry);
  }
  return (4n ** BigInt(z) - 1n) / 3n + BigInt(d);
}

function lonToTileX(longitude: number, zoom: number): number {
  return Math.max(0, Math.min(2 ** zoom - 1, Math.floor(((longitude + 180) / 360) * 2 ** zoom)));
}

function latToTileY(latitude: number, zoom: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return Math.max(
    0,
    Math.min(
      2 ** zoom - 1,
      Math.floor(((1 - Math.log((1 + sin) / (1 - sin)) / (2 * Math.PI)) / 2) * 2 ** zoom),
    ),
  );
}

function readMbtilesMetadata(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare("SELECT name, value FROM metadata").all() as Array<{
    name: string;
    value: string;
  }>;
  return new Map(rows.map((row) => [row.name, String(row.value)]));
}

function detectTileCompression(metadata: Map<string, string>, tiles: Buffer[]): number {
  const compression = metadata.get("compression")?.toLowerCase();
  if (compression === "gzip" || compression === "gz") return TILE_COMPRESSION_GZIP;
  if (compression === "none" || compression === "" || compression === undefined) {
    return tiles.every((tile) => tile.length >= 2 && tile[0] === 0x1f && tile[1] === 0x8b)
      ? TILE_COMPRESSION_GZIP
      : TILE_COMPRESSION_NONE;
  }
  throw new Error(`unsupported MBTiles tile compression ${compression}`);
}

function metadataJson(
  metadata: Map<string, string>,
  request: CanonicalOfflinePackageRequest,
): Buffer {
  let parsed: Record<string, unknown> = {};
  const rawJson = metadata.get("json");
  if (rawJson) {
    try {
      const candidate = JSON.parse(rawJson) as unknown;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      throw new Error("MBTiles json metadata is invalid");
    }
  }
  parsed.format = "pbf";
  parsed.type = "baselayer";
  parsed.version = request.source.datasetVersion;
  parsed.bounds = [
    request.effective.bbox.west,
    request.effective.bbox.south,
    request.effective.bbox.east,
    request.effective.bbox.north,
  ].join(",");
  parsed.minzoom = request.effective.minZoom;
  parsed.maxzoom = request.effective.maxZoom;
  parsed.attribution = request.source.attribution.join(" ");
  return Buffer.from(JSON.stringify(parsed));
}

function writeHeader(header: PmtilesHeader): Buffer {
  const buffer = Buffer.alloc(PMTILES_HEADER_LENGTH);
  buffer.write(PMTILES_MAGIC, 0, "ascii");
  buffer.writeUInt8(PMTILES_VERSION, 7);
  buffer.writeBigUInt64LE(header.rootOffset, 8);
  buffer.writeBigUInt64LE(header.rootLength, 16);
  buffer.writeBigUInt64LE(header.metadataOffset, 24);
  buffer.writeBigUInt64LE(header.metadataLength, 32);
  buffer.writeBigUInt64LE(header.leafOffset, 40);
  buffer.writeBigUInt64LE(header.leafLength, 48);
  buffer.writeBigUInt64LE(header.tileDataOffset, 56);
  buffer.writeBigUInt64LE(header.tileDataLength, 64);
  buffer.writeBigUInt64LE(header.addressedTiles, 72);
  buffer.writeBigUInt64LE(header.tileEntries, 80);
  buffer.writeBigUInt64LE(header.tileContents, 88);
  buffer.writeUInt8(header.clustered ? 1 : 0, 96);
  buffer.writeUInt8(header.internalCompression, 97);
  buffer.writeUInt8(header.tileCompression, 98);
  buffer.writeUInt8(header.tileType, 99);
  buffer.writeUInt8(header.minZoom, 100);
  buffer.writeUInt8(header.maxZoom, 101);
  buffer.writeInt32LE(Math.round(header.bounds.west * 10_000_000), 102);
  buffer.writeInt32LE(Math.round(header.bounds.south * 10_000_000), 106);
  buffer.writeInt32LE(Math.round(header.bounds.east * 10_000_000), 110);
  buffer.writeInt32LE(Math.round(header.bounds.north * 10_000_000), 114);
  buffer.writeUInt8(header.centerZoom, 118);
  buffer.writeInt32LE(Math.round(header.center.longitude * 10_000_000), 119);
  buffer.writeInt32LE(Math.round(header.center.latitude * 10_000_000), 123);
  return buffer;
}

function parseHeader(buffer: Buffer): PmtilesHeader {
  if (buffer.length < PMTILES_HEADER_LENGTH || buffer.toString("ascii", 0, 7) !== PMTILES_MAGIC) {
    throw new Error("invalid PMTiles magic or truncated header");
  }
  if (buffer.readUInt8(7) !== PMTILES_VERSION) throw new Error("unsupported PMTiles version");
  const readPosition = (offset: number): number => buffer.readInt32LE(offset) / 10_000_000;
  return {
    rootOffset: buffer.readBigUInt64LE(8),
    rootLength: buffer.readBigUInt64LE(16),
    metadataOffset: buffer.readBigUInt64LE(24),
    metadataLength: buffer.readBigUInt64LE(32),
    leafOffset: buffer.readBigUInt64LE(40),
    leafLength: buffer.readBigUInt64LE(48),
    tileDataOffset: buffer.readBigUInt64LE(56),
    tileDataLength: buffer.readBigUInt64LE(64),
    addressedTiles: buffer.readBigUInt64LE(72),
    tileEntries: buffer.readBigUInt64LE(80),
    tileContents: buffer.readBigUInt64LE(88),
    clustered: buffer.readUInt8(96) === 1,
    internalCompression: buffer.readUInt8(97),
    tileCompression: buffer.readUInt8(98),
    tileType: buffer.readUInt8(99),
    minZoom: buffer.readUInt8(100),
    maxZoom: buffer.readUInt8(101),
    bounds: {
      west: readPosition(102),
      south: readPosition(106),
      east: readPosition(110),
      north: readPosition(114),
    },
    centerZoom: buffer.readUInt8(118),
    center: { longitude: readPosition(119), latitude: readPosition(123) },
  };
}

function readRange(path: string, offset: bigint, length: bigint): Buffer {
  if (length > BigInt(Number.MAX_SAFE_INTEGER) || offset > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("PMTiles range exceeds JavaScript safe integer limits");
  }
  const size = Number(length);
  const buffer = Buffer.alloc(size);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, size, Number(offset));
    if (bytesRead !== size) throw new Error("truncated PMTiles range");
  } finally {
    closeSync(fd);
  }
  return buffer;
}

function readHeader(path: string): PmtilesHeader {
  return parseHeader(readRange(path, 0n, BigInt(PMTILES_HEADER_LENGTH)));
}

function buildDirectorySections(entries: TileEntry[]): DirectorySections {
  const direct = encodeDirectory(entries);
  if (direct.length <= PMTILES_ROOT_MAX_COMPRESSED_LENGTH) {
    return { root: direct, leaves: Buffer.alloc(0), leafCount: 0 };
  }

  let chunkSize = Math.max(1, Math.ceil(entries.length / 256));
  for (;;) {
    const leafDirectories: Buffer[] = [];
    const rootEntries: TileEntry[] = [];
    for (let start = 0; start < entries.length; start += chunkSize) {
      const leafEntries = entries.slice(start, start + chunkSize);
      const leaf = encodeDirectory(leafEntries);
      rootEntries.push({
        tileId: leafEntries[0].tileId,
        offset: BigInt(leafDirectories.reduce((total, current) => total + current.length, 0)),
        length: leaf.length,
        runLength: 0,
      });
      leafDirectories.push(leaf);
    }
    const root = encodeDirectory(rootEntries);
    if (root.length <= PMTILES_ROOT_MAX_COMPRESSED_LENGTH) {
      return { root, leaves: Buffer.concat(leafDirectories), leafCount: leafDirectories.length };
    }
    if (chunkSize >= entries.length) throw new Error("PMTiles root directory cannot fit in 16 KiB");
    chunkSize = Math.min(entries.length, Math.ceil(chunkSize * 1.75));
  }
}

function readDirectoryEntry(entries: TileEntry[], tileId: bigint): TileEntry | undefined {
  for (const [index, entry] of entries.entries()) {
    if (entry.runLength === 0) {
      const nextEntry = entries[index + 1];
      if (tileId >= entry.tileId && (!nextEntry || tileId < nextEntry.tileId)) return entry;
      if (entry.tileId > tileId) return undefined;
      continue;
    }
    if (tileId >= entry.tileId && tileId < entry.tileId + BigInt(entry.runLength)) return entry;
    if (entry.tileId > tileId) return undefined;
  }
  return undefined;
}

function tilePayload(tile: Buffer, compression: number): Buffer {
  if (compression === TILE_COMPRESSION_NONE) return tile;
  if (compression === TILE_COMPRESSION_GZIP) return gunzipSync(tile);
  throw new Error(`unsupported PMTiles tile compression ${compression}`);
}

export async function hashFile(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function inspectPmtiles(path: string): Promise<PmtilesPackageMetadata> {
  const header = readHeader(path);
  const metadata = JSON.parse(
    readRange(path, header.metadataOffset, header.metadataLength).toString("utf8"),
  ) as { attribution?: string };
  const byteLength = statSync(path).size;
  const sha256 = await hashFile(path);
  return {
    byteLength,
    sha256,
    etag: `sha256-${sha256}`,
    bounds: header.bounds,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    tileCount: Number(header.addressedTiles),
    tileCompression: header.tileCompression === TILE_COMPRESSION_GZIP ? "gzip" : "none",
    attribution: metadata.attribution ? [metadata.attribution] : [],
    sourceBytesRead: 0,
    destinationBytesWritten: byteLength,
    temporaryBytesPeak: 0,
  };
}

export async function validatePmtilesPackage(
  path: string,
  expected: Pick<
    PmtilesPackageMetadata,
    "byteLength" | "sha256" | "bounds" | "minZoom" | "maxZoom"
  >,
): Promise<PmtilesPackageMetadata> {
  const metadata = await inspectPmtiles(path);
  if (metadata.byteLength !== expected.byteLength) throw new Error("PMTiles byte length mismatch");
  if (metadata.sha256 !== expected.sha256) throw new Error("PMTiles checksum mismatch");
  if (metadata.minZoom !== expected.minZoom || metadata.maxZoom !== expected.maxZoom) {
    throw new Error("PMTiles zoom range mismatch");
  }
  if (JSON.stringify(metadata.bounds) !== JSON.stringify(expected.bounds)) {
    throw new Error("PMTiles bounds mismatch");
  }
  return metadata;
}

export async function extractPmtilesPackage(
  options: PmtilesPackageOptions,
): Promise<PmtilesPackageMetadata> {
  if (!existsSync(options.sourceMbtilesPath)) {
    throw new Error(`MBTiles source does not exist: ${options.sourceMbtilesPath}`);
  }
  const temporaryPath = `${options.destinationPath}.part-${randomUUID()}`;
  mkdirSync(dirname(options.destinationPath), { recursive: true });
  if (existsSync(options.destinationPath)) {
    throw new Error(`PMTiles destination already exists: ${options.destinationPath}`);
  }
  const sourceBytesRead = statSync(options.sourceMbtilesPath).size;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(options.sourceMbtilesPath, { readOnly: true });
    const metadata = readMbtilesMetadata(db);
    const tileRows = db.prepare(
      `SELECT zoom_level, tile_column, tile_row, tile_data
         FROM tiles
         WHERE zoom_level BETWEEN ? AND ?
           AND tile_column BETWEEN ? AND ?
           AND tile_row BETWEEN ? AND ?`,
    );
    const tiles: Array<{ tileId: bigint; data: Buffer }> = [];
    for (
      let zoom = options.request.effective.minZoom;
      zoom <= options.request.effective.maxZoom;
      zoom++
    ) {
      const tileCount = 2 ** zoom;
      const xMin = lonToTileX(options.request.effective.bbox.west, zoom);
      const xMax = lonToTileX(options.request.effective.bbox.east, zoom);
      const yMin = latToTileY(options.request.effective.bbox.north, zoom);
      const yMax = latToTileY(options.request.effective.bbox.south, zoom);
      const tmsMin = tileCount - 1 - yMax;
      const tmsMax = tileCount - 1 - yMin;
      const rows = tileRows.all(zoom, zoom, xMin, xMax, tmsMin, tmsMax) as Array<{
        tile_column: number;
        tile_row: number;
        tile_data: Uint8Array;
      }>;
      for (const row of rows) {
        const y = tileCount - 1 - row.tile_row;
        if (y < yMin || y > yMax) continue;
        tiles.push({
          tileId: zxyToTileId(zoom, row.tile_column, y),
          data: Buffer.from(row.tile_data),
        });
      }
    }
    if (tiles.length === 0) throw new Error("no tiles found for requested package coverage");
    tiles.sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));

    const tileCompression = detectTileCompression(
      metadata,
      tiles.map((tile) => tile.data),
    );
    const tileEntries: TileEntry[] = [];
    let tileOffset = 0n;
    for (const tile of tiles) {
      tileEntries.push({
        tileId: tile.tileId,
        offset: tileOffset,
        length: tile.data.length,
        runLength: 1,
        data: tile.data,
      });
      tileOffset += BigInt(tile.data.length);
    }
    const directories = buildDirectorySections(tileEntries);
    const metadataBuffer = metadataJson(metadata, options.request);
    const tileData = Buffer.concat(tiles.map((tile) => tile.data));
    const rootOffset = BigInt(PMTILES_HEADER_LENGTH);
    const metadataOffset = rootOffset + BigInt(directories.root.length);
    const leafOffset = metadataOffset + BigInt(metadataBuffer.length);
    const tileDataOffset = leafOffset + BigInt(directories.leaves.length);
    const bounds = options.request.effective.bbox;
    const header = writeHeader({
      rootOffset,
      rootLength: BigInt(directories.root.length),
      metadataOffset,
      metadataLength: BigInt(metadataBuffer.length),
      leafOffset,
      leafLength: BigInt(directories.leaves.length),
      tileDataOffset,
      tileDataLength: BigInt(tileData.length),
      addressedTiles: BigInt(tiles.length),
      tileEntries: BigInt(tileEntries.length),
      tileContents: BigInt(tiles.length),
      clustered: true,
      internalCompression: INTERNAL_COMPRESSION_GZIP,
      tileCompression,
      tileType: TILE_TYPE_MVT,
      minZoom: options.request.effective.minZoom,
      maxZoom: options.request.effective.maxZoom,
      bounds,
      centerZoom: options.request.effective.minZoom,
      center: {
        longitude: (bounds.west + bounds.east) / 2,
        latitude: (bounds.south + bounds.north) / 2,
      },
    });
    const archive = Buffer.concat([
      header,
      directories.root,
      metadataBuffer,
      directories.leaves,
      tileData,
    ]);
    writeFileSync(temporaryPath, archive, { flag: "wx" });
    const inspected = await inspectPmtiles(temporaryPath);
    renameSync(temporaryPath, options.destinationPath);
    return {
      ...inspected,
      attribution: options.request.source.attribution,
      sourceBytesRead,
      destinationBytesWritten: archive.length,
      temporaryBytesPeak: archive.length,
    };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  } finally {
    db?.close();
  }
}

export async function readPmtilesTile(
  path: string,
  zoom: number,
  x: number,
  y: number,
): Promise<Buffer | undefined> {
  const header = readHeader(path);
  if (
    zoom < header.minZoom ||
    zoom > header.maxZoom ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** zoom ||
    y >= 2 ** zoom
  ) {
    return undefined;
  }
  const tileId = zxyToTileId(zoom, x, y);
  const rootEntries = decodeDirectory(
    readRange(path, header.rootOffset, header.rootLength),
    header.internalCompression,
  );
  let entry = readDirectoryEntry(rootEntries, tileId);
  if (entry?.runLength === 0) {
    if (header.leafLength === 0n) return undefined;
    const leaf = readRange(path, header.leafOffset + entry.offset, BigInt(entry.length));
    entry = readDirectoryEntry(decodeDirectory(leaf, header.internalCompression), tileId);
  }
  if (!entry || entry.runLength === 0) return undefined;
  const tile = readRange(path, header.tileDataOffset + entry.offset, BigInt(entry.length));
  return tilePayload(tile, header.tileCompression);
}
