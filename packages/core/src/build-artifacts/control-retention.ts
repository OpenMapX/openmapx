import { randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync } from "node:fs";
import { controlDigest } from "./control-records";
import { type AnchoredDirectory, type FileIdentity, identity, sameInode } from "./filesystem";

export const CONTROL_RETENTION_LIMITS = {
  familiesPerRole: 1024,
  leases: 1024,
  activeLeases: 256,
  executionsPerFamily: 128,
  intentsPerFamily: 256,
  childrenPerExecution: 64,
  recordsPerNamespace: 65536,
  recordsPerFamily: 4096,
  indexPages: 64,
  pageEntries: 64,
  indexPageBytes: 16384,
  familyMetadataBytes: 2 * 1024 * 1024,
  privateRecordBytes: 131072,
  minimumTerminalRetentionMs: 72 * 60 * 60 * 1000,
} as const;
interface Counter {
  version: 1;
  sequence: number;
  count: number;
}
export interface RetentionDeletion {
  familyId: string;
  generation: string;
  manifestDigest: string;
  ordinal: number;
  name: string;
  inode: FileIdentity;
  digest: string;
}
interface Transaction extends RetentionDeletion {
  phase: "planned" | "unlinked" | "counted" | "item_done";
  before: Counter;
  after: Counter;
}
function absent(e: unknown) {
  return (e as NodeJS.ErrnoException).code === "ENOENT";
}
function readJson(dir: AnchoredDirectory, name: string, max = 4096): unknown {
  return JSON.parse(dir.read(name, max).toString("utf8"));
}
function counter(value: unknown): Counter {
  if (!value || typeof value !== "object") throw Error("Invalid retention counter");
  const c = value as Counter;
  if (
    c.version !== 1 ||
    !Number.isSafeInteger(c.sequence) ||
    c.sequence < 0 ||
    !Number.isSafeInteger(c.count) ||
    c.count < 0
  )
    throw Error("Invalid retention counter");
  return c;
}
function writeCounter(dir: AnchoredDirectory, c: Counter) {
  counter(c);
  dir.write(".retention-count", JSON.stringify(c));
  dir.write(".retention-highwater", JSON.stringify(c));
}
function readCounter(dir: AnchoredDirectory): Counter {
  const current = counter(readJson(dir, ".retention-count"));
  const prior = counter(readJson(dir, ".retention-highwater"));
  if (
    current.sequence < prior.sequence ||
    (current.sequence === prior.sequence && current.count !== prior.count)
  )
    throw Error("Retention counter rollback; supervised recovery required");
  if (current.sequence > prior.sequence) dir.write(".retention-highwater", JSON.stringify(current));
  return current;
}
function writeTransaction(
  dir: AnchoredDirectory,
  value: Transaction | null,
  exclusive = false,
): void {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes, "utf8") > 4096)
    throw Error("Retention transaction exceeds reserved cell");
  dir.write(".retention-transaction", bytes.padEnd(4096), exclusive);
}
function transaction(dir: AnchoredDirectory): Transaction | null {
  const value = readJson(dir, ".retention-transaction") as Transaction | null;
  if (value === null) return null;
  if (
    !value ||
    !["planned", "unlinked", "counted", "item_done"].includes(value.phase) ||
    !Number.isSafeInteger(value.ordinal) ||
    !value.inode ||
    typeof value.digest !== "string"
  )
    throw Error("Corrupt quota transaction");
  counter(value.before);
  counter(value.after);
  if (
    value.after.sequence !== value.before.sequence + 1 ||
    value.after.count !== value.before.count - 1
  )
    throw Error("Corrupt quota decrement");
  return value;
}
function initialize(dir: AnchoredDirectory) {
  try {
    readCounter(dir);
    transaction(dir);
  } catch (e) {
    if (!absent(e)) throw e;
    const names = dir.listBounded(CONTROL_RETENTION_LIMITS.recordsPerNamespace + 5);
    if (names.some((n) => ![".retention-writer"].includes(n)))
      throw Error("Missing namespace accounting in nonempty store; supervised recovery required");
    writeCounter(dir, { version: 1, sequence: 0, count: 0 });
    writeTransaction(dir, null, true);
  }
}
export function withRetentionNamespaceWriter<T>(dir: AnchoredDirectory, run: () => T): T {
  mkdirSync(dir.name(".retention-writer"), { mode: 0o700 });
  fsyncSync(dir.fd);
  const guard = dir.directory(".retention-writer"),
    held = identity(guard.stat);
  try {
    initialize(dir);
    return run();
  } finally {
    guard.close();
    dir.removeDirectory(".retention-writer", held);
  }
}
/** Creation reservations precede ordinary publication; cleanup metadata is outside this quota. */
export function writeRetainedRecord(
  dir: AnchoredDirectory,
  name: string,
  bytes: string,
  exclusive: boolean,
  maximum: number = CONTROL_RETENTION_LIMITS.recordsPerNamespace,
  beforePublish?: (inode: FileIdentity) => void,
) {
  try {
    dir.read(name, CONTROL_RETENTION_LIMITS.privateRecordBytes);
    dir.write(name, bytes, exclusive, beforePublish);
    return;
  } catch (e) {
    if (!absent(e)) throw e;
  }
  withRetentionNamespaceWriter(dir, () => {
    if (transaction(dir))
      throw Error("Pending quota transaction; reconcile its exact family before admission");
    const prior = readCounter(dir);
    if (prior.count >= maximum)
      throw Error("Retained authority capacity exhausted; await terminal retention or containment");
    writeCounter(dir, { version: 1, sequence: prior.sequence + 1, count: prior.count + 1 });
    dir.write(name, bytes, exclusive, beforePublish);
  });
}
export function finishRetainedDeletion(dir: AnchoredDirectory, item: RetentionDeletion): void {
  withRetentionNamespaceWriter(dir, () => {
    const t = transaction(dir);
    if (!t) return;
    if (
      t.familyId !== item.familyId ||
      t.generation !== item.generation ||
      t.ordinal !== item.ordinal ||
      t.manifestDigest !== item.manifestDigest ||
      !["counted", "item_done"].includes(t.phase)
    )
      throw Error("Quota item_done identity mismatch");
    writeTransaction(dir, { ...t, phase: "item_done" });
    writeTransaction(dir, null);
  });
}
/** The caller durably records item_done before this transaction can be cleared. */
export function deleteRetainedRecord(
  dir: AnchoredDirectory,
  item: RetentionDeletion,
  itemDone: () => void,
): void {
  withRetentionNamespaceWriter(dir, () => {
    let t = transaction(dir);
    if (
      t &&
      (t.familyId !== item.familyId ||
        t.generation !== item.generation ||
        t.ordinal !== item.ordinal ||
        t.manifestDigest !== item.manifestDigest ||
        t.name !== item.name ||
        t.digest !== item.digest ||
        !sameInode(t.inode, item.inode))
    )
      throw Error("Another exact quota transaction remains pending");
    if (!t) {
      // An absent item is resumable only through its already retained plan.
      // A new plan cannot turn an old continuation into a second decrement.
      if (
        !sameInode(dir.fileIdentity(item.name), item.inode) ||
        controlDigest(
          dir.read(item.name, CONTROL_RETENTION_LIMITS.privateRecordBytes).toString("utf8"),
        ) !== item.digest
      )
        throw Error("Retirement record inode/digest replacement");
      const before = readCounter(dir);
      if (before.count < 1) throw Error("Retention counter underflow");
      t = {
        ...item,
        before,
        after: { version: 1, sequence: before.sequence + 1, count: before.count - 1 },
        phase: "planned",
      };
      writeTransaction(dir, t);
    }
    if (t.phase === "planned") {
      if (controlDigest(readCounter(dir)) !== controlDigest(t.before))
        throw Error("Quota planned counter/version mismatch");
      try {
        if (
          !sameInode(dir.fileIdentity(item.name), item.inode) ||
          controlDigest(
            dir.read(item.name, CONTROL_RETENTION_LIMITS.privateRecordBytes).toString("utf8"),
          ) !== item.digest
        )
          throw Error("Retirement record inode/digest replacement");
        dir.removeFile(item.name);
      } catch (e) {
        if (!absent(e))
          throw e; /* matching planned transaction alone authorizes an already-unlinked item */
      }
      t = { ...t, phase: "unlinked" };
      writeTransaction(dir, t);
    }
    if (t.phase === "unlinked") {
      const current = readCounter(dir);
      if (controlDigest(current) === controlDigest(t.before)) writeCounter(dir, t.after);
      else if (controlDigest(current) !== controlDigest(t.after))
        throw Error("Quota decrement/version mismatch");
      t = { ...t, phase: "counted" };
      writeTransaction(dir, t);
    }
    if (t.phase !== "counted") throw Error("Unfinished retention transaction phase");
    itemDone();
    writeTransaction(dir, { ...t, phase: "item_done" });
    writeTransaction(dir, null);
  });
}
export function reserveAuthoritySlot(dir: AnchoredDirectory, maximum: number, until: number) {
  for (let slot = 0; slot < maximum; slot++) {
    if (Date.now() >= until) throw Error("Target lease acquisition deadline elapsed");
    const name = `slot-${slot}`;
    try {
      mkdirSync(dir.name(name), { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    fsyncSync(dir.fd);
    const child = dir.directory(name);
    try {
      const generation = randomUUID();
      child.write("generation.json", JSON.stringify({ generation }), true);
      return { name, identity: identity(child.stat), generation };
    } finally {
      child.close();
    }
  }
  throw Error("Retained authority capacity exhausted; await terminal retention or containment");
}
