import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EncryptedSourceSpool, janitorEncryptedSourceSpools } from "./encrypted-source-spool.js";

describe("EncryptedSourceSpool", () => {
  it("bounds plaintext chunks, persists only ciphertext and removes its directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-spool-test-"));
    const plaintext = Buffer.alloc(32 * 1024 * 1024, 0x5a);
    let yielded = 0;
    const spool = await EncryptedSourceSpool.create({ parentDirectory: parent });
    const entry = await spool.write({
      logicalId: "dawarich-points-2026-01",
      mediaType: "application/jsonl",
      bytes: plaintext.byteLength,
      content: (async function* () {
        for (let offset = 0; offset < plaintext.length; offset += 16 * 1024) {
          yielded += 1;
          yield plaintext.subarray(offset, offset + 16 * 1024);
        }
      })(),
    });
    expect(yielded).toBe(plaintext.byteLength / (16 * 1024));
    const stored = await readFile(spool.filesForTesting()[0]);
    expect(stored.includes(plaintext.subarray(0, 64 * 1024))).toBe(false);

    const restored: Buffer[] = [];
    let maxChunk = 0;
    for await (const rawChunk of entry.source as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(rawChunk);
      maxChunk = Math.max(maxChunk, chunk.byteLength);
      restored.push(chunk);
    }
    const restoredBytes = Buffer.concat(restored);
    expect(restoredBytes.byteLength).toBe(plaintext.byteLength);
    expect(createHash("sha256").update(restoredBytes).digest("hex")).toBe(
      createHash("sha256").update(plaintext).digest("hex"),
    );
    expect(maxChunk).toBeLessThanOrEqual(64 * 1024);
    await spool.dispose();
    expect(await readdir(parent)).toEqual([]);
  });

  it("removes partial ciphertext when the source fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-spool-test-"));
    const spool = await EncryptedSourceSpool.create({ parentDirectory: parent });
    await expect(
      spool.write({
        logicalId: "dawarich-points-2026-01",
        mediaType: "application/jsonl",
        bytes: 2,
        content: (async function* () {
          yield Buffer.from("x");
          throw new Error("source-failed");
        })(),
      }),
    ).rejects.toThrow("source-failed");
    await spool.dispose();
    expect(await readdir(parent)).toEqual([]);
  });

  it("accepts a streamed member whose final byte count is not known up front", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-spool-test-"));
    const spool = await EncryptedSourceSpool.create({ parentDirectory: parent });
    const entry = await spool.write({
      logicalId: "saved-content",
      mediaType: "application/jsonl",
      content: (async function* () {
        yield Buffer.from("one\n");
        yield Buffer.from("two\n");
      })(),
    });
    expect(entry.bytes).toBe(8);
    await spool.dispose();
  });

  it("uses unique files for concurrent writes and propagates missing ciphertext", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-spool-test-"));
    const spool = await EncryptedSourceSpool.create({ parentDirectory: parent });
    const [first, second] = await Promise.all(
      ["first", "second"].map((value, index) =>
        spool.write({
          logicalId: `dawarich-${value}`,
          mediaType: "application/json",
          bytes: value.length,
          content: (async function* () {
            if (index > 0) await new Promise<void>((resolve) => setImmediate(resolve));
            yield Buffer.from(value);
          })(),
        }),
      ),
    );
    expect(new Set(spool.filesForTesting()).size).toBe(2);
    await import("node:fs/promises").then(({ rm }) => rm(spool.filesForTesting()[0]));
    await expect(async () => {
      for await (const _chunk of first.source as AsyncIterable<Uint8Array>) void _chunk;
    }).rejects.toMatchObject({ code: "ENOENT" });
    const chunks: Buffer[] = [];
    for await (const chunk of second.source as AsyncIterable<Uint8Array>)
      chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("second");
    await spool.dispose();
  });

  it("janitors only old owned cases from dead processes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-spool-test-"));
    const spool = await EncryptedSourceSpool.create({ parentDirectory: parent });
    await spool.write({
      logicalId: "dawarich-test",
      mediaType: "application/json",
      bytes: 1,
      content: (async function* () {
        yield Buffer.from("x");
      })(),
    });
    const directory = dirname(spool.filesForTesting()[0]);
    await writeFile(
      join(directory, "marker.json"),
      `${JSON.stringify({
        marker: "openmapx-encrypted-source-spool-v1",
        pid: 2 ** 30,
        processInstance: "dead-process-instance",
      })}\n`,
    );
    const old = new Date(Date.now() - 3 * 60 * 60 * 1_000);
    await utimes(directory, old, old);
    await expect(janitorEncryptedSourceSpools(parent)).resolves.toEqual({
      removed: 1,
      retained: 0,
    });
    expect(await readdir(parent)).toEqual([]);
  });

  it("janitors an old case when its PID was reused by another process instance", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-spool-test-"));
    const spool = await EncryptedSourceSpool.create({ parentDirectory: parent });
    await spool.write({
      logicalId: "saved-content",
      mediaType: "application/jsonl",
      bytes: 2,
      content: (async function* () {
        yield Buffer.from("x\n");
      })(),
    });
    const directory = dirname(spool.filesForTesting()[0]);
    await writeFile(
      join(directory, "marker.json"),
      `${JSON.stringify({
        marker: "openmapx-encrypted-source-spool-v1",
        pid: process.pid,
        processInstance: "an-older-process-with-the-same-pid",
      })}\n`,
    );
    const old = new Date(Date.now() - 3 * 60 * 60 * 1_000);
    await utimes(directory, old, old);
    await expect(janitorEncryptedSourceSpools(parent)).resolves.toEqual({
      removed: 1,
      retained: 0,
    });
  });

  it("enforces member, total, and file limits while removing failed ciphertext", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-source-spool-test-"));
    const spool = await EncryptedSourceSpool.create({
      parentDirectory: parent,
      maxMemberBytes: 4,
      maxTotalBytes: 6,
      maxFiles: 3,
    });
    await expect(
      spool.write({
        logicalId: "saved-content",
        mediaType: "application/jsonl",
        content: (async function* () {
          yield Buffer.from("12345");
        })(),
      }),
    ).rejects.toThrow("member byte limit");
    expect(spool.filesForTesting()).toEqual([]);
    await spool.write({
      logicalId: "account",
      mediaType: "application/json",
      content: (async function* () {
        yield Buffer.from("1234");
      })(),
    });
    await expect(
      spool.write({
        logicalId: "authentication",
        mediaType: "application/json",
        content: (async function* () {
          yield Buffer.from("123");
        })(),
      }),
    ).rejects.toThrow("total byte limit");
    await expect(
      spool.write({
        logicalId: "privacy-case-records",
        mediaType: "application/jsonl",
        content: (async function* () {
          yield Buffer.from("1");
        })(),
      }),
    ).rejects.toThrow("file limit");
    await spool.dispose();
  });
});
