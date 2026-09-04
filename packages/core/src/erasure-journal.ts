import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const VERSION = 1;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

interface CoverageRecord {
  version: 1;
  phase: "coverage";
  at: string;
}

export interface ErasureRequestRecord {
  version: 1;
  phase: "requested";
  receiptId: string;
  subjectDigest: string;
  at: string;
}

interface ErasureCompletedRecord {
  version: 1;
  phase: "completed";
  receiptId: string;
  at: string;
}

type ErasureJournalRecord = CoverageRecord | ErasureRequestRecord | ErasureCompletedRecord;

export interface ErasureJournal {
  coverageStartedAt: Date;
  requests: ErasureRequestRecord[];
  completedReceiptIds: Set<string>;
  completionRecords: ErasureCompletedRecord[];
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function subjectDigest(key: Uint8Array, userId: string): string {
  if (key.byteLength < 32) throw new Error("Erasure journal key must contain at least 32 bytes");
  if (!userId) throw new Error("Erasure journal subject must not be empty");
  return createHmac("sha256", key)
    .update("openmapx-user-erasure-v1\0")
    .update(userId)
    .digest("hex");
}

function withJournalLock<T>(path: string, action: () => T): T {
  const lockPath = `${path}.lock`;
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Erasure journal is locked; if no journal operation is running, remove stale lock ${lockPath}`,
      );
    }
    throw error;
  }
  try {
    return action();
  } finally {
    rmdirSync(lockPath);
  }
}

function appendRecordUnlocked(path: string, record: ErasureJournalRecord): void {
  const created = !existsSync(path);
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > MAX_JOURNAL_BYTES) {
      throw new Error("Erasure journal is not a bounded regular file");
    }
    const line = `${JSON.stringify(record)}\n`;
    if (stats.size + Buffer.byteLength(line) > MAX_JOURNAL_BYTES) {
      throw new Error("Erasure journal size limit exceeded");
    }
    writeFileSync(fd, line, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) {
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

export function initializeErasureJournal(path: string, now: Date = new Date()): void {
  withJournalLock(path, () => {
    if (existsSync(path)) {
      readErasureJournalUnlocked(path);
      return;
    }
    appendRecordUnlocked(path, { version: VERSION, phase: "coverage", at: now.toISOString() });
  });
}

export async function appendErasureRequest(
  path: string,
  key: Uint8Array,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const receiptId = randomUUID();
  withJournalLock(path, () => {
    appendRecordUnlocked(path, {
      version: VERSION,
      phase: "requested",
      receiptId,
      subjectDigest: subjectDigest(key, userId),
      at: now.toISOString(),
    });
  });
  return receiptId;
}

export async function appendErasureCompleted(
  path: string,
  receiptId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!UUID.test(receiptId)) throw new Error("Invalid erasure receipt identifier");
  withJournalLock(path, () => {
    appendRecordUnlocked(path, {
      version: VERSION,
      phase: "completed",
      receiptId,
      at: now.toISOString(),
    });
  });
}

function parseRecord(value: unknown, line: number): ErasureJournalRecord {
  if (!value || typeof value !== "object") throw new Error(`Invalid erasure journal line ${line}`);
  const record = value as Record<string, unknown>;
  if (record.version !== VERSION || !validDate(record.at)) {
    throw new Error(`Invalid erasure journal record at line ${line}`);
  }
  if (record.phase === "coverage") {
    return { version: VERSION, phase: "coverage", at: record.at };
  }
  if (record.phase === "requested") {
    if (!UUID.test(String(record.receiptId)) || !DIGEST.test(String(record.subjectDigest))) {
      throw new Error(`Invalid erasure request digest or receipt at line ${line}`);
    }
    return {
      version: VERSION,
      phase: "requested",
      receiptId: String(record.receiptId),
      subjectDigest: String(record.subjectDigest),
      at: record.at,
    };
  }
  if (record.phase === "completed" && UUID.test(String(record.receiptId))) {
    return {
      version: VERSION,
      phase: "completed",
      receiptId: String(record.receiptId),
      at: record.at,
    };
  }
  throw new Error(`Invalid erasure journal phase at line ${line}`);
}

function readErasureJournalUnlocked(path: string): ErasureJournal {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_JOURNAL_BYTES) {
    throw new Error("Erasure journal must be a bounded, non-symlinked regular file");
  }
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const records = lines.map((line, index) => {
    try {
      return parseRecord(JSON.parse(line) as unknown, index + 1);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(`Invalid erasure journal JSON at line ${index + 1}`);
      throw error;
    }
  });
  const coverage = records[0];
  if (
    coverage?.phase !== "coverage" ||
    records.some((record, index) => index > 0 && record.phase === "coverage")
  ) {
    throw new Error("Erasure journal must begin with exactly one coverage marker");
  }
  const requests = records.filter(
    (record): record is ErasureRequestRecord => record.phase === "requested",
  );
  const requestIds = new Set(requests.map((record) => record.receiptId));
  const completedReceiptIds = new Set<string>();
  const completionRecords: ErasureCompletedRecord[] = [];
  for (const record of records) {
    if (record.phase !== "completed") continue;
    if (!requestIds.has(record.receiptId))
      throw new Error("Erasure completion has no matching request");
    completedReceiptIds.add(record.receiptId);
    completionRecords.push(record);
  }
  return {
    coverageStartedAt: new Date(coverage.at),
    requests,
    completedReceiptIds,
    completionRecords,
  };
}

export function readErasureJournal(path: string): ErasureJournal {
  return withJournalLock(path, () => readErasureJournalUnlocked(path));
}

export function isErasedSubject(journal: ErasureJournal, key: Uint8Array, userId: string): boolean {
  const candidate = Buffer.from(subjectDigest(key, userId), "hex");
  return journal.requests.some((request) =>
    timingSafeEqual(candidate, Buffer.from(request.subjectDigest, "hex")),
  );
}

export function compactErasureJournal(path: string, retainAfter: Date): void {
  if (!Number.isFinite(retainAfter.getTime())) throw new Error("Invalid erasure retention cutoff");
  withJournalLock(path, () => {
    const journal = readErasureJournalUnlocked(path);
    const original = lstatSync(path);
    const requests = journal.requests.filter(
      (request) => Date.parse(request.at) >= retainAfter.getTime(),
    );
    const retainedIds = new Set(requests.map((request) => request.receiptId));
    const records: ErasureJournalRecord[] = [
      { version: VERSION, phase: "coverage", at: journal.coverageStartedAt.toISOString() },
      ...requests,
      ...journal.completionRecords.filter((record) => retainedIds.has(record.receiptId)),
    ];
    const contents = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, contents, { encoding: "utf8" });
      fchmodSync(fd, original.mode & 0o777);
      fchownSync(fd, original.uid, original.gid);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, path);
      const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
  });
}
