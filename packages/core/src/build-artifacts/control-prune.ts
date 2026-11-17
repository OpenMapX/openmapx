/** Time-based prune of a role's own control records.
 *
 * An execution's records are removed once its effect outcome is known, its
 * root key has expired, at least 72 hours have passed since it finished, every
 * lease it owns or borrowed has released its root, and no unfinished
 * maintenance owner record names it. Only records whose names derive from the
 * execution's own identifiers go: its operation key, the child keys it planned
 * (unless the child has an admission of its own), and the lease, delegation and
 * attempt IDs read from its own records. A maintenance owner record goes only
 * with its own preparation. Executions whose outcome is unknown, including
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
  childSettlementState,
  installationState,
  readPrivateRecord,
  verifyControlEffectSettlement,
} from "./control-authority";
import { controlOriginSchema, type InstallationState } from "./control-records";
import { AnchoredDirectory } from "./filesystem";
import { MAINTENANCE_NAMESPACE } from "./maintenance-file";
import { rootLeaseId } from "./target-lease";

export const CONTROL_PRUNE_AFTER_MS = 72 * 3600_000;
/** Namespaces swept by name. `executions` and `effects` go last; `configuration-maintenance` goes with its preparation. */
const NAMESPACES = [
  "children",
  "effect-started",
  "observations",
  "leases",
  "attempts",
  "adoptions",
  "parent-attempts",
  "parent-adoptions",
  "execution-parents",
  "spawns",
  "spawn-started",
  "execution-adoptions",
  "hardlinks",
  "catalog-commits",
] as const;
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
    parent: z.record(z.string(), z.unknown()).optional(),
    plan: z.array(childSchema).optional(),
    reservations: z.array(childSchema).optional(),
  })
  .passthrough();
type Admission = z.infer<typeof admissionSchema>;
const leaseReferenceSchema = z.object({ leaseId: z.uuid() }).passthrough();
const adoptionReferenceSchema = z
  .object({ leaseId: z.uuid(), delegationId: z.uuid() })
  .passthrough();
const borrowedSchema = z
  .object({ execution: executionRefSchema, assertion: z.string() })
  .passthrough();
const lifecycleSchema = z
  .object({
    childIntents: z.record(z.string(), z.unknown()).optional(),
    leaseIntents: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
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
/** The role's execution witnesses, in its own private state. */
function witnessDirectory(local: InstallationState): string {
  return join(local.privateRoot.path, "execution-witnesses", local.installation.role);
}
function assertionLeaseId(assertion: string): string {
  return leaseReferenceSchema.parse(
    JSON.parse(Buffer.from(assertion, "base64url").toString("utf8")),
  ).leaseId;
}
type Borrowed = { leaseId: string; delegationId: string }[];
/** Borrower adoptions by operation key, read once per pass; null when an entry
 * is unreadable, so no execution is taken for unleased. */
function adoptionIndex(local: InstallationState, onFull: () => void): Map<string, Borrowed> | null {
  const index = new Map<string, Borrowed>();
  let unreadable = false;
  withNamespace(local, "adoptions", (dir) => {
    for (const entry of entries(dir, onFull))
      try {
        const value = borrowedSchema.parse(JSON.parse(dir.read(entry, 65536).toString("utf8")));
        const key = value.execution.operationKey;
        index.set(key, [
          ...(index.get(key) ?? []),
          {
            leaseId: assertionLeaseId(value.assertion),
            delegationId: entry.replace(/\.json$/, ""),
          },
        ]);
      } catch {
        unreadable = true;
      }
  });
  return unreadable ? null : index;
}
/** Leases this execution borrowed, with the delegation it adopted. */
function borrowedLeases(
  local: InstallationState,
  admitted: Admission,
  name: string,
  adoptions: Map<string, Borrowed>,
): Borrowed {
  const fence = optional(() =>
    adoptionReferenceSchema.parse(readPrivateRecord(local, "execution-adoptions", name, 8192)),
  );
  return [
    ...(fence ? [{ leaseId: fence.leaseId, delegationId: fence.delegationId }] : []),
    ...(adoptions.get(admitted.execution.operationKey) ?? []),
  ];
}
/** The execution and the identifiers of its own records, when they may go. */
async function prunable(
  installation: ControlInstallation,
  local: InstallationState,
  name: string,
  now: number,
  onFull: () => void,
  adoptions: () => Map<string, Borrowed> | null,
): Promise<Prunable | null> {
  const admitted = admissionSchema.parse(readPrivateRecord(local, "executions", name, 65536));
  const key = admitted.execution.operationKey;
  if (admitted.origin.notAfter + CONTROL_PRUNE_AFTER_MS > now) return null;
  const finishedAt = withNamespace(local, "effects", (dir) => mtime(dir, name)) ?? null;
  if (finishedAt === null || finishedAt + CONTROL_PRUNE_AFTER_MS > now) return null;
  const outcome = childSettlementState(
    verifyControlEffectSettlement(installation, admitted.execution),
  ).evidence.outcome;
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
  add(["hardlinks"], admitted.execution.executionId);
  if (admitted.operation?.handoffId) add(["observations"], admitted.operation.handoffId);
  // Fixed children it prepared: their key, spawn and key index records.
  const fixed = optional(() => {
    const witnesses = new AnchoredDirectory(witnessDirectory(local));
    try {
      return z
        .array(z.uuid())
        .parse(JSON.parse(witnesses.read(`${key}.keys.json`, 4096).toString("utf8")));
    } finally {
      witnesses.close();
    }
  });
  for (const id of fixed ?? []) {
    add(["children", "spawns", "spawn-started"], id);
  }
  // As a child: the parent attempt it adopted.
  for (const field of ["attemptId", "delegationId"])
    if (typeof admitted.parent?.[field] === "string")
      add(["parent-adoptions"], admitted.parent[field]);
  // As a parent: the attempts and leases it issued.
  const issued = ["attempts", "children", "parent-attempts", "leases"] as const;
  const lifecycle = optional(() => {
    const witnesses = new AnchoredDirectory(witnessDirectory(local));
    try {
      return lifecycleSchema.parse(
        JSON.parse(witnesses.read(`${key}.lifecycle.json`, 65536).toString("utf8")),
      );
    } finally {
      witnesses.close();
    }
  });
  for (const id of [
    ...Object.keys(lifecycle?.childIntents ?? {}),
    ...Object.keys(lifecycle?.leaseIntents ?? {}),
  ])
    add(issued, id);
  // As a borrower: only its own adoption record, once the lease is released.
  const index = adoptions();
  if (!index) return null;
  // A lease is released once its row is gone from the store.
  for (const lease of borrowedLeases(local, admitted, name, index)) {
    if (await local.leases.read(lease.leaseId)) return null;
    add(["adoptions"], lease.delegationId);
  }
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
/** The role's shared execution witnesses, named after the operation key, and
 * the service lifecycle receipts whose signed seed names a pruned root. */
function removeShared(local: InstallationState, keys: readonly string[], onFull: () => void): void {
  const role = local.installation.role,
    paths = [
      { path: witnessDirectory(local), seed: false },
      ...(role === "ops-agent" || role === "host-cli"
        ? [
            {
              path: join(dirname(local.dataRoot), "state", "ops-agent", "lifecycle"),
              seed: true,
            },
          ]
        : []),
    ];
  for (const { path, seed } of paths) {
    let dir: AnchoredDirectory;
    try {
      dir = new AnchoredDirectory(path);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    try {
      for (const entry of entries(dir, onFull)) {
        let owned = keys.some((key) => entry.startsWith(`${key}.`));
        if (!owned && seed)
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
  const local = installationState(installation),
    now = options.now ?? Date.now(),
    limit = options.limit ?? 64;
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
  let index: Map<string, Borrowed> | null | undefined;
  const adoptions = () => {
    if (index === undefined) index = adoptionIndex(local, onFull);
    return index;
  };
  for (const name of batch) {
    if (options.keep?.(name.replace(/\.json$/, ""))) continue;
    try {
      const value = await prunable(installation, local, name, now, onFull, adoptions);
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
    // The admission goes first, then its terminal commitment and effect: a pass
    // interrupted in between leaves only those, removed as strays below.
    for (const [namespace, name] of [
      ["executions", (key: string) => `${key}.json`],
      ["observations", (key: string) => `terminal-${key}.json`],
      ["effects", (key: string) => `${key}.json`],
    ] as const)
      withNamespace(local, namespace, (dir) => {
        for (const key of keys) optional(() => dir.removeFile(name(key)));
      });
  }
  // Effects and terminal commitments whose admission is gone, from an
  // interrupted pass, go once they are 72 hours old.
  const admitted = new Set(names.filter((name) => !keys.some((key) => name === `${key}.json`)));
  if (complete)
    for (const [namespace, admission] of [
      ["effects", (entry: string) => entry],
      ["observations", (entry: string) => entry.replace(/^terminal-/, "")],
    ] as const)
      withNamespace(local, namespace, (dir) => {
        for (const entry of entries(dir, onFull)) {
          if (
            !entry.endsWith(".json") ||
            (namespace === "observations" && !entry.startsWith("terminal-"))
          )
            continue;
          const finishedAt = mtime(dir, entry);
          if (
            !admitted.has(admission(entry)) &&
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
