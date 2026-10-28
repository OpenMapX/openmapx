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
import { catalogRevisionId, readCatalogPinSet } from "@openmapx/core/catalog-pins";
import type { OpsResultFor } from "@openmapx/core/ops";
import { OpsNotWiredError, type OpsRuntime } from "./runtime";

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
  const proposedPath = join(options.rootDir, PROPOSED_RELATIVE_PATH);

  const pair = () => {
    const active = readCatalogPinSet(options.rootDir);
    if (
      !active &&
      (existsSync(join(options.rootDir, LOCK_RELATIVE_PATH)) ||
        existsSync(join(options.rootDir, GBFS_LOCK_RELATIVE_PATH)))
    )
      throw new OpsNotWiredError();
    return active;
  };
  runtime["catalogPins.inspect"] = async () => {
    const active = pair();
    return { active, catalogRevisionId: active ? catalogRevisionId(active) : null };
  };
  runtime["transitousLock.inspect"] = async () => ({
    active: pair()?.transitous ?? null,
    proposed: readLockAt(proposedPath),
  });
  runtime["gbfsCatalogLock.inspect"] = async () => {
    const active = pair();
    if (!active) throw new OpsNotWiredError();
    const { commit, url, sha256, lockedAt, lockedBy } = active.gbfs;
    return { commit, url, sha256, lockedAt, lockedBy };
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

  // The legacy ref-only approval cannot prove paired generation/pointer ownership.
  // Tasks02.3/05.3 replace this same operation with durable paired-pin admission.
  runtime["transitousLock.approve"] = async () => {
    const error = new OpsNotWiredError();
    error.message =
      "Transitous approval requires the durable paired-pin publication upgrade; retain the proposal and inspect current status";
    throw error;
  };

  return runtime;
}
