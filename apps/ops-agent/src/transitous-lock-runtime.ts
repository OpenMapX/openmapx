import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { OpsResultFor } from "@openmapx/core/ops";
import type { OpsRuntime } from "./runtime";

// The catalog lock lives in the repository's `infra/docker/`, which only the
// operations agent may write. Data-manager and the API previously bind-mounted
// the host checkout to touch it directly; they now name a pinned ref and let
// the agent own the file, its canonical shape, and its atomic replacement.

const LOCK_RELATIVE_PATH = join("infra", "docker", "transitous.lock.json");
const PROPOSED_RELATIVE_PATH = join("infra", "docker", "transitous.lock.proposed.json");
const GBFS_LOCK_RELATIVE_PATH = join("infra", "docker", "gbfs-catalog.lock.json");
const MAX_LOCK_BYTES = 256 * 1024;

type LockRecord = OpsResultFor<"transitousLock.inspect">["active"];

function readLockAt(path: string): LockRecord {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  if (Buffer.byteLength(raw, "utf8") > MAX_LOCK_BYTES) {
    throw new Error("Transitous lock is too large");
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Transitous lock is not an object");
  }
  const submodules: Record<string, string> = {};
  const rawSubmodules = parsed.submodules;
  if (rawSubmodules && typeof rawSubmodules === "object" && !Array.isArray(rawSubmodules)) {
    for (const [name, value] of Object.entries(rawSubmodules as Record<string, unknown>)) {
      if (typeof value === "string") submodules[name] = value;
    }
  }
  return {
    ref: String(parsed.ref ?? ""),
    submodules,
    lockedAt: String(parsed.lockedAt ?? ""),
    lockedBy: String(parsed.lockedBy ?? ""),
    ...(typeof parsed.comment === "string" ? { comment: parsed.comment } : {}),
  } as LockRecord;
}

/** Write-then-rename so a reader never observes a half-written lock. */
function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename already failed; surface that, not the cleanup.
    }
    throw error;
  }
}

export interface TransitousLockRuntimeOptions {
  rootDir: string;
  now?: () => Date;
}

/**
 * Wire the agent-owned catalog-lock operations.
 *
 * `propose` never activates anything: the auto-bump path writes a proposal that
 * an administrator must approve. `approve` requires the exact ref it is
 * activating, so an approval cannot land on a proposal that changed after the
 * reviewer read it.
 */
export function createTransitousLockRuntime(
  runtime: OpsRuntime,
  options: TransitousLockRuntimeOptions,
): OpsRuntime {
  const now = options.now ?? (() => new Date());
  const lockPath = join(options.rootDir, LOCK_RELATIVE_PATH);
  const proposedPath = join(options.rootDir, PROPOSED_RELATIVE_PATH);

  runtime["transitousLock.inspect"] = async () => ({
    active: readLockAt(lockPath),
    proposed: readLockAt(proposedPath),
  });

  runtime["gbfsCatalogLock.inspect"] = async () => {
    const path = join(options.rootDir, GBFS_LOCK_RELATIVE_PATH);
    if (!existsSync(path)) throw new Error("GBFS catalog lock is missing");
    const raw = readFileSync(path, "utf-8");
    if (Buffer.byteLength(raw, "utf8") > MAX_LOCK_BYTES) {
      throw new Error("GBFS catalog lock is too large");
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      commit: String(parsed.commit ?? ""),
      url: String(parsed.url ?? ""),
      sha256: String(parsed.sha256 ?? ""),
      lockedAt: String(parsed.lockedAt ?? ""),
      lockedBy: String(parsed.lockedBy ?? ""),
    };
  };

  runtime["transitousLock.propose"] = async (operation) => {
    atomicWriteJson(proposedPath, {
      ref: operation.ref,
      submodules: operation.submodules,
      lockedAt: now().toISOString(),
      lockedBy: operation.lockedBy,
      ...(operation.comment ? { comment: operation.comment } : {}),
    });
    return { ref: operation.ref, proposed: true as const };
  };

  runtime["transitousLock.approve"] = async (operation) => {
    const proposal = readLockAt(proposedPath);
    if (!proposal) throw new Error("No Transitous lock proposal to approve");
    if (proposal.ref !== operation.ref) {
      // The reviewer approved a different ref than the one now proposed.
      throw new Error("Transitous lock proposal does not match the approved ref");
    }
    const lockedAt = now().toISOString();
    atomicWriteJson(lockPath, {
      ref: proposal.ref,
      submodules: proposal.submodules,
      lockedAt,
      lockedBy: operation.approvedBy,
      comment: "Approved after compatibility review and inactive-slot validation.",
    });
    try {
      unlinkSync(proposedPath);
    } catch {
      // The activation already committed; a leftover proposal is inert because
      // `approve` re-reads and re-matches it.
    }
    return { ref: proposal.ref, lockedAt };
  };

  return runtime;
}
