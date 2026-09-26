import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DAWARICH_EXPECTED_SCHEMA_FINGERPRINT } from "@openmapx/core/privacy";
import { describe, expect, it } from "vitest";
import {
  type DawarichSourcePartError,
  parseDawarichTar,
  parseDawarichTarStream,
  spoolDawarichTar,
} from "../dawarich-source-part.js";

function member(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000600\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header[156] = 48;
  header.write("        ", 148, 8, "ascii");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function tar(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([
    ...entries.map(([name, content]) => member(name, content)),
    Buffer.alloc(1024),
  ]);
}

const tuple = {
  version: 1,
  image: "freikin/dawarich:1.15.2",
  imageDigest: "sha256:e58334ca56976feb4c885a8bd34b251ec2e3f45ffeabd4fd4371b5d2108fc70d",
  upstreamCommit: "d81abc4fc467e119f542c56602c78488fbab86fb",
  subjectUserIdDigest: "a".repeat(64),
  cutoff: "2026-01-01T00:00:00Z",
  snapshotAt: "2026-01-01T00:00:00Z",
  schemaFingerprint: DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
  collectorContract: "openmapx-subject-export-v1",
  entries: [] as Array<Record<string, unknown>>,
  warnings: [],
};

describe("Dawarich source-part parser", () => {
  it("accepts monthly points and content-addressed attachments across chunks", async () => {
    const points = Buffer.from('{"id":1}\n');
    const attachment = Buffer.from("fixture");
    const pointDigest = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(points).digest("hex"),
    );
    const attachmentDigest = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(attachment).digest("hex"),
    );
    const manifest = Buffer.from(
      JSON.stringify({
        ...tuple,
        entries: [
          {
            id: "points-2026-01",
            bytes: points.byteLength,
            sha256: pointDigest,
            records: 1,
            article15: true,
            portability: true,
            redactionCodes: [],
          },
          {
            id: `import-file-${attachmentDigest}.json`,
            bytes: attachment.byteLength,
            sha256: attachmentDigest,
            records: null,
            article15: true,
            portability: true,
            redactionCodes: [],
          },
        ],
      }),
      "utf8",
    );
    const payload = tar([
      ["dawarich/points/2026/01.jsonl", points],
      [`dawarich/import-files/${attachmentDigest}.json`, attachment],
      ["dawarich/source-manifest.json", manifest],
    ]);
    const chunks = (async function* () {
      for (let offset = 0; offset < payload.length; offset += 7)
        yield payload.subarray(offset, offset + 7);
    })();
    const seen: string[] = [];
    const contents: Buffer[] = [];
    const summary = await parseDawarichTarStream(chunks, async (entry) => {
      seen.push(entry.id);
      const chunks: Buffer[] = [];
      for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
      contents.push(Buffer.concat(chunks));
    });
    expect(seen).toEqual([
      "points-2026-01",
      `import-file-${attachmentDigest}.json`,
      "source-manifest",
    ]);
    expect(summary.totalBytes).toBe(
      points.byteLength + attachment.byteLength + manifest.byteLength,
    );
    expect(contents).toEqual([points, attachment, manifest]);
  });

  it("streams a large member with bounded chunks and waits for each consumer", async () => {
    const payloadChunkBytes = 32 * 1024;
    const contentBytes = 24 * payloadChunkBytes;
    const content = Buffer.alloc(contentBytes, 0x61);
    const contentDigest = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(content).digest("hex"),
    );
    const manifest = Buffer.from(
      JSON.stringify({
        ...tuple,
        entries: [
          {
            id: "points-2026-01",
            bytes: content.byteLength,
            sha256: contentDigest,
            records: 1,
            article15: true,
            portability: true,
            redactionCodes: [],
          },
        ],
      }),
    );
    const payload = tar([
      ["dawarich/points/2026/01.jsonl", content],
      ["dawarich/source-manifest.json", manifest],
    ]);
    let sourcePulls = 0;
    let consumerStarted = false;
    let maxChunk = 0;
    const source = (async function* () {
      for (let offset = 0; offset < payload.length; offset += payloadChunkBytes) {
        sourcePulls += 1;
        yield payload.subarray(offset, offset + payloadChunkBytes);
      }
    })();
    await parseDawarichTarStream(source, async (entry) => {
      const pullsAtStart = sourcePulls;
      consumerStarted = true;
      for await (const chunk of entry.content) {
        maxChunk = Math.max(maxChunk, chunk.byteLength);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (entry.id === "points-2026-01") expect(sourcePulls).toBeGreaterThan(pullsAtStart);
    });
    expect(consumerStarted).toBe(true);
    expect(maxChunk).toBeLessThanOrEqual(payloadChunkBytes);
  });

  it("rejects traversal and data after the tar end markers", async () => {
    const malicious = tar([["dawarich/../secret", Buffer.from("x")]]);
    await expect(parseDawarichTar(Readable.from([malicious]))).rejects.toMatchObject({
      code: "unsafe_path",
    } satisfies Partial<DawarichSourcePartError>);
    const valid = tar([["dawarich/source-manifest.json", Buffer.from(JSON.stringify(tuple))]]);
    await expect(
      parseDawarichTar(Readable.from([Buffer.concat([valid, Buffer.from("x")])])),
    ).rejects.toMatchObject({
      code: "trailing_data",
    } satisfies Partial<DawarichSourcePartError>);
  });

  it("removes encrypted members when final manifest validation fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openmapx-tar-spool-test-"));
    const points = Buffer.from('{"id":1}\n');
    const invalidManifest = Buffer.from(JSON.stringify(tuple));
    const payload = tar([
      ["dawarich/points/2026/01.jsonl", points],
      ["dawarich/source-manifest.json", invalidManifest],
    ]);
    await expect(
      spoolDawarichTar(Readable.from([payload]), { spoolParentDirectory: parent }),
    ).rejects.toMatchObject({ code: "manifest_mismatch" });
    expect(await readdir(parent)).toEqual([]);
  });

  it("rejects an oversized manifest before reading it and closes the upstream iterator", async () => {
    const oversizedHeader = member("dawarich/source-manifest.json", Buffer.alloc(257 * 1024, 0x20));
    let closed = false;
    const source = (async function* () {
      try {
        yield oversizedHeader.subarray(0, 512);
        yield oversizedHeader.subarray(512);
        yield Buffer.alloc(1024);
      } finally {
        closed = true;
      }
    })();
    await expect(parseDawarichTarStream(source, async () => undefined)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    expect(closed).toBe(true);
  });
});
