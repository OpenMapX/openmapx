import type { OfflineArchiveFile } from "./types";

const HEADER_LENGTH = 127;
const MAGIC = "PMTiles";
const VERSION = 3;
const NONE = 1;
const GZIP = 2;
const MVT = 1;

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

function validateHeader(header: LocalPmtilesHeader, archiveSize: number): LocalPmtilesHeader {
  if (!Number.isSafeInteger(archiveSize) || archiveSize < HEADER_LENGTH) {
    throw new Error("invalid PMTiles archive size");
  }
  if (![NONE, GZIP].includes(header.internalCompression)) {
    throw new Error(`unsupported PMTiles internal compression ${header.internalCompression}`);
  }
  if (![NONE, GZIP].includes(header.tileCompression)) {
    throw new Error(`unsupported PMTiles tile compression ${header.tileCompression}`);
  }
  if (header.tileType !== MVT) throw new Error("offline PMTiles archive is not vector tile data");
  if (header.minZoom > header.maxZoom || header.maxZoom > 24) {
    throw new Error("invalid PMTiles zoom range");
  }
  const { west, south, east, north } = header.bounds;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    east > 180 ||
    south < -85.05112878 ||
    north > 85.05112878 ||
    east <= west ||
    north <= south
  ) {
    throw new Error("invalid PMTiles bounds");
  }
  for (const [label, offset, length] of [
    ["root", header.rootOffset, header.rootLength],
    ["metadata", header.metadataOffset, header.metadataLength],
    ["leaf", header.leafOffset, header.leafLength],
    ["tile data", header.tileDataOffset, header.tileDataLength],
  ] as const) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < HEADER_LENGTH ||
      length < 0 ||
      offset > archiveSize - length
    ) {
      throw new Error(`invalid PMTiles ${label} section`);
    }
  }
  const sections = [
    ["root", header.rootOffset, header.rootLength],
    ["metadata", header.metadataOffset, header.metadataLength],
    ["leaf", header.leafOffset, header.leafLength],
    ["tile data", header.tileDataOffset, header.tileDataLength],
  ] as const;
  for (let index = 1; index < sections.length; index++) {
    const previous = sections[index - 1];
    const current = sections[index];
    if (current[1] < previous[1] + previous[2]) {
      throw new Error(`PMTiles ${current[0]} section overlaps ${previous[0]} section`);
    }
  }
  if (header.rootLength === 0 || header.metadataLength === 0 || header.tileDataLength === 0) {
    throw new Error("PMTiles archive is missing required sections");
  }
  if (
    header.addressedTiles <= 0 ||
    header.tileEntries <= 0 ||
    header.tileContents <= 0 ||
    !Number.isSafeInteger(header.addressedTiles) ||
    !Number.isSafeInteger(header.tileEntries) ||
    !Number.isSafeInteger(header.tileContents) ||
    header.tileEntries > header.addressedTiles ||
    header.tileContents > header.tileEntries
  ) {
    throw new Error("invalid PMTiles tile counts");
  }
  return header;
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
    if (multiplier > Number.MAX_SAFE_INTEGER / 128) {
      throw new Error("PMTiles directory value is too large");
    }
    multiplier *= 128;
  }
  throw new Error("truncated PMTiles directory");
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("gzip decompression is unavailable in this browser");
  }
  const compressed = new Response(toArrayBuffer(bytes)).body;
  if (!compressed) throw new Error("unable to read gzip-compressed PMTiles data");
  const decompressed = compressed.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(decompressed).arrayBuffer());
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
  if (countResult.value > Math.floor((data.byteLength - cursor) / 4)) {
    throw new Error("PMTiles directory count exceeds its encoded size");
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
  if (cursor !== data.byteLength) throw new Error("PMTiles directory has trailing data");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (
      entry.length <= 0 ||
      entry.offset < 0 ||
      !Number.isSafeInteger(entry.length) ||
      !Number.isSafeInteger(entry.offset) ||
      !Number.isSafeInteger(entry.runLength) ||
      !Number.isSafeInteger(entry.tileId + entry.runLength) ||
      (index > 0 && entry.tileId <= entries[index - 1].tileId)
    ) {
      throw new Error("invalid PMTiles directory entry");
    }
  }
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
  private readonly leaves = new Map<string, Promise<DirectoryEntry[]>>();

  constructor(private readonly file: OfflineArchiveFile) {
    this.headerPromise = Promise.all([file.size(), readExact(file, 0, HEADER_LENGTH)]).then(
      ([size, bytes]) => validateHeader(parseHeader(bytes), size),
    );
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

  private async rootDirectory(header: LocalPmtilesHeader): Promise<DirectoryEntry[]> {
    this.rootPromise ??= readExact(this.file, header.rootOffset, header.rootLength).then((bytes) =>
      decodeDirectory(bytes, header.internalCompression),
    );
    return await this.rootPromise;
  }

  private async leafDirectory(
    header: LocalPmtilesHeader,
    entry: DirectoryEntry,
  ): Promise<DirectoryEntry[]> {
    if (header.leafLength === 0 || entry.offset > header.leafLength - entry.length) {
      throw new Error("PMTiles leaf entry exceeds the leaf directory section");
    }
    const key = `${entry.offset}:${entry.length}`;
    let leaf = this.leaves.get(key);
    if (!leaf) {
      leaf = readExact(this.file, header.leafOffset + entry.offset, entry.length).then((bytes) =>
        decodeDirectory(bytes, header.internalCompression),
      );
      this.leaves.set(key, leaf);
    }
    return await leaf;
  }

  private async tilePayload(
    header: LocalPmtilesHeader,
    entry: DirectoryEntry,
  ): Promise<Uint8Array> {
    if (entry.offset > header.tileDataLength - entry.length) {
      throw new Error("PMTiles tile entry exceeds the tile data section");
    }
    const bytes = await readExact(this.file, header.tileDataOffset + entry.offset, entry.length);
    return header.tileCompression === GZIP ? await gunzip(bytes) : bytes;
  }

  /** Traverse every directory and verify its semantic relationship to the header. */
  async validate(): Promise<void> {
    const header = await this.header();
    const root = await this.rootDirectory(header);
    const tileEntries: DirectoryEntry[] = [];
    const leafRanges: Array<{ offset: number; length: number }> = [];

    for (let index = 0; index < root.length; index++) {
      const entry = root[index];
      if (entry.runLength > 0) {
        tileEntries.push(entry);
        continue;
      }

      const leaf = await this.leafDirectory(header, entry);
      if (leaf.some((candidate) => candidate.runLength === 0)) {
        throw new Error("PMTiles leaf directory contains a nested directory pointer");
      }
      const nextRootTileId = root[index + 1]?.tileId;
      if (
        leaf.some(
          (candidate) =>
            candidate.tileId < entry.tileId ||
            (nextRootTileId !== undefined && candidate.tileId >= nextRootTileId),
        )
      ) {
        throw new Error("PMTiles leaf directory lies outside its root tile range");
      }
      leafRanges.push({ offset: entry.offset, length: entry.length });
      tileEntries.push(...leaf);
    }

    leafRanges.sort((a, b) => a.offset - b.offset || a.length - b.length);
    for (let index = 1; index < leafRanges.length; index++) {
      const previous = leafRanges[index - 1];
      const current = leafRanges[index];
      if (current.offset < previous.offset + previous.length) {
        throw new Error("PMTiles leaf directory ranges overlap");
      }
    }

    tileEntries.sort((a, b) => a.tileId - b.tileId);
    const minimumTileId = (4 ** header.minZoom - 1) / 3;
    const minimumZoomEnd = (4 ** (header.minZoom + 1) - 1) / 3;
    const maximumZoomStart = (4 ** header.maxZoom - 1) / 3;
    const tileIdLimit = (4 ** (header.maxZoom + 1) - 1) / 3;
    let addressedTiles = 0;
    const contents = new Map<string, DirectoryEntry>();
    for (let index = 0; index < tileEntries.length; index++) {
      const entry = tileEntries[index];
      if (
        entry.runLength <= 0 ||
        entry.tileId < minimumTileId ||
        entry.tileId + entry.runLength > tileIdLimit
      ) {
        throw new Error("PMTiles tile entry is outside the declared zoom range");
      }
      const previous = tileEntries[index - 1];
      if (previous && entry.tileId < previous.tileId + previous.runLength) {
        throw new Error("PMTiles tile entry address ranges overlap");
      }
      if (entry.offset > header.tileDataLength - entry.length) {
        throw new Error("PMTiles tile entry exceeds the tile data section");
      }
      addressedTiles += entry.runLength;
      if (!Number.isSafeInteger(addressedTiles)) {
        throw new Error("PMTiles addressed tile count exceeds browser limits");
      }
      contents.set(`${entry.offset}:${entry.length}`, entry);
    }

    const firstEntry = tileEntries[0];
    const lastEntry = tileEntries[tileEntries.length - 1];
    if (!firstEntry || firstEntry.tileId >= minimumZoomEnd) {
      throw new Error("PMTiles archive contains no tiles at the declared minimum zoom");
    }
    if (!lastEntry || lastEntry.tileId + lastEntry.runLength <= maximumZoomStart) {
      throw new Error("PMTiles archive contains no tiles at the declared maximum zoom");
    }

    const contentRanges = [...contents.values()].sort(
      (a, b) => a.offset - b.offset || a.length - b.length,
    );
    for (let index = 1; index < contentRanges.length; index++) {
      const previous = contentRanges[index - 1];
      const current = contentRanges[index];
      if (current.offset < previous.offset + previous.length) {
        throw new Error("PMTiles tile content ranges overlap");
      }
    }

    if (
      addressedTiles !== header.addressedTiles ||
      tileEntries.length !== header.tileEntries ||
      contents.size !== header.tileContents
    ) {
      throw new Error("PMTiles directory tile counts do not match the header");
    }

    const payload = await this.tilePayload(header, firstEntry);
    if (payload.byteLength === 0) throw new Error("PMTiles representative tile payload is empty");
  }

  async close(): Promise<void> {
    this.leaves.clear();
    await this.file.close();
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
    let entry = findEntry(await this.rootDirectory(header), tileId);
    if (entry?.runLength === 0) {
      entry = findEntry(await this.leafDirectory(header, entry), tileId);
    }
    if (!entry || entry.runLength === 0) return undefined;
    return await this.tilePayload(header, entry);
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
  await reader.validate();
  return header;
}
