import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import {
  catalogRevisionId,
  listCatalogProposals,
  readCatalogPinSet,
  readCatalogProposal,
  retainCatalogProposal,
} from "@openmapx/core/catalog-pins";
import type { OpsResultFor } from "@openmapx/core/ops";
import { releaseTransitousPin } from "@openmapx/transitous-core/pins";
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
  runtime["transitousPin.inspect"] = async () => {
    const active = pair();
    if (!active) throw new OpsNotWiredError();
    const { ref, submodules, lockedAt, lockedBy, comment } = releaseTransitousPin();
    return {
      release: { ref, submodules, lockedAt, lockedBy, ...(comment ? { comment } : {}) },
      active: active.transitous,
    };
  };
  runtime["catalogPins.inspect"] = async () => {
    const active = pair();
    return { active, catalogRevisionId: active ? catalogRevisionId(active) : null };
  };
  runtime["transitousLock.inspect"] = async (operation) => {
    const base = { active: pair()?.transitous ?? null, proposed: readLockAt(proposedPath) };
    if (operation.proposalId === undefined && operation.offset === undefined) return base;
    const installation = openControlInstallation({
      infraDir: join(options.rootDir, "infra/docker"),
      role: "ops-agent",
    });
    try {
      return {
        ...base,
        proposal: operation.proposalId
          ? readCatalogProposal({
              rootDir: options.rootDir,
              installation,
              proposalId: operation.proposalId,
            })
          : null,
        page: listCatalogProposals({
          rootDir: options.rootDir,
          installation,
          offset: operation.offset,
        }),
      };
    } finally {
      closeControlInstallation(installation);
    }
  };

  runtime["gbfsCatalogLock.inspect"] = async () => {
    const active = pair();
    if (!active) throw new OpsNotWiredError();
    const { commit, url, sha256, lockedAt, lockedBy } = active.gbfs;
    return { commit, url, sha256, lockedAt, lockedBy };
  };

  runtime["transitousLock.propose"] = async ({ kind: _kind, ...proposal }, context) => {
    const installation = openControlInstallation({
      infraDir: join(options.rootDir, "infra/docker"),
      role: "ops-agent",
    });
    try {
      const retained = await retainCatalogProposal({
        rootDir: options.rootDir,
        installation,
        proposal,
        now: now(),
        signal: context.signal,
      });
      return {
        proposalId: retained.proposalId,
        catalogRevisionId: retained.pins.generationId,
        proposed: true as const,
      };
    } finally {
      closeControlInstallation(installation);
    }
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
