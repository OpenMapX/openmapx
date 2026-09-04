import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { and, eq, inArray, isNull } from "drizzle-orm";
import z from "zod/v4";
import { db as defaultDb } from "../db/index.js";
import {
  dataSubjectRequestPreservation,
  dataSubjectRequestSourceSnapshot,
  dataSubjectRequestTask,
} from "../db/schema.js";
import { deriveOfflinePackagePrincipal } from "../services/offline-package-principal.js";
import { encryptedBlobResultFromRow, parseWrappedDek } from "./artifact-download.js";
import type { EncryptedBlobStore } from "./artifact-storage.js";
import {
  type CollectorSourcePart,
  projectSubjectRecord,
  type SubjectExportRecord,
} from "./collectors.js";
import { addCalendarMonths } from "./deadline.js";
import { streamOpenMapxRegistrationRecords } from "./openmapx-collectors.js";
import { encodeJsonLines } from "./primary-source-stream.js";

const RECEIPT_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const RECEIPT_SNAPSHOT_MAX_RECORDS = 100_000;
export const PRIVACY_RECEIPT_PRESERVATION_CAPABILITY = Object.freeze({
  version: 1,
  durableEncryptedSnapshots: true,
  boundedSafeProjections: true,
  exactKeyRedisCapture: true,
  noLiveFallback: true,
  terminalCiphertextCleanup: true,
});
export const RECEIPT_DATABASE_REGISTRATION_IDS = [
  "auth-accounts",
  "auth-sessions",
  "auth-verifications",
  "auth-oauth-resources",
  "offline-package-ownership",
] as const;
const RECEIPT_REGISTRATION_IDS = [
  ...RECEIPT_DATABASE_REGISTRATION_IDS,
  "redis-subject-controls",
] as const;

type ReceiptDatabase = typeof defaultDb;

export interface ReceiptPreservationDependencies {
  store?: EncryptedBlobStore;
  offlinePrincipalKey?: Buffer;
  redis?: ReceiptSnapshotRedis;
  artifactRetentionHours?: number;
}

export class ReceiptSnapshotUnavailableError extends Error {
  constructor(readonly registrationId: string) {
    super(`receipt snapshot unavailable: ${registrationId}`);
    this.name = "ReceiptSnapshotUnavailableError";
  }
}

export interface ReceiptSnapshotRedis {
  type(key: string): Promise<string>;
  pttl(key: string): Promise<number>;
  zcard(key: string): Promise<number>;
}

export interface RedisSubjectControlSnapshot {
  namespace: "offline-package:prepare";
  controlKind: "rolling-quota";
  state: "present";
  entryCount: number;
  expiresAt: string;
}

/** Read only the one purpose-bound subject key whose locator can be derived
 * exactly. Raw sorted-set members are operation IDs and are never exported. */
export async function captureRedisSubjectControl(
  redis: ReceiptSnapshotRedis,
  offlinePrincipal: string,
  capturedAt: Date,
): Promise<RedisSubjectControlSnapshot | null> {
  if (!/^[a-f0-9]{64}$/.test(offlinePrincipal))
    throw new Error("invalid offline-package principal");
  const key = `offline-package:prepare:${offlinePrincipal}`;
  const type = await redis.type(key);
  if (type === "none") return null;
  if (type !== "zset") throw new Error("unexpected offline quota value type");
  const [ttlMs, entryCount] = await Promise.all([redis.pttl(key), redis.zcard(key)]);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1_000)
    throw new Error("invalid offline quota expiry");
  if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > 1_000_000)
    throw new Error("invalid offline quota count");
  return {
    namespace: "offline-package:prepare",
    controlKind: "rolling-quota",
    state: "present",
    entryCount,
    expiresAt: new Date(capturedAt.getTime() + ttlMs).toISOString(),
  };
}

/** Source material survives the ordinary one-month deadline and the maximum
 * two-month extension, then only the short artifact window. */
export function receiptSnapshotExpiresAt(
  dueAt: Date,
  timeZone: string,
  artifactRetentionHours: number,
): Date {
  if (
    !Number.isSafeInteger(artifactRetentionHours) ||
    artifactRetentionHours < 24 ||
    artifactRetentionHours > 720
  )
    throw new Error("invalid receipt snapshot artifact retention");
  return new Date(
    addCalendarMonths(dueAt, 2, timeZone).getTime() + artifactRetentionHours * 3_600_000,
  );
}

const subjectExportRecordSchema = z
  .object({
    id: z.string().min(1).max(256),
    data: z.record(z.string(), z.unknown()),
    portable: z.boolean(),
    policyCodes: z.array(z.string().min(1).max(128)).max(32).optional(),
  })
  .strict();

async function markCaptureOutcome(input: {
  database: ReceiptDatabase;
  requestId: string;
  registrationId: string;
  at: Date;
  status: "complete" | "operator_review";
  code: string;
  recordCount?: number;
  preservationStatus: "captured" | "capture_failed";
}): Promise<void> {
  await input.database
    .update(dataSubjectRequestTask)
    .set({
      status: input.status,
      publicCode: input.code,
      exceptionCode: input.status === "operator_review" ? input.code : null,
      collectedAt: input.status === "complete" ? input.at : null,
      recordCount: input.recordCount ?? null,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(dataSubjectRequestTask.requestId, input.requestId),
        eq(dataSubjectRequestTask.registrationId, input.registrationId),
      ),
    );
  await input.database
    .update(dataSubjectRequestPreservation)
    .set({
      status: input.preservationStatus,
      outcomeCode: input.code,
      capturedAt: input.preservationStatus === "captured" ? input.at : null,
      releasedAt: input.preservationStatus === "capture_failed" ? input.at : null,
    })
    .where(
      and(
        eq(dataSubjectRequestPreservation.requestId, input.requestId),
        eq(dataSubjectRequestPreservation.registrationId, input.registrationId),
      ),
    );
}

async function persistSnapshot(input: {
  database: ReceiptDatabase;
  store: EncryptedBlobStore;
  requestId: string;
  registrationId: string;
  records: AsyncIterable<SubjectExportRecord>;
  capturedAt: Date;
  expiresAt: Date;
  createdStorageKeys: string[];
}): Promise<number> {
  const id = randomUUID();
  const storageKey = `source-snapshots/${input.requestId}/${input.registrationId}-${id}.bin`;
  const encoded = encodeJsonLines(input.records as AsyncIterable<Record<string, unknown>>, {
    maxBytes: RECEIPT_SNAPSHOT_MAX_BYTES,
    maxRecords: RECEIPT_SNAPSHOT_MAX_RECORDS,
  });
  const stored = await input.store.write({
    requestId: input.requestId,
    blobId: id,
    purpose: "source-snapshot",
    storageKey,
    source: encoded.source,
    maxBytes: RECEIPT_SNAPSHOT_MAX_BYTES,
  });
  input.createdStorageKeys.push(storageKey);
  const facts = await encoded.facts;
  if (facts.bytes !== stored.plaintextBytes || facts.sha256 !== stored.plaintextSha256) {
    await input.store.delete(storageKey).catch(() => undefined);
    throw new Error("receipt snapshot facts mismatch");
  }
  try {
    await input.database.insert(dataSubjectRequestSourceSnapshot).values({
      id,
      requestId: input.requestId,
      registrationId: input.registrationId,
      state: "captured",
      format: "subject-record-jsonl-v1",
      storageKey,
      recordCount: facts.records,
      plaintextBytes: stored.plaintextBytes,
      encryptedBytes: stored.ciphertextBytes,
      plaintextSha256: stored.plaintextSha256,
      ciphertextSha256: stored.ciphertextSha256,
      cipherVersion: 1,
      aadVersion: 1,
      iv: stored.iv,
      tag: stored.tag,
      wrappedDek: JSON.stringify(stored.wrappedDek),
      masterKeyVersion: stored.masterKeyVersion,
      capturedAt: input.capturedAt,
      expiresAt: input.expiresAt,
      deleteAttempts: 0,
      createdAt: input.capturedAt,
    });
  } catch (error) {
    await input.store.delete(storageKey).catch(() => undefined);
    throw error;
  }
  return facts.records;
}

/** Capture the safe, bounded receipt projections while the request-intake
 * transaction still owns the retention lock. Each failure becomes a durable
 * source outcome; it never rolls back or hides the statutory receipt. */
export async function captureReceiptSourceSnapshots(input: {
  database: ReceiptDatabase;
  requestId: string;
  userId: string;
  cutoffAt: Date;
  dueAt: Date;
  timeZone: string;
  dependencies: ReceiptPreservationDependencies;
  createdStorageKeys: string[];
}): Promise<void> {
  const { dependencies } = input;
  const expiresAt = receiptSnapshotExpiresAt(
    input.dueAt,
    input.timeZone,
    dependencies.artifactRetentionHours ?? 168,
  );
  const databaseIds = RECEIPT_DATABASE_REGISTRATION_IDS.filter(
    (registrationId) =>
      registrationId !== "offline-package-ownership" ||
      Boolean(
        dependencies.offlinePrincipalKey && dependencies.offlinePrincipalKey.byteLength >= 32,
      ),
  );
  for (const registrationId of databaseIds) {
    if (!dependencies.store) {
      await markCaptureOutcome({
        database: input.database,
        requestId: input.requestId,
        registrationId,
        at: input.cutoffAt,
        status: "operator_review",
        code: "receipt-snapshot-storage-unavailable",
        preservationStatus: "capture_failed",
      });
      continue;
    }
    const store = dependencies.store;
    try {
      const recordCount = await input.database.transaction(async (captureDatabase) => {
        const records = streamOpenMapxRegistrationRecords(registrationId, {
          userId: input.userId,
          requestId: input.requestId,
          cutoffAt: input.cutoffAt,
          database: captureDatabase as unknown as ReceiptDatabase,
          offlinePrincipalKey: dependencies.offlinePrincipalKey,
        });
        return persistSnapshot({
          database: captureDatabase as unknown as ReceiptDatabase,
          store,
          requestId: input.requestId,
          registrationId,
          records,
          capturedAt: input.cutoffAt,
          expiresAt,
          createdStorageKeys: input.createdStorageKeys,
        });
      });
      await markCaptureOutcome({
        database: input.database,
        requestId: input.requestId,
        registrationId,
        at: input.cutoffAt,
        status: "complete",
        code: "receipt-snapshot-captured",
        recordCount,
        preservationStatus: "captured",
      });
    } catch {
      await markCaptureOutcome({
        database: input.database,
        requestId: input.requestId,
        registrationId,
        at: input.cutoffAt,
        status: "operator_review",
        code: "receipt-snapshot-capture-failed",
        preservationStatus: "capture_failed",
      });
    }
  }
  if (!dependencies.offlinePrincipalKey || dependencies.offlinePrincipalKey.byteLength < 32) {
    for (const registrationId of ["offline-package-ownership", "redis-subject-controls"]) {
      await markCaptureOutcome({
        database: input.database,
        requestId: input.requestId,
        registrationId,
        at: input.cutoffAt,
        status: "operator_review",
        code: "offline-principal-key-unavailable",
        preservationStatus: "capture_failed",
      });
    }
    return;
  }
  if (!dependencies.store || !dependencies.redis) {
    await markCaptureOutcome({
      database: input.database,
      requestId: input.requestId,
      registrationId: "redis-subject-controls",
      at: input.cutoffAt,
      status: "operator_review",
      code: dependencies.store
        ? "redis-source-unavailable"
        : "receipt-snapshot-storage-unavailable",
      preservationStatus: "capture_failed",
    });
    return;
  }
  const store = dependencies.store;
  try {
    const principal = deriveOfflinePackagePrincipal(input.userId, dependencies.offlinePrincipalKey);
    const control = await captureRedisSubjectControl(dependencies.redis, principal, input.cutoffAt);
    const recordCount = await input.database.transaction(async (captureDatabase) => {
      const records = (async function* () {
        if (control)
          yield projectSubjectRecord("operational-controls", { ...control }, false, [
            "control-safe-metadata",
          ]);
      })();
      return persistSnapshot({
        database: captureDatabase as unknown as ReceiptDatabase,
        store,
        requestId: input.requestId,
        registrationId: "redis-subject-controls",
        records,
        capturedAt: input.cutoffAt,
        expiresAt,
        createdStorageKeys: input.createdStorageKeys,
      });
    });
    await markCaptureOutcome({
      database: input.database,
      requestId: input.requestId,
      registrationId: "redis-subject-controls",
      at: input.cutoffAt,
      status: "operator_review",
      code: "redis-exact-locator-review-required",
      recordCount,
      preservationStatus: "captured",
    });
  } catch {
    await markCaptureOutcome({
      database: input.database,
      requestId: input.requestId,
      registrationId: "redis-subject-controls",
      at: input.cutoffAt,
      status: "operator_review",
      code: "redis-receipt-capture-failed",
      preservationStatus: "capture_failed",
    });
  }
}

function snapshotRecordStream(
  row: typeof dataSubjectRequestSourceSnapshot.$inferSelect,
  store: EncryptedBlobStore,
  deploymentId: string,
): AsyncIterable<SubjectExportRecord> {
  return (async function* () {
    if (!row.wrappedDek || !row.tag || row.masterKeyVersion === null)
      throw new ReceiptSnapshotUnavailableError(row.registrationId);
    const source = new PassThrough({ highWaterMark: 64 * 1024 });
    const result = encryptedBlobResultFromRow(
      {
        ...row,
        filename: "receipt-snapshot.zip",
        mediaType: "application/jsonl",
      },
      {
        deploymentId,
        wrappedDek: parseWrappedDek(row.wrappedDek),
        purpose: "source-snapshot",
      },
    );
    const producer = store
      .decryptTo(result, async (chunk) => {
        if (!source.write(Buffer.from(chunk))) await once(source, "drain");
      })
      .then(
        () => source.end(),
        (error) => source.destroy(error as Error),
      );
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let count = 0;
    try {
      for await (const chunk of source) {
        pending += decoder.write(Buffer.from(chunk));
        if (Buffer.byteLength(pending, "utf8") > 512 * 1024)
          throw new Error("receipt snapshot record exceeds bound");
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line) {
            count += 1;
            if (count > RECEIPT_SNAPSHOT_MAX_RECORDS)
              throw new Error("receipt snapshot record count exceeds bound");
            yield subjectExportRecordSchema.parse(JSON.parse(line));
          }
          newline = pending.indexOf("\n");
        }
      }
      pending += decoder.end();
      if (pending.trim()) throw new Error("receipt snapshot is not newline terminated");
      await producer;
      if (count !== row.recordCount) throw new Error("receipt snapshot record count mismatch");
    } catch {
      source.destroy();
      await producer.catch(() => undefined);
      throw new ReceiptSnapshotUnavailableError(row.registrationId);
    }
  })();
}

export interface LoadedReceiptSnapshots {
  overrides: ReadonlyMap<string, AsyncIterable<SubjectExportRecord>>;
  capturedAt: ReadonlyMap<string, Date>;
  externalParts: readonly CollectorSourcePart[];
}

/** Resolve every expected receipt capture before live collection. A deleted,
 * missing, corrupt or key-unavailable row is a concrete source failure and
 * never falls back to a later live snapshot under the original timestamp. */
export async function loadReceiptSourceSnapshots(input: {
  database?: ReceiptDatabase;
  requestId: string;
  expectedRegistrationIds: readonly string[];
  excludedRegistrationIds: ReadonlySet<string>;
  store: EncryptedBlobStore;
  deploymentId: string;
}): Promise<LoadedReceiptSnapshots> {
  const database = input.database ?? defaultDb;
  const expected = input.expectedRegistrationIds.filter(
    (id) =>
      !input.excludedRegistrationIds.has(id) && RECEIPT_REGISTRATION_IDS.includes(id as never),
  );
  if (expected.length === 0)
    return { overrides: new Map(), capturedAt: new Map(), externalParts: [] };
  const rows = await database
    .select()
    .from(dataSubjectRequestSourceSnapshot)
    .where(
      and(
        eq(dataSubjectRequestSourceSnapshot.requestId, input.requestId),
        inArray(dataSubjectRequestSourceSnapshot.registrationId, expected),
        eq(dataSubjectRequestSourceSnapshot.state, "captured"),
        isNull(dataSubjectRequestSourceSnapshot.deletedAt),
      ),
    );
  const byRegistration = new Map(rows.map((row) => [row.registrationId, row]));
  for (const registrationId of expected) {
    if (!byRegistration.has(registrationId))
      throw new ReceiptSnapshotUnavailableError(registrationId);
  }
  const overrides = new Map<string, AsyncIterable<SubjectExportRecord>>();
  const capturedAt = new Map<string, Date>();
  const externalParts: CollectorSourcePart[] = [];
  for (const row of rows) {
    const stream = snapshotRecordStream(row, input.store, input.deploymentId);
    capturedAt.set(row.registrationId, row.capturedAt);
    overrides.set(row.registrationId, stream);
  }
  return { overrides, capturedAt, externalParts };
}
