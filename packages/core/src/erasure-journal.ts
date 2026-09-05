import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const VERSION = 2;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_KEY_BYTES = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

interface CoverageRecord {
  version: 2;
  phase: "coverage";
  at: string;
  keyBinding: string;
}

export interface ErasureRequestRecord {
  version: 2;
  phase: "requested";
  receiptId: string;
  subjectDigest: string;
  at: string;
}

interface ErasureCompletedRecord {
  version: 2;
  phase: "completed";
  receiptId: string;
  at: string;
}

type ErasureJournalRecord = CoverageRecord | ErasureRequestRecord | ErasureCompletedRecord;

export interface ErasureJournal {
  coverageStartedAt: Date;
  keyBinding: string;
  requests: ErasureRequestRecord[];
  completedReceiptIds: Set<string>;
  completionRecords: ErasureCompletedRecord[];
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function assertJournalKey(key: Uint8Array): void {
  if (key.byteLength !== 32) {
    throw new Error("Erasure journal key must contain exactly 32 bytes");
  }
}

function coverageKeyBinding(key: Uint8Array, at: string): string {
  assertJournalKey(key);
  return createHmac("sha256", key)
    .update("openmapx-erasure-journal-key-binding-v1\0")
    .update(at)
    .digest("hex");
}

function subjectDigest(key: Uint8Array, userId: string): string {
  assertJournalKey(key);
  if (!userId) throw new Error("Erasure journal subject must not be empty");
  return createHmac("sha256", key)
    .update("openmapx-user-erasure-v1\0")
    .update(userId)
    .digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  kind: "journal" | "key",
  expectedMode: number,
  expectedUid: number,
): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error(`Erasure journal ${kind} must be a regular file`);
    }
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`Erasure journal ${kind} must be a regular file`);
    if (stats.nlink !== 1) {
      throw new Error(`Erasure journal ${kind} must have exactly one link`);
    }
    if (stats.uid !== expectedUid) {
      throw new Error(`Erasure journal ${kind} has an unexpected owner`);
    }
    if ((stats.mode & 0o7777) !== expectedMode) {
      throw new Error(
        `Erasure journal ${kind} must have ${expectedMode.toString(8).padStart(4, "0")} permissions`,
      );
    }
    if (stats.size < 1) throw new Error(`Erasure journal ${kind} file is empty`);
    if (stats.size > maxBytes) throw new Error(`Erasure journal ${kind} exceeds the size limit`);
    const bytes = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const count = readSync(fd, bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maxBytes) {
      throw new Error(`Erasure journal ${kind} exceeds the size limit`);
    }
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.uid !== stats.uid ||
      (after.mode & 0o7777) !== expectedMode ||
      after.size !== stats.size ||
      after.mtimeMs !== stats.mtimeMs ||
      after.ctimeMs !== stats.ctimeMs ||
      bytesRead !== after.size
    ) {
      throw new Error(`Erasure journal ${kind} changed while it was being read`);
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function readErasureJournalKeyFile(path: string, expectedUid: number): Buffer {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    throw new Error("Erasure journal key owner is invalid");
  }
  const encoded = readBoundedRegularFile(
    path,
    MAX_JOURNAL_KEY_BYTES,
    "key",
    0o444,
    expectedUid,
  ).toString("utf8");
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error("Erasure journal key is not canonical base64url");
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
    throw new Error("Erasure journal key must contain exactly 32 bytes");
  }
  return key;
}

function protectedJournalParentUid(path: string): number {
  const parent = dirname(path);
  let fd: number;
  try {
    fd = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error("Erasure journal parent must be a regular directory");
    }
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isDirectory() || (stats.mode & 0o7777) !== 0o700) {
      throw new Error("Erasure journal parent must be a protected 0700 directory");
    }
    return stats.uid;
  } finally {
    closeSync(fd);
  }
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
  const expectedUid = protectedJournalParentUid(path);
  const created = !existsSync(path);
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== expectedUid ||
      (stats.mode & 0o7777) !== 0o600 ||
      stats.size > MAX_JOURNAL_BYTES
    ) {
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

function coverageRecord(key: Uint8Array, now: Date): CoverageRecord {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid erasure journal coverage date");
  const at = now.toISOString();
  return {
    version: VERSION,
    phase: "coverage",
    at,
    keyBinding: coverageKeyBinding(key, at),
  };
}

export function initializeErasureJournal(
  path: string,
  key: Uint8Array,
  now: Date = new Date(),
): void {
  assertJournalKey(key);
  withJournalLock(path, () => {
    if (existsSync(path)) {
      readErasureJournalUnlocked(path, key);
      return;
    }
    appendRecordUnlocked(path, coverageRecord(key, now));
  });
}

export async function appendErasureRequest(
  path: string,
  key: Uint8Array,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  assertJournalKey(key);
  const receiptId = randomUUID();
  withJournalLock(path, () => {
    readErasureJournalUnlocked(path, key);
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
  key: Uint8Array,
  receiptId: string,
  now: Date = new Date(),
): Promise<void> {
  assertJournalKey(key);
  if (!UUID.test(receiptId)) throw new Error("Invalid erasure receipt identifier");
  withJournalLock(path, () => {
    readErasureJournalUnlocked(path, key);
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
    if (!DIGEST.test(String(record.keyBinding))) {
      throw new Error(`Invalid erasure journal key binding at line ${line}`);
    }
    return {
      version: VERSION,
      phase: "coverage",
      at: record.at,
      keyBinding: String(record.keyBinding),
    };
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

function readErasureJournalUnlocked(path: string, key: Uint8Array): ErasureJournal {
  assertJournalKey(key);
  const contents = readBoundedRegularFile(
    path,
    MAX_JOURNAL_BYTES,
    "journal",
    0o600,
    protectedJournalParentUid(path),
  ).toString("utf8");
  const lines = contents.split("\n").filter(Boolean);
  const values = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(`Invalid erasure journal JSON at line ${index + 1}`);
      throw error;
    }
  });
  const records = values.map((value, index) => parseRecord(value, index + 1));
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
  const journal: ErasureJournal = {
    coverageStartedAt: new Date(coverage.at),
    keyBinding: coverage.keyBinding,
    requests,
    completedReceiptIds,
    completionRecords,
  };
  assertErasureJournalKey(journal, key);
  return journal;
}

export function readErasureJournal(path: string, key: Uint8Array): ErasureJournal {
  return withJournalLock(path, () => readErasureJournalUnlocked(path, key));
}

export function assertErasureJournalKey(journal: ErasureJournal, key: Uint8Array): void {
  const expected = Buffer.from(
    coverageKeyBinding(key, journal.coverageStartedAt.toISOString()),
    "hex",
  );
  const actual = Buffer.from(journal.keyBinding, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new Error("Erasure journal key does not match its cryptographic binding");
  }
}

export function isErasedSubject(journal: ErasureJournal, key: Uint8Array, userId: string): boolean {
  assertErasureJournalKey(journal, key);
  const candidate = Buffer.from(subjectDigest(key, userId), "hex");
  return journal.requests.some((request) =>
    timingSafeEqual(candidate, Buffer.from(request.subjectDigest, "hex")),
  );
}

export function compactErasureJournal(path: string, key: Uint8Array, retainAfter: Date): void {
  assertJournalKey(key);
  if (!Number.isFinite(retainAfter.getTime())) throw new Error("Invalid erasure retention cutoff");
  withJournalLock(path, () => {
    const journal = readErasureJournalUnlocked(path, key);
    const originalFd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let original: ReturnType<typeof fstatSync>;
    try {
      original = fstatSync(originalFd);
    } finally {
      closeSync(originalFd);
    }
    const requests = journal.requests.filter(
      (request) => Date.parse(request.at) >= retainAfter.getTime(),
    );
    const retainedIds = new Set(requests.map((request) => request.receiptId));
    const effectiveCoverageFloor = new Date(
      Math.max(journal.coverageStartedAt.getTime(), retainAfter.getTime()),
    );
    const records: ErasureJournalRecord[] = [
      coverageRecord(key, effectiveCoverageFloor),
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
