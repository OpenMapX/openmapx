/** Time-based prune of a role's own control records.
 *
 * An execution's records are removed once its effect outcome is known, its
 * root key has expired, at least 72 hours have passed since it finished, every
 * lease it owns or borrowed has released its root, and no unfinished
 * maintenance owner record names it. Only records whose names derive from the
 * execution's own identifiers go: its operation key, the child keys it planned
 * (unless the child has an admission of its own) and the spawn records of the
 * fixed children it started. A maintenance owner record goes only with its own
 * preparation. Executions whose outcome is unknown, including
 * those that need recovery, are kept.
 *
 * Deletions are independent and can be repeated. Readers never treat a
 * missing record as permission: a missing admission, effect or lease is
 * unknown, and an expired root key is refused at admission. An agent
 * execution also needs its sealed canonical terminal commitment. */
import { rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { executionRefSchema } from "../ops/execution-ref";
import {
  type ControlInstallation,
  controlOriginSchema,
  type InstallationState,
} from "./control-records";
import { verifyControlEffectSettlement } from "./execution-record";
import { AnchoredDirectory } from "./filesystem";
import { rootLeaseId } from "./lease-store";
import { MAINTENANCE_NAMESPACE } from "./maintenance-file";
import { installationState, readPrivateRecord } from "./private-records";

export const CONTROL_PRUNE_AFTER_MS = 72 * 3600_000;
/** Namespaces swept by name. The execution row goes last; `configuration-maintenance` goes with its preparation. */
const NAMESPACES = ["observations", "spawns", "spawn-started", "catalog-commits"] as const;
const MAX_ENTRIES = 65536;
const childSchema = z.object({ execution: z.object({ operationKey: z.string() }) });
const admissionSchema = z
  .object({
    execution: executionRefSchema,
    origin: controlOriginSchema,
    kind: z.string(),
    operation: z
      .object({ maintenanceId: z.uuid().optional(), handoffId: z.uuid().optional() })
      .passthrough()
      .optional(),
    leaseChild: z.object({ leaseId: z.uuid() }).passthrough().optional(),
    plan: z.array(childSchema).optional(),
    reservations: z.array(childSchema).optional(),
  })
  .passthrough();
type Admission = z.infer<typeof admissionSchema>;
const spawnSchema = z.object({ parent: z.object({ operationKey: z.string() }) }).passthrough();
const lifecycleReceiptSchema = z.object({
  seed: z.object({ root: z.object({ operationKey: z.string() }) }),
});
const ownerSourceSchema = z.object({
  plan: z.object({ operation: z.object({ expectedSourceRevision: z.uuid() }).passthrough() }),
});
const sourceWitness = (revision: string) => `configuration-source-${revision}.json`;
const cursors = new WeakMap<InstallationState, number>();

interface Prunable {
  key: string;
  /** Name fragments of this execution's own records, per namespace ("*" for
   * every swept namespace). */
  identifiers: Map<string, Set<string>>;
  /** The maintenance owner record this execution prepared. */
  ownerRecord?: string;
}

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
/** Up to MAX_ENTRIES names. A larger directory is reported once per pass and
 * pruned in part rather than stopping every later pass. */
function entries(dir: AnchoredDirectory, onFull: () => void): string[] {
  try {
    return dir.listBounded(MAX_ENTRIES);
  } catch (error) {
    if ((error as Error).message !== "Authority directory capacity exceeded") throw error;
    onFull();
    return dir.list().slice(0, MAX_ENTRIES);
  }
}
function optional<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
function mtime(dir: AnchoredDirectory, name: string): number | null {
  try {
    return statSync(dir.name(name)).mtimeMs;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
/** The fixed children each parent started, by the parent's operation key. */
function spawnIndex(local: InstallationState, onFull: () => void): Map<string, string[]> {
  const index = new Map<string, string[]>();
  withNamespace(local, "spawns", (dir) => {
    for (const entry of entries(dir, onFull))
      try {
        const parent = spawnSchema.parse(JSON.parse(dir.read(entry, 65536).toString("utf8"))).parent
          .operationKey;
        index.set(parent, [...(index.get(parent) ?? []), entry.replace(/\.json$/, "")]);
      } catch {
        /* An unreadable spawn record stays. */
      }
  });
  return index;
}
/** The execution and the identifiers of its own records, when they may go. */
async function prunable(
  installation: ControlInstallation,
  local: InstallationState,
  name: string,
  now: number,
  spawns: () => Map<string, string[]>,
): Promise<Prunable | null> {
  const row = z
    .object({ admission: admissionSchema, progress: z.object({ settlement: z.unknown() }) })
    .parse(readPrivateRecord(local, "executions", name, 256 * 1024));
  const admitted = row.admission;
  const key = admitted.execution.operationKey;
  if (admitted.origin.notAfter + CONTROL_PRUNE_AFTER_MS > now) return null;
  // The row's last write is its settlement; a settled row is not written again.
  const finishedAt = row.progress.settlement
    ? (withNamespace(local, "executions", (dir) => mtime(dir, name)) ?? null)
    : null;
  if (finishedAt === null || finishedAt + CONTROL_PRUNE_AFTER_MS > now) return null;
  const outcome = verifyControlEffectSettlement(installation, admitted.execution).outcome;
  if (outcome === "unknown") return null;
  // A step stays while the maintenance it belongs to still has its record;
  // that record goes only with its own preparation.
  const maintenanceId = admitted.operation?.maintenanceId;
  const ownerRecord = maintenanceId ? `${maintenanceId}.json` : undefined;
  const preparation = admitted.kind === "configurationMaintenance.prepare";
  if (
    ownerRecord &&
    !preparation &&
    withNamespace(local, MAINTENANCE_NAMESPACE, (dir) => mtime(dir, ownerRecord)) != null
  )
    return null;
  const identifiers = new Map<string, Set<string>>();
  const add = (namespaces: readonly string[], id: string) => {
    for (const namespace of namespaces)
      identifiers.set(namespace, (identifiers.get(namespace) ?? new Set()).add(id));
  };
  // Its own key and the keys of children it planned that have no admission of
  // their own in this role.
  add(["*"], key);
  for (const child of [...(admitted.plan ?? []), ...(admitted.reservations ?? [])])
    if (
      withNamespace(local, "executions", (dir) =>
        mtime(dir, `${child.execution.operationKey}.json`),
      ) == null
    )
      add(["*"], child.execution.operationKey);
  if (admitted.operation?.handoffId) add(["observations"], admitted.operation.handoffId);
  // Fixed children it started: their spawn records.
  for (const id of spawns().get(key) ?? []) add(["spawns", "spawn-started"], id);
  // As a child under another holder's lease: that lease must be released.
  if (admitted.leaseChild && (await local.leases.read(admitted.leaseChild.leaseId))) return null;
  // Its own root lease must be gone from the store.
  if (await local.leases.read(rootLeaseId(admitted.execution))) return null;
  if (ownerRecord && preparation) {
    const source = optional(() =>
      ownerSourceSchema.safeParse(readPrivateRecord(local, MAINTENANCE_NAMESPACE, ownerRecord)),
    );
    if (source?.success)
      add(["observations"], sourceWitness(source.data.plan.operation.expectedSourceRevision));
  }
  return {
    key,
    identifiers,
    ...(ownerRecord && preparation ? { ownerRecord } : {}),
  };
}
/** The service lifecycle receipts named after a pruned root or whose recorded seed names one. */
function removeShared(local: InstallationState, keys: readonly string[], onFull: () => void): void {
  const role = local.installation.role;
  if (role !== "ops-agent" && role !== "host-cli") return;
  let dir: AnchoredDirectory;
  try {
    dir = new AnchoredDirectory(join(dirname(local.dataRoot), "state", "ops-agent", "lifecycle"));
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  try {
    for (const entry of entries(dir, onFull)) {
      let owned = keys.some((key) => entry.startsWith(`${key}.`));
      if (!owned)
        try {
          const root = lifecycleReceiptSchema.parse(
            JSON.parse(dir.read(entry, 65536, false).toString("utf8")),
          ).seed.root.operationKey;
          owned = keys.includes(root);
        } catch {
          /* Unreadable entries are left alone. */
        }
      if (owned) rmSync(dir.name(entry), { recursive: true, force: true });
    }
  } finally {
    dir.close();
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
    /** A directory held more entries than one pass reads. */
    onFull?: () => void;
  } = {},
): Promise<string[]> {
  // Data-manager's short traffic runs alone admit about 30 executions an hour.
  const local = installationState(installation),
    now = options.now ?? Date.now(),
    limit = options.limit ?? 256;
  let reported = false;
  const onFull = () => {
    if (!reported) options.onFull?.();
    reported = true;
  };
  if (local.fixedChildId) return [];
  const names = (withNamespace(local, "executions", (dir) => entries(dir, onFull)) ?? [])
    .filter((name) => name.endsWith(".json"))
    .sort();
  // Strays are recognised only against the complete list of admissions.
  const complete = !reported;
  const start = (cursors.get(local) ?? 0) % Math.max(names.length, 1),
    batch = [...names.slice(start), ...names.slice(0, start)].slice(0, limit);
  cursors.set(local, start + batch.length);
  const found: Prunable[] = [];
  let index: Map<string, string[]> | undefined;
  const spawns = () => {
    index ??= spawnIndex(local, onFull);
    return index;
  };
  for (const name of batch) {
    if (options.keep?.(name.replace(/\.json$/, ""))) continue;
    try {
      const value = await prunable(installation, local, name, now, spawns);
      if (value) found.push(value);
    } catch {
      /* An unreadable or unverifiable record is kept. */
    }
  }
  const keys = found.map((value) => value.key);
  if (keys.length) {
    await options.beforeRemove?.(keys);
    removeShared(local, keys, onFull);
    const terminals = new Set(keys.map((key) => `terminal-${key}.json`));
    for (const namespace of NAMESPACES) {
      const ids = found.flatMap((value) => [
        ...(value.identifiers.get("*") ?? []),
        ...(value.identifiers.get(namespace) ?? []),
      ]);
      withNamespace(local, namespace, (dir) => {
        for (const entry of entries(dir, onFull))
          if (!terminals.has(entry) && ids.some((id) => entry.includes(id))) dir.removeFile(entry);
      });
    }
    withNamespace(local, MAINTENANCE_NAMESPACE, (dir) => {
      for (const { ownerRecord } of found)
        if (ownerRecord) {
          optional(() => dir.removeFile(ownerRecord));
          optional(() => dir.removeFile(ownerRecord.replace(/\.json$/, ".handoff.json")));
        }
    });
    // A namespace read only in part may still hold records of these
    // executions; their admissions stay so a later pass finds them again.
    if (reported) return [];
    // The row goes first, then its terminal commitment: a pass interrupted in
    // between leaves only that, removed as a stray below.
    for (const [namespace, name] of [
      ["executions", (key: string) => `${key}.json`],
      ["observations", (key: string) => `terminal-${key}.json`],
    ] as const)
      withNamespace(local, namespace, (dir) => {
        for (const key of keys) optional(() => dir.removeFile(name(key)));
      });
  }
  // Terminal commitments whose row is gone, from an interrupted pass, go
  // once they are 72 hours old.
  const admitted = new Set(names.filter((name) => !keys.some((key) => name === `${key}.json`)));
  if (complete)
    withNamespace(local, "observations", (dir) => {
      for (const entry of entries(dir, onFull)) {
        if (!entry.endsWith(".json") || !entry.startsWith("terminal-")) continue;
        const finishedAt = mtime(dir, entry);
        if (
          !admitted.has(entry.replace(/^terminal-/, "")) &&
          finishedAt !== null &&
          finishedAt + CONTROL_PRUNE_AFTER_MS <= now
        )
          optional(() => dir.removeFile(entry));
      }
    });
  // Source witnesses no maintenance owner references any more, once old enough.
  if (complete) {
    const referenced = new Set<string>();
    withNamespace(local, MAINTENANCE_NAMESPACE, (dir) => {
      for (const entry of entries(dir, onFull)) {
        const source = ownerSourceSchema.safeParse(
          optional(() => readPrivateRecord(local, MAINTENANCE_NAMESPACE, entry)),
        );
        if (source.success)
          referenced.add(sourceWitness(source.data.plan.operation.expectedSourceRevision));
      }
    });
    if (!reported)
      withNamespace(local, "observations", (dir) => {
        for (const entry of entries(dir, onFull)) {
          const observedAt = entry.startsWith("configuration-source-") ? mtime(dir, entry) : null;
          if (
            observedAt !== null &&
            observedAt + CONTROL_PRUNE_AFTER_MS <= now &&
            !referenced.has(entry)
          )
            optional(() => dir.removeFile(entry));
        }
      });
  }
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
      onFull: () =>
        options.onError(
          Error("A control record directory exceeds one prune pass; pruning in part"),
        ),
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
