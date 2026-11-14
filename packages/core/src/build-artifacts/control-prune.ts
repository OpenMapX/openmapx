/** Time-based prune of a role's own control records.
 *
 * An execution's records are removed once its effect outcome is known, its
 * root key has expired, at least 72 hours have passed since it finished, and
 * any lease it owns has been released. A record belongs to an execution when
 * its name or its content names the execution's operation key. Executions
 * whose outcome is unknown, including those that need recovery, are kept.
 *
 * Deletions are independent and can be repeated. Readers never treat a
 * missing record as permission: a missing admission, effect or lease is
 * unknown, and an expired root key is refused at admission. An agent
 * execution also needs its sealed canonical terminal commitment. */
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import {
  type ControlInstallation,
  childSettlementState,
  installationState,
  readPrivateRecord,
  restoreAdmittedControlExecution,
  verifyControlEffectSettlement,
} from "./control-authority";
import { controlOriginSchema, type InstallationState } from "./control-records";
import { AnchoredDirectory } from "./filesystem";
import {
  removeReleasedArtifactTargetLease,
  verifyRetainedArtifactTargetRootRelease,
} from "./target-lease";

export const CONTROL_PRUNE_AFTER_MS = 72 * 3600_000;
const NAMESPACES = [
  "children",
  "child-keys",
  "effect-started",
  "observations",
  "leases",
  "execution-leases",
  "attempts",
  "adoptions",
  "parent-attempts",
  "parent-adoptions",
  "execution-parents",
  "execution-lifecycle",
  "lifecycle-observations",
  "spawns",
  "spawn-started",
  "prepared",
  "execution-adoptions",
  "configuration-maintenance",
  "hardlinks",
  "catalog-commits",
] as const;
const MAX_ENTRIES = 65536;
const admissionSchema = z.object({
  payload: z.object({ execution: executionRefSchema, origin: controlOriginSchema }).passthrough(),
});
const leaseReferenceSchema = z.object({ leaseId: z.uuid() }).passthrough();
const terminalCommitmentSchema = z.object({
  payload: z.object({ phase: z.enum(["prepared", "canonical"]) }).passthrough(),
});
const cursors = new WeakMap<InstallationState, number>();

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function withNamespace<T>(
  local: InstallationState,
  namespace: string,
  run: (dir: AnchoredDirectory) => T,
): T | undefined {
  let dir: AnchoredDirectory;
  try {
    dir = local.privateRoot.directory(namespace);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    return run(dir);
  } finally {
    dir.close();
  }
}
function leaseDirectory(local: InstallationState, leaseId: string): string {
  return join(local.dataRoot, ".admin-target-control", "leases", leaseId);
}
function modifiedAt(local: InstallationState, namespace: string, name: string): number | null {
  return (
    withNamespace(local, namespace, (dir) => {
      try {
        return statSync(dir.name(name)).mtimeMs;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    }) ?? null
  );
}
/** The operation key and owned lease of an execution whose records may go. */
function prunable(
  installation: ControlInstallation,
  local: InstallationState,
  name: string,
  now: number,
): { key: string; execution: ExecutionRef; leased: boolean } | null {
  const admitted = admissionSchema.parse(
    readPrivateRecord(local, "executions", name, 65536),
  ).payload;
  if (admitted.origin.notAfter + CONTROL_PRUNE_AFTER_MS > now) return null;
  // Every agent execution reserves a terminal commitment before its effect;
  // only a sealed canonical commitment proves its journal terminal.
  if (
    local.installation.role === "ops-agent" &&
    terminalCommitmentSchema.safeParse(
      readPrivateRecord(local, "observations", `terminal-${name}`, 4096),
    ).data?.payload.phase !== "canonical"
  )
    return null;
  const finishedAt = modifiedAt(local, "effects", name);
  if (finishedAt === null || finishedAt + CONTROL_PRUNE_AFTER_MS > now) return null;
  const outcome = childSettlementState(
    verifyControlEffectSettlement(installation, admitted.execution),
  ).evidence.outcome;
  if (outcome === "unknown") return null;
  let leaseId: string | undefined,
    leased = false;
  try {
    leaseId = leaseReferenceSchema.parse(
      readPrivateRecord(local, "execution-leases", name),
    ).leaseId;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  // A lease already removed by an earlier interrupted pass has nothing to hold.
  if (leaseId && modifiedAt(local, "execution-leases", name) !== null) {
    try {
      statSync(leaseDirectory(local, leaseId));
      verifyRetainedArtifactTargetRootRelease(
        restoreAdmittedControlExecution(installation, admitted.execution),
      );
      leased = true;
    } catch (error) {
      if (!missing(error)) return null;
    }
  }
  return { key: admitted.execution.operationKey, execution: admitted.execution, leased };
}
/** The role's shared execution witnesses, named after the operation key, and
 * the service lifecycle receipts whose signed seed names a pruned root. */
function removeShared(local: InstallationState, keys: readonly string[]): void {
  const role = local.installation.role,
    paths = [
      { path: join(local.dataRoot, ".admin-target-control", "executions", role), content: false },
      ...(role === "ops-agent" || role === "host-cli"
        ? [{ path: join(local.dataRoot, "ops-agent", "lifecycle"), content: true }]
        : []),
    ];
  for (const { path, content } of paths) {
    let dir: AnchoredDirectory;
    try {
      dir = new AnchoredDirectory(path);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    try {
      for (const entry of dir.listBounded(MAX_ENTRIES)) {
        let owned = keys.some((key) => entry.startsWith(`${key}.`));
        if (!owned && content)
          try {
            const text = dir.read(entry, 65536, false).toString("utf8");
            owned = keys.some((key) => text.includes(key));
          } catch {
            /* Unreadable entries are left alone. */
          }
        if (owned) rmSync(dir.name(entry), { recursive: true, force: true });
      }
    } finally {
      dir.close();
    }
  }
}
/** One bounded pass over at most `limit` admissions. Returns the operation
 * keys whose records were removed. `beforeRemove` runs first, for a role's
 * own rows elsewhere; if it fails, nothing is removed in this pass. */
export async function pruneControlRecords(
  installation: ControlInstallation,
  options: {
    now?: number;
    limit?: number;
    /** Keys whose records stay although they are otherwise prunable. */
    keep?: (operationKey: string) => boolean;
    beforeRemove?: (keys: readonly string[]) => Promise<void>;
  } = {},
): Promise<string[]> {
  const local = installationState(installation),
    now = options.now ?? Date.now(),
    limit = options.limit ?? 64;
  if (local.fixedChildId) return [];
  const names = (withNamespace(local, "executions", (dir) => dir.listBounded(MAX_ENTRIES)) ?? [])
    .filter((name) => name.endsWith(".json"))
    .sort();
  const start = (cursors.get(local) ?? 0) % Math.max(names.length, 1),
    batch = [...names.slice(start), ...names.slice(0, start)].slice(0, limit);
  cursors.set(local, start + batch.length);
  const found: { key: string; execution: ExecutionRef; leased: boolean }[] = [];
  for (const name of batch) {
    try {
      const value = prunable(installation, local, name, now);
      if (value && !options.keep?.(value.key)) found.push(value);
    } catch {
      /* An unreadable or unverifiable record is kept. */
    }
  }
  const keys = found.map((value) => value.key);
  if (keys.length) {
    await options.beforeRemove?.(keys);
    for (const { execution, leased } of found)
      if (leased)
        removeReleasedArtifactTargetLease(restoreAdmittedControlExecution(installation, execution));
    removeShared(local, keys);
    for (const namespace of NAMESPACES)
      withNamespace(local, namespace, (dir) => {
        for (const entry of dir.listBounded(MAX_ENTRIES)) {
          let owned = keys.some((key) => entry.includes(key));
          if (!owned)
            try {
              const text = dir.read(entry, 1024 * 1024).toString("utf8");
              owned = keys.some((key) => text.includes(key));
            } catch {
              /* Unreadable entries are left alone. */
            }
          if (owned) dir.removeFile(entry);
        }
      });
    // The admission goes before the effect: a pass interrupted in between
    // leaves only an effect without an admission, removed below.
    withNamespace(local, "executions", (dir) => {
      for (const key of keys) dir.removeFile(`${key}.json`);
    });
  }
  withNamespace(local, "effects", (dir) => {
    const admitted = new Set(names);
    for (const entry of dir.listBounded(MAX_ENTRIES)) {
      const finishedAt = modifiedAt(local, "effects", entry);
      if (
        entry.endsWith(".json") &&
        (keys.some((key) => entry === `${key}.json`) ||
          (!admitted.has(entry) &&
            finishedAt !== null &&
            finishedAt + CONTROL_PRUNE_AFTER_MS <= now))
      )
        dir.removeFile(entry);
    }
  });
  return keys;
}
/** Runs the prune at startup and then hourly. Failures go to `onError`;
 * a prune never grants or blocks admission. */
export function startControlPrune(
  installation: ControlInstallation,
  options: {
    onError: (error: unknown) => void;
    keep?: (operationKey: string) => boolean;
    beforeRemove?: (keys: readonly string[]) => Promise<void>;
  },
): { ready: Promise<void>; stop: () => Promise<void> } {
  let pending: Promise<void> | undefined,
    stopped = false;
  const pass = () => {
    if (stopped) return Promise.resolve();
    pending ??= pruneControlRecords(installation, {
      keep: options.keep,
      beforeRemove: options.beforeRemove,
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!stopped) options.onError(error);
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  const ready = pass(),
    timer = setInterval(() => void pass(), 3600_000);
  timer.unref();
  return {
    ready,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}
