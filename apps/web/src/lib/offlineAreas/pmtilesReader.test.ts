import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { LocalPmtilesReader, validateLocalPmtilesArchive } from "./pmtilesReader";
import type { OfflineArchiveFile } from "./types";

type Entry = { tileId: number; offset: number; length: number; runLength: number };

const expected = {
  bounds: { west: -1, south: -1, east: 1, north: 1 },
  minZoom: 0,
  maxZoom: 0,
};

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function encodeDirectory(entries: readonly Entry[]): Uint8Array {
  const parts = [varint(entries.length)];
  let previousTileId = 0;
  for (const entry of entries) {
    parts.push(varint(entry.tileId - previousTileId));
    previousTileId = entry.tileId;
  }
  for (const entry of entries) parts.push(varint(entry.runLength));
  for (const entry of entries) parts.push(varint(entry.length));
  let nextOffset = 0;
  entries.forEach((entry, index) => {
    parts.push(varint(index > 0 && entry.offset === nextOffset ? 0 : entry.offset + 1));
    nextOffset = entry.offset + entry.length;
  });
  return gzipSync(Buffer.concat(parts));
}

function archiveFile(bytes: Uint8Array): OfflineArchiveFile {
  return {
    size: async () => bytes.byteLength,
    read: async (offset, length) => bytes.slice(offset, offset + length),
    append: async () => {},
    truncate: async () => {},
    flush: async () => {},
    close: async () => {},
  };
}

function fixture(
  options: {
    metadata?: Record<string, unknown>;
    rootEntries?: Entry[];
    rootBytes?: Uint8Array;
    leafEntries?: Entry[];
    leafBytes?: Uint8Array;
    tileData?: Uint8Array;
    tileCompression?: 1 | 2;
    minZoom?: number;
    maxZoom?: number;
    counts?: { addressedTiles: number; tileEntries: number; tileContents: number };
  } = {},
): OfflineArchiveFile {
  const tileData =
    options.tileData ?? new Uint8Array(gzipSync(Buffer.from([0x1a, 0x00, 0x22, 0x00])));
  const leafBytes =
    options.leafBytes ?? (options.leafEntries ? encodeDirectory(options.leafEntries) : undefined);
  const defaultRootEntries: Entry[] = leafBytes
    ? [{ tileId: 0, offset: 0, length: leafBytes.byteLength, runLength: 0 }]
    : [{ tileId: 0, offset: 0, length: tileData.byteLength, runLength: 1 }];
  const rootEntries = options.rootEntries ?? defaultRootEntries;
  const rootBytes = options.rootBytes ?? encodeDirectory(rootEntries);
  const metadataBytes = gzipSync(
    Buffer.from(JSON.stringify(options.metadata ?? { name: "OpenMapX", minzoom: 0 })),
  );
  const leaves = leafBytes ?? new Uint8Array();
  const headerLength = 127;
  const rootOffset = headerLength;
  const metadataOffset = rootOffset + rootBytes.byteLength;
  const leafOffset = metadataOffset + metadataBytes.byteLength;
  const tileDataOffset = leafOffset + leaves.byteLength;
  const bytes = new Uint8Array(tileDataOffset + tileData.byteLength);
  bytes.set(new TextEncoder().encode("PMTiles"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint8(7, 3);
  view.setBigUint64(8, BigInt(rootOffset), true);
  view.setBigUint64(16, BigInt(rootBytes.byteLength), true);
  view.setBigUint64(24, BigInt(metadataOffset), true);
  view.setBigUint64(32, BigInt(metadataBytes.byteLength), true);
  view.setBigUint64(40, BigInt(leafOffset), true);
  view.setBigUint64(48, BigInt(leaves.byteLength), true);
  view.setBigUint64(56, BigInt(tileDataOffset), true);
  view.setBigUint64(64, BigInt(tileData.byteLength), true);
  const tileEntries = [
    ...rootEntries.filter((entry) => entry.runLength > 0),
    ...(options.leafEntries ?? []).filter((entry) => entry.runLength > 0),
  ];
  const counts = options.counts ?? {
    addressedTiles: tileEntries.reduce((total, entry) => total + entry.runLength, 0),
    tileEntries: tileEntries.length,
    tileContents: new Set(tileEntries.map((entry) => `${entry.offset}:${entry.length}`)).size,
  };
  view.setBigUint64(72, BigInt(counts.addressedTiles), true);
  view.setBigUint64(80, BigInt(counts.tileEntries), true);
  view.setBigUint64(88, BigInt(counts.tileContents), true);
  view.setUint8(96, 1);
  view.setUint8(97, 2);
  view.setUint8(98, options.tileCompression ?? 2);
  view.setUint8(99, 1);
  view.setUint8(100, options.minZoom ?? expected.minZoom);
  view.setUint8(101, options.maxZoom ?? expected.maxZoom);
  view.setInt32(102, expected.bounds.west * 10_000_000, true);
  view.setInt32(106, expected.bounds.south * 10_000_000, true);
  view.setInt32(110, expected.bounds.east * 10_000_000, true);
  view.setInt32(114, expected.bounds.north * 10_000_000, true);
  bytes.set(rootBytes, rootOffset);
  bytes.set(metadataBytes, metadataOffset);
  bytes.set(leaves, leafOffset);
  bytes.set(tileData, tileDataOffset);
  return archiveFile(bytes);
}

async function failure(task: () => Promise<unknown>): Promise<Error> {
  try {
    await task();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected task to fail");
}

describe("LocalPmtilesReader", () => {
  it("decodes metadata using the header's PMTiles internal compression", async () => {
    const reader = new LocalPmtilesReader(fixture({ metadata: { name: "OpenMapX", minzoom: 0 } }));

    expect(await reader.metadata()).toEqual({ name: "OpenMapX", minzoom: 0 });
  });

  it("validates a direct root and representative compressed tile", async () => {
    expect(await validateLocalPmtilesArchive(fixture(), expected)).toMatchObject({
      addressedTiles: 1,
      tileEntries: 1,
      tileContents: 1,
    });
  });

  it("validates referenced leaf directories", async () => {
    const tileData = new Uint8Array(gzipSync(Buffer.from([0x1a, 0x00])));
    expect(
      await validateLocalPmtilesArchive(
        fixture({
          tileData,
          leafEntries: [{ tileId: 0, offset: 0, length: tileData.byteLength, runLength: 1 }],
        }),
        expected,
      ),
    ).toBeDefined();
  });

  it("rejects a malformed root directory", async () => {
    const error = await failure(() =>
      validateLocalPmtilesArchive(fixture({ rootBytes: gzipSync(Buffer.from([1])) }), expected),
    );
    expect(error.message.toLowerCase()).toContain("directory");
  });

  it("rejects a leaf range outside the declared leaf section", async () => {
    const leafEntries = [{ tileId: 0, offset: 0, length: 4, runLength: 1 }];
    const leafBytes = encodeDirectory(leafEntries);
    const error = await failure(() =>
      validateLocalPmtilesArchive(
        fixture({
          leafBytes,
          leafEntries,
          rootEntries: [{ tileId: 0, offset: 0, length: leafBytes.byteLength + 1, runLength: 0 }],
          counts: { addressedTiles: 1, tileEntries: 1, tileContents: 1 },
        }),
        expected,
      ),
    );
    expect(error.message.toLowerCase()).toContain("leaf");
  });

  it("rejects a malformed referenced leaf directory", async () => {
    const malformedLeaf = gzipSync(Buffer.from([1]));
    const error = await failure(() =>
      validateLocalPmtilesArchive(
        fixture({
          leafBytes: malformedLeaf,
          counts: { addressedTiles: 1, tileEntries: 1, tileContents: 1 },
        }),
        expected,
      ),
    );
    expect(error.message.toLowerCase()).toContain("directory");
  });

  it("rejects a tile entry outside the declared tile-data section", async () => {
    const tileData = new Uint8Array([1]);
    const error = await failure(() =>
      validateLocalPmtilesArchive(
        fixture({
          tileData,
          tileCompression: 1,
          rootEntries: [{ tileId: 0, offset: 0, length: 2, runLength: 1 }],
        }),
        expected,
      ),
    );
    expect(error.message.toLowerCase()).toContain("tile data");
  });

  it("rejects corrupt representative gzip tile data", async () => {
    const error = await failure(() =>
      validateLocalPmtilesArchive(
        fixture({ tileData: new Uint8Array([0x1f, 0x8b, 0x00]) }),
        expected,
      ),
    );
    expect(Boolean(error)).toBe(true);
  });

  it("reconciles semantic directory counts with the header", async () => {
    const error = await failure(() =>
      validateLocalPmtilesArchive(
        fixture({ counts: { addressedTiles: 2, tileEntries: 2, tileContents: 1 } }),
        expected,
      ),
    );
    expect(error.message.toLowerCase()).toContain("tile counts");
  });

  it("rejects tile entries below the declared minimum zoom", async () => {
    const zoomOne = { ...expected, minZoom: 1, maxZoom: 1 };
    const error = await failure(() =>
      validateLocalPmtilesArchive(fixture({ minZoom: 1, maxZoom: 1 }), zoomOne),
    );

    expect(error.message.toLowerCase()).toContain("zoom range");
  });

  it("rejects a directory with no tiles at the declared minimum zoom", async () => {
    const throughZoomOne = { ...expected, maxZoom: 1 };
    const tileData = new Uint8Array(gzipSync(Buffer.from([0x1a, 0x00])));
    const error = await failure(() =>
      validateLocalPmtilesArchive(
        fixture({
          maxZoom: 1,
          tileData,
          rootEntries: [{ tileId: 1, offset: 0, length: tileData.byteLength, runLength: 1 }],
        }),
        throughZoomOne,
      ),
    );

    expect(error.message.toLowerCase()).toContain("minimum zoom");
  });

  it("rejects a directory with no tiles at the declared maximum zoom", async () => {
    const throughZoomOne = { ...expected, maxZoom: 1 };
    const error = await failure(() =>
      validateLocalPmtilesArchive(fixture({ maxZoom: 1 }), throughZoomOne),
    );

    expect(error.message.toLowerCase()).toContain("maximum zoom");
  });
});
