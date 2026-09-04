import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema.js";
import { savedList, user } from "../../../db/schema.js";
import { assembleSubjectArchive } from "../../archive-assembler.js";
import { EncryptedBlobStore } from "../../artifact-storage.js";
import { PrivacyArchiveWriter } from "../../artifact-writer.js";
import { loadMasterKeyRing } from "../../crypto.js";
import { collectOpenMapxDataSnapshot } from "../../openmapx-collectors.js";

const connection = postgres(process.env.DATABASE_URL as string, { max: 2 });
const database = drizzle(connection, { schema });
const suffix = randomUUID();
const userId = `primary-memory-${suffix}`;
const root = await mkdtemp(join(tmpdir(), "openmapx-primary-memory-"));
const cutoffAt = new Date("2026-01-01T00:00:00.000Z");
const createdAt = new Date("2025-01-01T00:00:00.000Z");
const recordCount = 60_000;
const payload = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(24);
let peakRss = process.memoryUsage().rss;
let peakExternal = process.memoryUsage().external;
const sourceDisposers: Array<() => void | Promise<void>> = [];
const sampler = setInterval(() => {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakExternal = Math.max(peakExternal, memory.external);
}, 5);
sampler.unref();

try {
  await database.insert(user).values({
    id: userId,
    name: "Primary memory subject",
    email: `primary-memory-${suffix}@example.test`,
    createdAt,
    updatedAt: createdAt,
  });
  for (let offset = 0; offset < recordCount; offset += 250) {
    await database.insert(savedList).values(
      Array.from({ length: Math.min(250, recordCount - offset) }, (_, index) => {
        const sequence = offset + index;
        return {
          id: `memory-list-${sequence.toString().padStart(8, "0")}-${suffix}`,
          userId,
          name: `${sequence.toString().padStart(8, "0")}:${payload}`,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );
  }

  const snapshot = await collectOpenMapxDataSnapshot({
    userId,
    cutoffAt,
    database: database as never,
    offlinePrincipalKey: Buffer.alloc(32, 9),
  });
  if (snapshot.disposeSources) sourceDisposers.push(snapshot.disposeSources);
  const ring = loadMasterKeyRing({
    env: {
      NODE_ENV: "development",
      OPENMAPX_EXPORTS_KEY: Buffer.alloc(32, 5).toString("base64url"),
    },
  });
  const store = new EncryptedBlobStore({ root, ring, deploymentId: "primary-memory-test" });
  const requestId = randomUUID();
  const archive = await assembleSubjectArchive({
    requestId,
    artifactId: randomUUID(),
    locale: "en",
    parts: snapshot.parts,
    sourceEntries: snapshot.entries,
    disposeSources: snapshot.disposeSources,
    writer: new PrivacyArchiveWriter(store),
    generatedAt: "2026-01-01T00:00:00.000Z",
    responseContext: {
      request: {
        id: requestId,
        kind: "access_and_portability",
        receivedAt: "2026-01-01T00:00:00.000Z",
        registeredAt: "2026-01-01T00:00:00.000Z",
        preservationAt: "2026-01-01T00:00:00.000Z",
        snapshotAt: "2026-01-01T00:00:00.000Z",
      },
      generatedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-08T00:00:00.000Z",
      controller: {
        name: "Memory Test Controller",
        address: "Test Street 1\n10115 Berlin\nGermany",
        email: "privacy@example.test",
        phone: null,
      },
      deployment: {
        jurisdiction: "DE-BE",
        supervisoryAuthority: "Test Authority",
        supervisoryAuthorityUrl: null,
        privacySources: [],
        dsarCaseRetentionDays: 1095,
        identityEvidenceRetentionDays: 30,
        exportArtifactRetentionHours: 168,
      },
      reviewContact: `privacy@example.test (case ${requestId})`,
      recipientSummary: {
        entries: [],
        entryLimit: 100,
        truncated: false,
        totalGroupCount: 0,
        matchingEventCount: 0,
        archiveRecordCount: 0,
        summarizedAt: "2026-01-01T00:00:00.000Z",
        authoritativeSource: "openmapx-data-export/article-15/disclosures.jsonl",
      },
    },
  });
  const saved = archive.entries.find((entry) => entry.logicalId === "saved-content");
  const portable = archive.entries.find((entry) => entry.logicalId === "portable-lists");
  process.stdout.write(
    JSON.stringify({
      sourceBytes: saved?.bytes ?? 0,
      records: saved?.recordCount ?? 0,
      sha256: saved?.sha256 ?? "",
      schemaId: saved?.schemaId ?? "",
      portableRecords: portable?.recordCount ?? 0,
      peakRss,
      peakExternal,
    }),
  );
} finally {
  clearInterval(sampler);
  await Promise.allSettled(sourceDisposers.map((dispose) => dispose()));
  await database
    .delete(user)
    .where(inArray(user.id, [userId]))
    .catch(() => undefined);
  await connection.end();
  await rm(root, { recursive: true, force: true });
}
