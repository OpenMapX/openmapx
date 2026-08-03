import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { LocalPmtilesReader } from "./pmtilesReader";
import type { OfflineArchiveFile } from "./types";

function metadataArchive(metadata: Record<string, unknown>): OfflineArchiveFile {
  const encoded = gzipSync(Buffer.from(JSON.stringify(metadata)));
  const bytes = new Uint8Array(127 + encoded.byteLength);
  bytes.set(new TextEncoder().encode("PMTiles"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint8(7, 3);
  view.setBigUint64(24, BigInt(127), true);
  view.setBigUint64(32, BigInt(encoded.byteLength), true);
  view.setUint8(97, 2);
  bytes.set(encoded, 127);

  return {
    size: async () => bytes.byteLength,
    read: async (offset, length) => bytes.slice(offset, offset + length),
    append: async () => {},
    truncate: async () => {},
    flush: async () => {},
    close: async () => {},
  };
}

describe("LocalPmtilesReader", () => {
  it("decodes metadata using the header's PMTiles internal compression", async () => {
    const reader = new LocalPmtilesReader(metadataArchive({ name: "OpenMapX", minzoom: 10 }));

    expect(await reader.metadata()).toEqual({ name: "OpenMapX", minzoom: 10 });
  });
});
