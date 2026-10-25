import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  decodeGbfsCatalogLock,
  decodeTransitousLock,
  type GbfsCatalogLock,
  type TransitousLock,
} from "./catalog-pins.js";

/**
 * The catalog pins in effect on a deployment, for the operations agent and
 * its CLI only (`@openmapx/transitous-core/pins`; data-manager asks the agent).
 *
 * The release ships its pins, read through literal `new URL(…, import.meta.url)`
 * references: a runtime bundle carries copies its digest covers and reads
 * those, never the host checkout's; run from source, they are the checkout's
 * own files. On top of the release's Transitous pin, the agent keeps an
 * approved one and a proposal in its own state directory,
 * `infra/docker/state/ops-agent/transitous/`, which only its user can reach.
 * Nothing here writes a file the repository tracks.
 */

/** The release's Transitous catalog pin. */
export function releaseTransitousPin(): TransitousLock {
  return decodeTransitousLock(
    JSON.parse(
      readFileSync(new URL("../../../infra/docker/transitous.lock.json", import.meta.url), "utf8"),
    ),
    "The release's Transitous catalog pin",
  );
}

/** The release's GBFS registry pin. */
export function releaseGbfsCatalogPin(): GbfsCatalogLock {
  return decodeGbfsCatalogLock(
    JSON.parse(
      readFileSync(
        new URL("../../../infra/docker/gbfs-catalog.lock.json", import.meta.url),
        "utf8",
      ),
    ),
    "The release's GBFS catalog pin",
  );
}

/** An approved Transitous pin, with the release pin it replaced. */
export interface TransitousApproval extends TransitousLock {
  /** The ref of the release's pin when it was approved. */
  releasePin: string;
}

const MAX_STATE_BYTES = 256 * 1024;

export function transitousStatePaths(infraDir: string) {
  const directory = join(infraDir, "state", "ops-agent", "transitous");
  return {
    directory,
    proposed: join(directory, "proposed.json"),
    approved: join(directory, "approved.json"),
  };
}

function owner(): number | undefined {
  return process.geteuid?.();
}

/** A real directory of this user that its group and others cannot reach; refused, never repaired. */
function assertOwnDirectory(path: string): void {
  const stats = lstatSync(path);
  const uid = owner();
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (uid !== undefined && stats.uid !== uid) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(
      `${path} must be a directory owned by uid ${uid} that its group and others cannot reach`,
    );
  }
}

/** The file as this user wrote it, or null when it is missing. */
function readStateFile(path: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path} must be a regular file, not a symbolic link`);
  }
  try {
    assertOwnDirectory(dirname(path));
    const stats = fstatSync(descriptor);
    const uid = owner();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (uid !== undefined && stats.uid !== uid) ||
      (stats.mode & 0o022) !== 0 ||
      stats.size > MAX_STATE_BYTES
    ) {
      throw new Error(
        `${path} must be a regular file owned by uid ${uid}, with one link and no group or other write`,
      );
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Publish `value` at `path` atomically, owner-only, creating the state directory owner-only. */
function writeStateFile(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnDirectory(dirname(directory));
  assertOwnDirectory(directory);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  fsyncDirectory(directory);
}

function removeStateFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  fsyncDirectory(dirname(path));
}

export function readTransitousProposal(infraDir: string): TransitousLock | null {
  const path = transitousStatePaths(infraDir).proposed;
  const raw = readStateFile(path);
  return raw === null ? null : decodeTransitousLock(JSON.parse(raw), path);
}

export function readTransitousApproval(infraDir: string): TransitousApproval | null {
  const path = transitousStatePaths(infraDir).approved;
  const raw = readStateFile(path);
  if (raw === null) return null;
  const value = JSON.parse(raw) as { releasePin?: unknown };
  if (typeof value.releasePin !== "string" || !value.releasePin) {
    throw new Error(`${path} is missing required field "releasePin"`);
  }
  return { ...decodeTransitousLock(value, path), releasePin: value.releasePin };
}

/** Propose a pin for an inactive slot; nothing is activated. */
export function writeTransitousProposal(infraDir: string, lock: TransitousLock): void {
  writeStateFile(transitousStatePaths(infraDir).proposed, decodeTransitousLock(lock));
}

/**
 * Activate the proposal whose ref is exactly `ref`, recording the release pin
 * it replaces, and clear the proposal.
 */
export function approveTransitousProposal(
  infraDir: string,
  input: { ref: string; approvedBy: string; now?: () => Date },
): TransitousApproval {
  const proposal = readTransitousProposal(infraDir);
  if (!proposal) throw new Error("No Transitous lock proposal to approve");
  if (proposal.ref !== input.ref) {
    // The reviewer approved a different ref than the one now proposed.
    throw new Error("Transitous lock proposal does not match the approved ref");
  }
  const approval: TransitousApproval = {
    ref: proposal.ref,
    submodules: proposal.submodules,
    lockedAt: (input.now ?? (() => new Date()))().toISOString(),
    lockedBy: input.approvedBy,
    comment: "Approved after compatibility review and inactive-slot validation.",
    releasePin: releaseTransitousPin().ref,
  };
  writeStateFile(transitousStatePaths(infraDir).approved, approval);
  // An approval that committed leaves the proposal inert: approving re-reads
  // and re-matches it.
  removeStateFile(transitousStatePaths(infraDir).proposed);
  return approval;
}

/**
 * The Transitous pin in effect: the approved one while it was approved over
 * this release's pin, otherwise the release's. A release that ships a
 * different pin takes over; `retireStaleTransitousApproval` removes the
 * approval it superseded.
 */
export function activeTransitousPin(infraDir: string): TransitousLock {
  const release = releaseTransitousPin();
  const approval = readTransitousApproval(infraDir);
  if (!approval || approval.releasePin !== release.ref) return release;
  const { releasePin: _releasePin, ...pin } = approval;
  return pin;
}

/** Remove an approval a newer release's pin supersedes, and return it to be reported. */
export function retireStaleTransitousApproval(
  infraDir: string,
): { approval: TransitousApproval; release: TransitousLock } | null {
  const release = releaseTransitousPin();
  const approval = readTransitousApproval(infraDir);
  if (!approval || approval.releasePin === release.ref) return null;
  removeStateFile(transitousStatePaths(infraDir).approved);
  return { approval, release };
}
