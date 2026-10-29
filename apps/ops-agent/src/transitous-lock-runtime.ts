import { join } from "node:path";
import type { OpsResultFor } from "@openmapx/core/ops";
import type { TransitousLock } from "@openmapx/transitous-core";
import {
  activeTransitousPin,
  approveTransitousProposal,
  readTransitousProposal,
  releaseGbfsCatalogPin,
  releaseTransitousPin,
  writeTransitousProposal,
} from "@openmapx/transitous-core/pins";
import type { OpsRuntime } from "./runtime";

// The catalog pins are the release's, which the agent's bundle carries. On top
// of the release's Transitous pin, the agent keeps the pin an administrator or
// the auto-bump approved, and a proposal, in its own state directory; it never
// writes the checkout's tracked lock files. Data-manager and the API name a
// pinned ref and let the agent own the state, its shape, and its replacement.

type LockRecord = NonNullable<OpsResultFor<"transitousLock.inspect">["active"]>;

function record(lock: TransitousLock): LockRecord {
  return {
    ref: lock.ref,
    submodules: lock.submodules,
    lockedAt: lock.lockedAt,
    lockedBy: lock.lockedBy,
    ...(lock.comment ? { comment: lock.comment } : {}),
  };
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
 * reviewer read it. The approval holds until a release ships a different pin.
 */
export function createTransitousLockRuntime(
  runtime: OpsRuntime,
  options: TransitousLockRuntimeOptions,
): OpsRuntime {
  const now = options.now ?? (() => new Date());
  const infraDir = join(options.rootDir, "infra", "docker");

  runtime["transitousLock.inspect"] = async () => {
    const proposed = readTransitousProposal(infraDir);
    return {
      active: record(activeTransitousPin(infraDir)),
      proposed: proposed ? record(proposed) : null,
    };
  };

  // app-api's read-only view for the admin panel: the release's pin and the
  // pin in effect, nothing proposed and nothing it can change.
  runtime["transitousPin.inspect"] = async () => ({
    release: record(releaseTransitousPin()),
    active: record(activeTransitousPin(infraDir)),
  });

  runtime["gbfsCatalogLock.inspect"] = async () => {
    const { commit, url, sha256, lockedAt, lockedBy } = releaseGbfsCatalogPin();
    return { commit, url, sha256, lockedAt, lockedBy };
  };

  runtime["transitousLock.propose"] = async (operation) => {
    writeTransitousProposal(infraDir, {
      ref: operation.ref,
      submodules: operation.submodules,
      lockedAt: now().toISOString(),
      lockedBy: operation.lockedBy,
      ...(operation.comment ? { comment: operation.comment } : {}),
    });
    return { ref: operation.ref, proposed: true as const };
  };

  runtime["transitousLock.approve"] = async (operation) => {
    const approval = approveTransitousProposal(infraDir, {
      ref: operation.ref,
      approvedBy: operation.approvedBy,
      now,
    });
    return { ref: approval.ref, lockedAt: approval.lockedAt };
  };

  return runtime;
}
