import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
  DAWARICH_SUPPORTED_COMMIT,
  DAWARICH_SUPPORTED_IMAGE_DIGEST,
} from "@openmapx/core/privacy";
import { describe, expect, it } from "vitest";
import { invalidTarCases, invalidTarEndings, tar } from "./__tests__/fixtures/source-tar.js";
import { type BackupSourcePartError, spoolBackupSourceTar } from "./backup-source-part.js";
import { collectApprovedBackupSource } from "./collectors/backup.js";

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(
  options: {
    wrongFamily?: boolean;
    wrongDigest?: boolean;
    missingDeclaration?: boolean;
    extraDeclaration?: boolean;
    afterManifest?: boolean;
  } = {},
): Buffer {
  const profile = Buffer.from('{"id":"subject-1","email":"subject@example.test"}\n');
  const areas = Buffer.from('{"id":1,"name":"Home"}\n');
  const dawarichManifest = Buffer.from(
    JSON.stringify({
      version: 1,
      image: "freikin/dawarich:1.15.3",
      imageDigest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
      upstreamCommit: DAWARICH_SUPPORTED_COMMIT,
      subjectUserIdDigest: digest(Buffer.from("subject-1")),
      collectorContract: "openmapx-subject-export-v1",
      cutoff: "2026-09-04T09:00:00.000Z",
      snapshotAt: "2026-09-04T00:00:00.000Z",
      schemaFingerprint: DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
      entries: [
        {
          id: "areas",
          bytes: areas.byteLength,
          sha256: digest(areas),
          records: 1,
          article15: true,
          portability: true,
          redactionCodes: [],
        },
      ],
      warnings: [],
    }),
  );
  const declarations = [
    {
      path: "openmapx/account-profile.jsonl",
      family: options.wrongFamily ? "dawarich" : "openmapx",
      bytes: profile.byteLength,
      sha256: options.wrongDigest ? "0".repeat(64) : digest(profile),
      records: 1,
      article15: true,
      portability: true,
      redactionCodes: ["credentials-excluded"],
    },
    {
      path: "dawarich/areas.jsonl",
      family: "dawarich",
      bytes: areas.byteLength,
      sha256: digest(areas),
      records: 1,
      article15: true,
      portability: true,
      redactionCodes: [],
    },
    {
      path: "dawarich/source-manifest.json",
      family: "dawarich",
      bytes: dawarichManifest.byteLength,
      sha256: digest(dawarichManifest),
      records: null,
      article15: true,
      portability: false,
      redactionCodes: [],
    },
  ];
  if (options.missingDeclaration) declarations.shift();
  if (options.extraDeclaration)
    declarations.push({ ...declarations[0], path: "openmapx/saved-lists.jsonl" });
  const outer = Buffer.from(
    JSON.stringify({
      version: 1,
      collectorContract: "openmapx-subject-export-v1",
      cutoff: "2026-09-04T09:00:00.000Z",
      subjectUserIdDigest: digest(Buffer.from("subject-1")),
      entries: declarations,
      warnings: [],
    }),
  );
  const members: Array<[string, Buffer]> = [
    ["openmapx/account-profile.jsonl", profile],
    ["dawarich/areas.jsonl", areas],
    ["dawarich/source-manifest.json", dawarichManifest],
    ["backup/source-manifest.json", outer],
  ];
  if (options.afterManifest) members.push(["openmapx/saved-lists.jsonl", profile]);
  return tar(members);
}

describe("backup source tar", () => {
  it.each([
    { wrongDigest: true },
    { missingDeclaration: true },
    { extraDeclaration: true },
    { afterManifest: true },
  ])("rejects inconsistent declarations/order: %j", async (options) => {
    await expect(spoolBackupSourceTar(Readable.from([fixture(options)]))).rejects.toMatchObject({
      code: "manifest_mismatch",
    });
  });
  it.each([{ cutoff: "2026-02-01T00:00:00Z" }, { subjectUserIdDigest: "b".repeat(64) }])(
    "rejects a different expected subject or cutoff: %j",
    async (expected) => {
      await expect(
        spoolBackupSourceTar(Readable.from([fixture()]), { expected }),
      ).rejects.toMatchObject({ code: "manifest_mismatch" });
    },
  );
  it.each(invalidTarEndings(fixture()))("rejects %s", async (_name, input, code) => {
    await expect(spoolBackupSourceTar(Readable.from([input]))).rejects.toMatchObject({ code });
  });
  it.each(invalidTarCases("openmapx/account-profile.jsonl"))(
    "rejects %s",
    async (_name, input, code) => {
      await expect(spoolBackupSourceTar(Readable.from([input]))).rejects.toMatchObject({ code });
    },
  );
  it("keeps OpenMapX and Dawarich families distinct while streaming into encrypted storage", async () => {
    const result = await spoolBackupSourceTar(Readable.from([fixture()]), {
      expected: {
        cutoff: "2026-09-04T09:00:00.000Z",
        subjectUserIdDigest: digest(Buffer.from("subject-1")),
      },
    });
    try {
      expect(result.entries.map((entry) => entry.logicalId)).toEqual([
        "backup-openmapx-account-profile",
        "backup-openmapx-portable-account-profile",
        "backup-dawarich-areas",
        "backup-dawarich-portable-areas",
        "backup-dawarich-source-manifest",
        "backup-source-manifest",
      ]);
      const profile = result.entries[0];
      const chunks: Buffer[] = [];
      for await (const chunk of profile.source as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toContain("subject@example.test");
    } finally {
      await result.dispose();
    }
  });

  it("uses a validated content namespace so retained snapshots cannot collide", async () => {
    const namespace = "a".repeat(64);
    const result = await spoolBackupSourceTar(Readable.from([fixture()]), { namespace });
    try {
      expect(result.entries.map((entry) => entry.logicalId)).toContain(
        `backup-${namespace}-openmapx-account-profile`,
      );
      expect(result.entries.map((entry) => entry.logicalId)).toContain(
        `backup-${namespace}-source-manifest`,
      );
      expect(result.entries[0]?.schemaId).toBe("backup-history-record-v1");
    } finally {
      await result.dispose();
    }
  });

  it("includes two materially different reviewed backups in collision-free namespaces", async () => {
    const manifests = ["1".repeat(64), "2".repeat(64)];
    const reviews = manifests.map((manifestDigest, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      backupId: `retained-${index + 1}`,
      manifestDigest,
      createdAt: new Date(`2026-09-0${index + 1}T00:00:00.000Z`),
      platformVersion: "1.0.0",
      decision: "extract",
      reasonCode: "possible_historical_difference",
      reviewedAt: new Date("2026-09-04T00:00:00.000Z"),
    }));
    let query = 0;
    const database = {
      select() {
        query += 1;
        const chain = {
          from() {
            return chain;
          },
          where() {
            return chain;
          },
          orderBy() {
            return Promise.resolve(reviews);
          },
          limit() {
            return Promise.resolve([{ id: "00000000-0000-4000-8000-000000000099" }]);
          },
        };
        return chain;
      },
    };
    const fetched: string[] = [];
    const result = await collectApprovedBackupSource({
      requestId: "00000000-0000-4000-8000-000000000010",
      userId: "subject-1",
      cutoffAt: new Date("2026-09-04T09:00:00.000Z"),
      database: database as never,
      capabilityKey: Buffer.alloc(32, 9),
      now: () => new Date("2026-09-04T08:00:00.000Z"),
      fetchExport: async ({ request }) => {
        fetched.push(request.backupId);
        return Readable.from([fixture()]);
      },
    });
    try {
      expect(query).toBe(2);
      expect(fetched).toEqual(["retained-1", "retained-2"]);
      expect(result.outcome).toBe("included");
      const ids = result.entries?.map((entry) => entry.logicalId) ?? [];
      expect(new Set(ids).size).toBe(ids.length);
      for (const manifestDigest of manifests) {
        const reference = createHash("sha256")
          .update("openmapx/privacy/backup-reference/v1\0")
          .update(manifestDigest)
          .digest("hex");
        expect(ids).toContain(`backup-${reference}-openmapx-account-profile`);
        expect(ids).toContain(`backup-${reference}-source-metadata`);
      }
    } finally {
      await result.disposeSources?.();
    }
  });

  it("rejects a declaration that reclassifies OpenMapX rows as Dawarich and removes spooled files", async () => {
    const parent = join(tmpdir(), `openmapx-backup-source-${process.pid}-${Date.now()}`);
    await expect(
      spoolBackupSourceTar(Readable.from([fixture({ wrongFamily: true })]), {
        spoolParentDirectory: parent,
      }),
    ).rejects.toMatchObject({ code: "manifest_mismatch" } satisfies Partial<BackupSourcePartError>);
    expect(await readdir(parent)).toEqual([]);
  });

  it("rejects the legacy Dawarich-only shape", async () => {
    await expect(
      spoolBackupSourceTar(
        Readable.from([tar([["dawarich/source-manifest.json", Buffer.from("{}")]])]),
      ),
    ).rejects.toMatchObject({ code: "manifest_mismatch" } satisfies Partial<BackupSourcePartError>);
  });
});
