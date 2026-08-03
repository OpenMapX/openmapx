import type { OfflineArchiveFile } from "./types";

const HEADER_LENGTH = 127;
const MAGIC = "PMTiles";
const VERSION = 3;
const NONE = 1;
const GZIP = 2;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

export interface LocalPmtilesHeader {
  rootOffset: number;
  rootLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafOffset: number;
  leafLength: number;
  tileDataOffset: number;
  tileDataLength: number;
  addressedTiles: number;
  tileEntries: number;
  tileContents: number;
  clustered: boolean;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  bounds: { west: number; south: number; east: number; north: number };
}

interface DirectoryEntry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

function readUint64(view: DataView, offset: number): number {
  let value = 0;
  for (let index = 7; index >= 0; index--) value = value * 256 + view.getUint8(offset + index);
  if (!Number.isSafeInteger(value)) throw new Error("PMTiles offset exceeds browser limits");
  return value;
}

function parseHeader(bytes: Uint8Array): LocalPmtilesHeader {
  if (
    bytes.byteLength < HEADER_LENGTH ||
    new TextDecoder().decode(bytes.subarray(0, 7)) !== MAGIC
  ) {
    throw new Error("invalid PMTiles header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(7) !== VERSION) throw new Error("unsupported PMTiles version");
  const position = (offset: number) => view.getInt32(offset, true) / 10_000_000;
  return {
    rootOffset: readUint64(view, 8),
    rootLength: readUint64(view, 16),
    metadataOffset: readUint64(view, 24),
    metadataLength: readUint64(view, 32),
    leafOffset: readUint64(view, 40),
    leafLength: readUint64(view, 48),
    tileDataOffset: readUint64(view, 56),
    tileDataLength: readUint64(view, 64),
    addressedTiles: readUint64(view, 72),
    tileEntries: readUint64(view, 80),
    tileContents: readUint64(view, 88),
    clustered: view.getUint8(96) === 1,
    internalCompression: view.getUint8(97),
    tileCompression: view.getUint8(98),
    tileType: view.getUint8(99),
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101),
    bounds: {
      west: position(102),
      south: position(106),
      east: position(110),
      north: position(114),
    },
  };
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let multiplier = 1;
  let offset = start;
  while (offset < bytes.byteLength) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) throw new Error("PMTiles directory value is too large");
    if ((byte & 0x80) === 0) return { value, next: offset };
    multiplier *= 128;
  }
  throw new Error("truncated PMTiles directory");
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("gzip decompression is unavailable in this browser");
  }
  const decompressor = new DecompressionStream("gzip");
  const output = new Response(decompressor.readable).arrayBuffer();
  const writer = decompressor.writable.getWriter();
  await writer.write(toArrayBuffer(bytes));
  await writer.close();
  return new Uint8Array(await output);
}

async function decodeInternal(bytes: Uint8Array, compression: number): Promise<Uint8Array> {
  if (compression === NONE) return bytes;
  if (compression === GZIP) return await gunzip(bytes);
  throw new Error(`unsupported PMTiles internal compression ${compression}`);
}

async function decodeDirectory(bytes: Uint8Array, compression: number): Promise<DirectoryEntry[]> {
  const data = await decodeInternal(bytes, compression);
  let cursor = 0;
  const countResult = readVarint(data, cursor);
  cursor = countResult.next;
  if (countResult.value <= 0 || !Number.isSafeInteger(countResult.value)) {
    throw new Error("invalid PMTiles directory count");
  }
  const entries = Array.from({ length: countResult.value }, () => ({
    tileId: 0,
    offset: 0,
    length: 0,
    runLength: 0,
  }));
  let previousTileId = 0;
  for (const entry of entries) {
    const result = readVarint(data, cursor);
    cursor = result.next;
    entry.tileId = previousTileId + result.value;
    previousTileId = entry.tileId;
  }
  for (const entry of entries) {
    const result = readVarint(data, cursor);
    cursor = result.next;
    entry.runLength = result.value;
  }
  for (const entry of entries) {
    const result = readVarint(data, cursor);
    cursor = result.next;
    entry.length = result.value;
  }
  let previousOffset = 0;
  let previousLength = 0;
  entries.forEach((entry, index) => {
    const result = readVarint(data, cursor);
    cursor = result.next;
    entry.offset =
      result.value === 0 && index > 0 ? previousOffset + previousLength : result.value - 1;
    previousOffset = entry.offset;
    previousLength = entry.length;
  });
  return entries;
}

function rotate(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
  if (ry === 0) {
    if (rx === 1) {
      x = n - 1 - x;
      y = n - 1 - y;
    }
    return [y, x];
  }
  return [x, y];
}

function zxyToTileId(z: number, x: number, y: number): number {
  const n = 2 ** z;
  let distance = 0;
  for (let size = n / 2; size > 0; size = Math.floor(size / 2)) {
    const rx = (x & size) > 0 ? 1 : 0;
    const ry = (y & size) > 0 ? 1 : 0;
    distance += size * size * ((3 * rx) ^ ry);
    [x, y] = rotate(size, x, y, rx, ry);
  }
  return (4 ** z - 1) / 3 + distance;
}

function findEntry(entries: DirectoryEntry[], tileId: number): DirectoryEntry | undefined {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.runLength === 0) {
      const next = entries[index + 1];
      if (tileId >= entry.tileId && (!next || tileId < next.tileId)) return entry;
      if (entry.tileId > tileId) return undefined;
      continue;
    }
    if (tileId >= entry.tileId && tileId < entry.tileId + entry.runLength) return entry;
    if (entry.tileId > tileId) return undefined;
  }
  return undefined;
}

async function readExact(
  file: OfflineArchiveFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const bytes = await file.read(offset, length);
  if (bytes.byteLength !== length) throw new Error("truncated PMTiles archive");
  return bytes;
}

export class LocalPmtilesReader {
  private readonly headerPromise: Promise<LocalPmtilesHeader>;
  private rootPromise: Promise<DirectoryEntry[]> | undefined;

  constructor(private readonly file: OfflineArchiveFile) {
    this.headerPromise = readExact(file, 0, HEADER_LENGTH).then(parseHeader);
  }

  async header(): Promise<LocalPmtilesHeader> {
    return await this.headerPromise;
  }

  async metadata(): Promise<Record<string, unknown>> {
    const header = await this.header();
    const bytes = await decodeInternal(
      await readExact(this.file, header.metadataOffset, header.metadataLength),
      header.internalCompression,
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid PMTiles metadata");
    }
    return parsed as Record<string, unknown>;
  }

  async tile(zoom: number, x: number, y: number): Promise<Uint8Array | undefined> {
    const header = await this.header();
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
    this.rootPromise ??= readExact(this.file, header.rootOffset, header.rootLength).then((bytes) =>
      decodeDirectory(bytes, header.internalCompression),
    );
    let entry = findEntry(await this.rootPromise, tileId);
    if (entry?.runLength === 0) {
      if (header.leafLength === 0) return undefined;
      const leafBytes = await readExact(this.file, header.leafOffset + entry.offset, entry.length);
      entry = findEntry(await decodeDirectory(leafBytes, header.internalCompression), tileId);
    }
    if (!entry || entry.runLength === 0) return undefined;
    const bytes = await readExact(this.file, header.tileDataOffset + entry.offset, entry.length);
    if (header.tileCompression !== GZIP) return bytes;
    return await gunzip(bytes);
  }
}

export async function validateLocalPmtilesArchive(
  file: OfflineArchiveFile,
  expected: { bounds: LocalPmtilesHeader["bounds"]; minZoom: number; maxZoom: number },
): Promise<LocalPmtilesHeader> {
  const reader = new LocalPmtilesReader(file);
  const header = await reader.header();
  if (
    header.minZoom !== expected.minZoom ||
    header.maxZoom !== expected.maxZoom ||
    JSON.stringify(header.bounds) !== JSON.stringify(expected.bounds)
  ) {
    throw new Error("PMTiles metadata does not match the package manifest");
  }
  await reader.metadata();
  return header;
}
