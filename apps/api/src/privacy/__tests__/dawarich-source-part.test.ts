import { createHash } from "node:crypto";
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
import {
  invalidTarCases,
  invalidTarEndings,
  tarMember as member,
  tar,
} from "./fixtures/source-tar.js";

const tuple = {
  version: 1,
  image: "freikin/dawarich:1.19.0",
  imageDigest: "sha256:d9385242202ae385a5d8064f41a59a0b58218399e60e7e499d2a6afb449bc304",
  upstreamCommit: "752641768f37fdc07d5a23e0559fa7c5ff8fae0f",
  subjectUserIdDigest: "a".repeat(64),
  cutoff: "2026-01-01T00:00:00Z",
  snapshotAt: "2026-01-01T00:00:00Z",
  schemaFingerprint: DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
  collectorContract: "openmapx-subject-export-v1",
  entries: [] as Array<Record<string, unknown>>,
  warnings: [],
};

describe("Dawarich source-part parser", () => {
  const area = Buffer.from("{}\n");
  const declaration = {
    id: "areas",
    bytes: area.length,
    sha256: createHash("sha256").update(area).digest("hex"),
    records: 1,
    article15: true,
    portability: true,
    redactionCodes: [],
  };
  it.each([
    [
      "undeclared member",
      [
        ["dawarich/areas.jsonl", area],
        ["dawarich/source-manifest.json", Buffer.from(JSON.stringify(tuple))],
      ],
    ],
    [
      "missing member",
      [
        [
          "dawarich/source-manifest.json",
          Buffer.from(JSON.stringify({ ...tuple, entries: [declaration] })),
        ],
      ],
    ],
    [
      "incorrect digest",
      [
        ["dawarich/areas.jsonl", area],
        [
          "dawarich/source-manifest.json",
          Buffer.from(
            JSON.stringify({ ...tuple, entries: [{ ...declaration, sha256: "0".repeat(64) }] }),
          ),
        ],
      ],
    ],
    [
      "incorrect size",
      [
        ["dawarich/areas.jsonl", area],
        [
          "dawarich/source-manifest.json",
          Buffer.from(
            JSON.stringify({ ...tuple, entries: [{ ...declaration, bytes: area.length + 1 }] }),
          ),
        ],
      ],
    ],
    [
      "member after final manifest",
      [
        ["dawarich/source-manifest.json", Buffer.from(JSON.stringify(tuple))],
        ["dawarich/areas.jsonl", area],
      ],
    ],
  ] as Array<[string, Array<[string, Buffer]>]>)("rejects %s", async (_name, entries) => {
    await expect(parseDawarichTar(Readable.from([tar(entries)]))).rejects.toMatchObject({
      code: "manifest_mismatch",
    });
  });
  it.each([{ cutoff: "2026-02-01T00:00:00Z" }, { subjectUserIdDigest: "b".repeat(64) }])(
    "rejects a different expected subject or cutoff: %j",
    async (expected) => {
      const input = tar([["dawarich/source-manifest.json", Buffer.from(JSON.stringify(tuple))]]);
      await expect(
        parseDawarichTarStream(
          Readable.from([input]),
          async ({ content }) => {
            for await (const _chunk of content) {
            }
          },
          { expected },
        ),
      ).rejects.toMatchObject({ code: "manifest_mismatch" });
    },
  );
  it.each(
    invalidTarEndings(tar([["dawarich/source-manifest.json", Buffer.from(JSON.stringify(tuple))]])),
  )("rejects %s", async (_name, input, code) => {
    await expect(parseDawarichTar(Readable.from([input]))).rejects.toMatchObject({ code });
  });
  it.each(invalidTarCases("dawarich/areas.jsonl"))("rejects %s", async (_name, input, code) => {
    await expect(parseDawarichTar(Readable.from([input]))).rejects.toMatchObject({ code });
  });
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
