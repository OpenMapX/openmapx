import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { archivePathForLogicalId, PrivacyArchiveWriter } from "./archive-writer.js";

function collectingSink(): { sink: Writable; bytes: () => Buffer } {
  const chunks: Buffer[] = [];
  return {
    sink: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    bytes: () => Buffer.concat(chunks),
  };
}

describe("PrivacyArchiveWriter", () => {
  it("maps no retained-backup history or supplement members", () => {
    expect(archivePathForLogicalId("backup-openmapx-auth-accounts")).toBeNull();
    expect(archivePathForLogicalId("supplements-manifest")).toBeNull();
    expect(archivePathForLogicalId("supplement-1")).toBeNull();
    expect(archivePathForLogicalId("dawarich-account")).toBe(
      "openmapx-data-export/article-15/timeline/dawarich/account.json",
    );
  });

  it("streams a bounded ZIP64 archive straight into the sink", async () => {
    const large = Readable.from(
      (async function* () {
        for (let i = 0; i < 128; i++) yield Buffer.alloc(8_192, 65 + (i % 20));
      })(),
    );
    const { sink, bytes } = collectingSink();
    const result = await new PrivacyArchiveWriter().writeArchive({
      sink,
      entries: [
        { logicalId: "readme-text", source: Buffer.from("hello") },
        { logicalId: "other", source: large },
      ],
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]?.bytes).toBe(128 * 8_192);
    const zip = bytes();
    expect(zip.includes(Buffer.from("openmapx-data-export/README.txt"))).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true); // ZIP64 EOCD signature
  });

  it("maps only registered logical IDs and rejects duplicates", async () => {
    const writer = new PrivacyArchiveWriter();
    await expect(
      writer.writeArchive({
        sink: new PassThrough(),
        entries: [{ logicalId: "not-registered", source: Buffer.from("x") }],
      }),
    ).rejects.toThrow("registered");
    await expect(
      writer.writeArchive({
        sink: new PassThrough(),
        entries: [
          { logicalId: "readme-text", source: Buffer.from("x") },
          { logicalId: "readme-text", source: Buffer.from("y") },
        ],
      }),
    ).rejects.toThrow("duplicate");
  });

  it("maps content-addressed Dawarich files into fixed namespaces", () => {
    const id = `dawarich-import-file-${"a".repeat(64)}.json`;
    expect(archivePathForLogicalId(id)).toBe(
      `openmapx-data-export/article-15/timeline/dawarich/import-files/${"a".repeat(64)}.json`,
    );
    expect(archivePathForLogicalId(`dawarich-portable-points-2026-09`)).toBe(
      "openmapx-data-export/portable/timeline/dawarich/points/2026/09.jsonl",
    );
    expect(archivePathForLogicalId("dawarich-import-file-../secret.bin")).toBeNull();
  });

  it("aborts backpressured source streams when the client goes away", async () => {
    let sourceReads = 0;
    const source = new Readable({
      read() {
        sourceReads += 1;
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    const disconnected = new Error("client-disconnected");
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback(disconnected);
      },
    });
    await expect(
      new PrivacyArchiveWriter().writeArchive({ sink, entries: [{ logicalId: "other", source }] }),
    ).rejects.toBe(disconnected);
    expect(sourceReads).toBeGreaterThan(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(source.destroyed).toBe(true);
  });

  it("cancels earlier streams when a later member fails validation", async () => {
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    await expect(
      new PrivacyArchiveWriter().writeArchive({
        sink: new PassThrough(),
        entries: [
          { logicalId: "other", source },
          { logicalId: "readme-text", source: Buffer.from("x"), bytes: 2 },
        ],
      }),
    ).rejects.toThrow("byte count mismatch");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(source.destroyed).toBe(true);
  });
});
