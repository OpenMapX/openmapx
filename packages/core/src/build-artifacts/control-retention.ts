import { fsyncSync, mkdirSync } from "node:fs";
import { type AnchoredDirectory, identity } from "./filesystem";

// No online retirement: receipts and consumed identity/key slots remain for the
// installation lifetime, including >=72h terminal history and every unknown.
// Exhaustion closes admission, never settlement of already reserved executions.
export const CONTROL_RETENTION_LIMITS = {
  executionsPerRole: 1024,
  leases: 1024,
  activeLeases: 256,
  childrenPerExecution: 64,
  recordsPerNamespace: 65536,
  privateRecordBytes: 131072,
  minimumTerminalRetentionMs: 72 * 60 * 60 * 1000,
} as const;

/** Private, fixed-namespace creation accounting. Count reservations before publishing. */
export function writeRetainedRecord(
  dir: AnchoredDirectory,
  name: string,
  bytes: string,
  exclusive: boolean,
  maximum: number,
) {
  try {
    dir.read(name, CONTROL_RETENTION_LIMITS.privateRecordBytes);
    dir.write(name, bytes, exclusive);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(dir.name(".retention-writer"), { mode: 0o700 });
  fsyncSync(dir.fd);
  const guard = dir.directory(".retention-writer");
  const held = identity(guard.stat);
  try {
    let count: number;
    try {
      count = JSON.parse(dir.read(".retention-count", 64).toString("utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      count = dir.listBounded(maximum + 1).filter((n) => n !== ".retention-writer").length;
    }
    if (!Number.isSafeInteger(count) || count < 0 || count >= maximum)
      throw Error("Retained authority capacity exhausted; preserve receipts and stop new work");
    dir.write(".retention-count", String(count + 1));
    dir.write(name, bytes, exclusive);
  } finally {
    guard.close();
    dir.removeDirectory(".retention-writer", held);
  }
}

/** Fixed slots bound admission without listing or parsing historical records. */
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
      return { name, identity: identity(child.stat) };
    } finally {
      child.close();
    }
  }
  throw Error("Retained authority capacity exhausted; no ownership may be stolen");
}
