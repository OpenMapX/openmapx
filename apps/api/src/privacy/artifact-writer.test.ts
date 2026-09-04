import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { EncryptedBlobStore } from "./artifact-storage.js";
import { archivePathForLogicalId, PrivacyArchiveWriter } from "./artifact-writer.js";
import { loadMasterKeyRing } from "./crypto.js";

describe("PrivacyArchiveWriter", () => {
  it("maps only registered historical OpenMapX backup members", () => {
    expect(archivePathForLogicalId("backup-openmapx-auth-accounts")).toBe(
      "openmapx-data-export/article-15/history/openmapx/auth-accounts.jsonl",
    );
    expect(archivePathForLogicalId("backup-openmapx-portable-saved-places")).toBe(
      "openmapx-data-export/portable/history/openmapx/saved-places.jsonl",
    );
    expect(archivePathForLogicalId("backup-openmapx-secrets")).toBeNull();
    const reference = "a".repeat(64);
    expect(archivePathForLogicalId(`backup-${reference}-openmapx-auth-accounts`)).toBe(
      `openmapx-data-export/article-15/history/${reference}/openmapx/auth-accounts.jsonl`,
    );
    expect(archivePathForLogicalId(`backup-${reference}-dawarich-portable-areas`)).toBe(
      `openmapx-data-export/portable/history/${reference}/dawarich/areas.jsonl`,
    );
    expect(archivePathForLogicalId(`backup-${reference}-openmapx-secrets`)).toBeNull();
  });

  it("uses the pinned ZipArchive and streams a bounded ZIP64 archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmapx-archive-test-"));
    const ring = loadMasterKeyRing({
      env: {
        NODE_ENV: "development",
        OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 8).toString("base64url"),
      },
    });
    const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
    const large = Readable.from(
      (async function* () {
        for (let i = 0; i < 128; i++) yield Buffer.alloc(8_192, 65 + (i % 20));
      })(),
    );
    const result = await new PrivacyArchiveWriter(store).writeArchive({
      requestId: "r1",
      artifactId: "a1",
      entries: [
        { logicalId: "readme-text", source: Buffer.from("hello") },
        { logicalId: "other", source: large },
      ],
    });
    expect(result.entries).toHaveLength(2);
    expect(result.plaintextBytes).toBeGreaterThan(1_000);
    const encrypted = await readFile(result.path);
    expect(encrypted.includes(Buffer.from("hello"))).toBe(false);
    const chunks: Buffer[] = [];
    await store.decryptTo(result, (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    const zip = Buffer.concat(chunks);
    expect(zip.includes(Buffer.from("openmapx-data-export/README.txt"))).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true); // ZIP64 EOCD signature
  });

  it("maps only registered logical IDs and rejects duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmapx-archive-test-"));
    const ring = loadMasterKeyRing({
      env: {
        NODE_ENV: "development",
        OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 9).toString("base64url"),
      },
    });
    const store = new EncryptedBlobStore({ root, ring, deploymentId: "test" });
    const writer = new PrivacyArchiveWriter(store);
    await expect(
      writer.writeArchive({
        requestId: "r",
        artifactId: "a",
        entries: [{ logicalId: "not-registered", source: Buffer.from("x") }],
      }),
    ).rejects.toThrow("registered");
    await expect(
      writer.writeArchive({
        requestId: "r",
        artifactId: "a",
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
  it("aborts backpressured source streams when storage fails", async () => {
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    const store = {
      write: vi.fn().mockRejectedValue(new Error("disk-full")),
    } as unknown as EncryptedBlobStore;
    await expect(
      new PrivacyArchiveWriter(store).writeArchive({
        requestId: "r",
        artifactId: "a",
        entries: [{ logicalId: "other", source }],
      }),
    ).rejects.toThrow("disk-full");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(source.destroyed).toBe(true);
  });
  it("cancels earlier streams when a later member fails validation", async () => {
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    const store = { write: vi.fn() } as unknown as EncryptedBlobStore;
    await expect(
      new PrivacyArchiveWriter(store).writeArchive({
        requestId: "r",
        artifactId: "a",
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
