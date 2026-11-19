/** One durable row per execution: what was admitted, and how far it got. */

import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { type ControlExecutionOrigin, controlOriginSchema } from "../ops/control-root-key";
import { retainedParentExecutionSchema } from "../ops/execution-identity";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import { leaseTargetsSchema } from "../ops/lease-records";
import { dataControlDelegationSchema } from "../services/data-manager/contracts/executions";
import { AnchoredDirectory, acquireGuardDirectory, identity } from "./filesystem";
import {
  type ControlChildPhase,
  type ControlChildReservation,
  type ControlRecipient,
  childPhaseKinds,
  controlChildReservationSchema,
} from "./lease-store";

const recipientSchema = z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]);
const phaseSchema = z.enum(
  Object.keys(childPhaseKinds) as [ControlChildPhase, ...ControlChildPhase[]],
);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export interface ControlPlannedChild {
  phase: ControlChildPhase;
  ordinal: number;
  kind: string;
  execution: ExecutionRef;
  serviceIds: readonly string[];
  recipient: ControlRecipient;
}
export const plannedChildSchema = z.strictObject({
  phase: phaseSchema,
  ordinal: z.number().int().min(0).max(63),
  kind: z.string().min(1).max(128),
  execution: executionRefSchema,
  serviceIds: leaseTargetsSchema,
  recipient: recipientSchema,
});

/** What a role admitted: fixed at admission and never rewritten. */
export const executionAdmissionSchema = z.strictObject({
  execution: executionRefSchema,
  kind: z.string().min(1).max(128),
  operation: z.unknown(),
  admittedAt: z.number().int().nonnegative().safe(),
  requestedDeadlineAt: z.number().int().nonnegative().safe().optional(),
  parent: retainedParentExecutionSchema.optional(),
  /** The child row this execution runs as, under another holder's lease. */
  leaseChild: z.strictObject({ leaseId: z.uuid(), childKey: z.uuid() }).optional(),
  serviceIds: leaseTargetsSchema,
  plan: z.array(plannedChildSchema).max(64),
  reservations: z.array(controlChildReservationSchema).max(64),
  origin: controlOriginSchema,
});
export type ExecutionAdmission = Omit<
  z.infer<typeof executionAdmissionSchema>,
  "plan" | "reservations" | "origin" | "serviceIds"
> & {
  serviceIds: readonly string[];
  plan: readonly ControlPlannedChild[];
  reservations: readonly ControlChildReservation[];
  origin: ControlExecutionOrigin;
};

/** A reserved child: its exact identity once bound, and its grant once attempted. */
export const childCellSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(63),
  binding: z
    .strictObject({
      child: plannedChildSchema,
      boundAt: z.number().int().nonnegative().safe(),
      requestedDeadlineAt: z.number().int().nonnegative().safe(),
    })
    .nullable(),
  /** Recorded before the child is sent: an attempted child is never sent again. */
  delegation: dataControlDelegationSchema.nullable(),
});
export type ChildCell = z.infer<typeof childCellSchema>;

/** The owner's own terminal record of its effect; the receipt is checked by its kind. */
export const executionSettlementSchema = z.strictObject({
  identity: executionRefSchema,
  outcome: z.enum(["contained", "committed", "failed_without_effect", "unknown"]),
  publication: z.enum(["not_started", "committed", "unknown"]),
  terminalReceiptDigest: digest,
  receipt: z
    .record(z.string(), z.unknown())
    .refine((value) => typeof value.kind === "string", "Receipt kind required"),
});
export type ExecutionSettlement = z.infer<typeof executionSettlementSchema>;

/** How far an execution got. Unknown is a settlement too, and never releases. */
export const executionProgressSchema = z.strictObject({
  phase: z.enum(["held", "cancel_pending", "settled"]),
  /** Recorded before the first effect; absent means nothing ran. */
  effectStartedAt: z.number().int().nonnegative().safe().nullable(),
  settlement: executionSettlementSchema.nullable(),
  /** When the settlement was last recorded; the prune counts from it. */
  settledAt: z.number().int().nonnegative().safe().nullable(),
  children: z.array(childCellSchema).max(64),
});
export type ExecutionProgress = z.infer<typeof executionProgressSchema>;

export interface ExecutionRow {
  admission: ExecutionAdmission;
  progress: ExecutionProgress;
}
export const executionRowSchema = z.strictObject({
  admission: executionAdmissionSchema,
  progress: executionProgressSchema,
});

/**
 * Where a role keeps its execution rows: the agent's journal for its
 * operations, a file per execution for a process that has no journal of its
 * own. Every change is durable before `admit`, `update` or `remove` resolves.
 */
export interface ExecutionRows {
  read(operationKey: string): ExecutionRow | undefined;
  /** Records a new row; the same key with a different admission is a conflict. */
  admit(row: ExecutionRow): Promise<"admitted" | "retained">;
  update<T>(operationKey: string, change: (progress: ExecutionProgress) => T): Promise<T>;
  /** Up to `limit` keys the prune may consider; `complete` when none were left out. */
  keys(limit: number): { keys: string[]; complete: boolean };
  remove(operationKeys: readonly string[]): Promise<void>;
}
/** A store that keeps only some keys, in front of another one. */
export interface OwningExecutionRows extends ExecutionRows {
  owns(operationKey: string): boolean;
}

/** Whether two admissions are the same; anything else under one key is a conflict. */
export function sameAdmission(a: ExecutionAdmission, b: ExecutionAdmission): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

const ROW_BYTES = 256 * 1024;
const ROW_NAME = /^opk1_[A-Za-z0-9_-]{16,64}$/;

/**
 * One file per execution in the role's private directory, written atomically.
 * Two processes can share a directory (the agent and its fixed CLI children),
 * so every change holds the row's writer guard while it reads and writes.
 */
export function fileExecutionRows(privateRoot: AnchoredDirectory): ExecutionRows {
  const name = (key: string) => {
    if (!ROW_NAME.test(key)) throw Error("Invalid execution key");
    return `${key}.json`;
  };
  const guarded = <T>(key: string, run: () => T): T => {
    const dir = privateRoot.directory("executions", true, true),
      guard = `${name(key)}.writer`;
    try {
      acquireGuardDirectory(dir.name(guard));
      const held = dir.directory(guard);
      const heldIdentity = identity(held.stat);
      held.close();
      try {
        return run();
      } finally {
        dir.removeDirectory(guard, heldIdentity);
      }
    } finally {
      dir.close();
    }
  };
  /** The rows directory, or undefined while no row was ever written. */
  const existing = () => {
    try {
      return privateRoot.directory("executions");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const read = (key: string): ExecutionRow | undefined => {
    const dir = existing();
    if (!dir) return undefined;
    try {
      return executionRowSchema.parse(
        JSON.parse(dir.read(name(key), ROW_BYTES).toString("utf8")),
      ) as ExecutionRow;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      dir.close();
    }
  };
  const write = (row: ExecutionRow, exclusive: boolean) => {
    const bytes = canonicalJson(executionRowSchema.parse(row));
    if (Buffer.byteLength(bytes) > ROW_BYTES) throw Error("Execution row capacity");
    const dir = privateRoot.directory("executions", true, true);
    try {
      dir.write(name(row.admission.execution.operationKey), bytes, exclusive);
    } finally {
      dir.close();
    }
  };
  return {
    read,
    async admit(row) {
      return guarded(row.admission.execution.operationKey, () => {
        const existing = read(row.admission.execution.operationKey);
        if (existing) {
          if (!sameAdmission(existing.admission, row.admission))
            throw Error("Conflicting retained execution identity");
          return "retained" as const;
        }
        write(row, true);
        return "admitted" as const;
      });
    },
    async update(key, change) {
      return guarded(key, () => {
        const row = read(key);
        if (!row) throw Error("Missing execution row");
        const result = change(row.progress);
        write(row, false);
        return result;
      });
    },
    keys(limit) {
      const dir = existing();
      if (!dir) return { keys: [], complete: true };
      try {
        let names: string[];
        let complete = true;
        try {
          names = dir.listBounded(limit);
        } catch (error) {
          if ((error as Error).message !== "Authority directory capacity exceeded") throw error;
          names = dir.list().slice(0, limit);
          complete = false;
        }
        return {
          keys: names
            .filter((entry) => entry.endsWith(".json"))
            .map((entry) => entry.slice(0, -".json".length))
            .filter((key) => ROW_NAME.test(key)),
          complete,
        };
      } finally {
        dir.close();
      }
    },
    async remove(keys) {
      const dir = existing();
      if (!dir) return;
      try {
        for (const key of keys)
          try {
            dir.removeFile(name(key));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
      } finally {
        dir.close();
      }
    },
  };
}

/**
 * What the agent's journal row adds to its operation to hold the execution:
 * the parts of the admission the row does not already carry, and the progress.
 */
export const journalExecutionSchema = z.strictObject({
  serviceIds: leaseTargetsSchema,
  plan: z.array(plannedChildSchema).max(64),
  reservations: z.array(controlChildReservationSchema).max(64),
  origin: controlOriginSchema,
  progress: executionProgressSchema,
});
export type JournalExecution = z.infer<typeof journalExecutionSchema>;
/** The fields of an agent journal row an execution row is made from. */
export interface JournalOperation {
  operationId: string;
  operationKey: string;
  role: "api" | "data-manager";
  operationFingerprint: string;
  fingerprint: string;
  deadlineAt: number;
  admittedAt: number;
  requestedDeadlineAt?: number;
  parent?: z.infer<typeof retainedParentExecutionSchema>;
  leaseChild?: { leaseId: string; childKey: string };
  operation: { kind: string };
  execution?: JournalExecution;
}
/** The execution row a journal row holds, if any. */
export function journalExecutionRow(job: JournalOperation): ExecutionRow | undefined {
  if (!job.execution) return undefined;
  const { progress, ...rest } = job.execution;
  return {
    admission: {
      execution: {
        executor: "ops-agent",
        principal: job.role,
        executionId: job.operationId,
        operationKey: job.operationKey,
        operationFingerprint: job.operationFingerprint,
        fingerprint: job.fingerprint,
        deadlineAt: job.deadlineAt,
      },
      kind: job.operation.kind,
      operation: job.operation,
      admittedAt: job.admittedAt,
      ...(job.requestedDeadlineAt === undefined
        ? {}
        : { requestedDeadlineAt: job.requestedDeadlineAt }),
      ...(job.parent ? { parent: job.parent } : {}),
      ...(job.leaseChild ? { leaseChild: job.leaseChild } : {}),
      ...rest,
    },
    progress,
  };
}
/**
 * What a journal row stores for `row`, which must be the row of `job`'s own
 * operation; the same key with any other admission is a conflict.
 */
export function journalExecution(job: JournalOperation, row: ExecutionRow): JournalExecution {
  const execution = journalExecutionSchema.parse({
    serviceIds: row.admission.serviceIds,
    plan: row.admission.plan,
    reservations: row.admission.reservations,
    origin: row.admission.origin,
    progress: row.progress,
  });
  const composed = journalExecutionRow({ ...job, execution });
  if (!composed || !sameAdmission(composed.admission, row.admission))
    throw Error("Conflicting retained execution identity");
  return execution;
}

const JOURNAL_BYTES = 24 * 1024 * 1024;
/**
 * The agent's journal as another process reads it: a fixed CLI child reads
 * its parent's row there. Only the agent writes the journal.
 */
export function journalFileRows(infraDir: string): OwningExecutionRows {
  const rows = () => {
    let directory: AnchoredDirectory | undefined;
    try {
      directory = new AnchoredDirectory(join(infraDir, "state", "ops-agent"));
      const file = z
        .object({ version: z.literal(2), jobs: z.array(z.unknown()).max(512) })
        .parse(JSON.parse(directory.read("jobs-v1.json", JOURNAL_BYTES).toString("utf8")));
      const found = new Map<string, ExecutionRow>();
      for (const job of file.jobs) {
        const execution = (job as { execution?: unknown } | null)?.execution;
        if (execution === undefined) continue;
        const row = journalExecutionRow({
          ...(job as JournalOperation),
          execution: journalExecutionSchema.parse(execution),
        });
        if (row) found.set(row.admission.execution.operationKey, row);
      }
      return found;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return new Map<string, ExecutionRow>();
      throw error;
    } finally {
      directory?.close();
    }
  };
  const readOnly = () => Promise.reject(Error("Only the agent writes its journal"));
  return {
    owns: (key) => rows().has(key),
    read: (key) => rows().get(key),
    admit: readOnly,
    update: readOnly,
    keys: () => ({ keys: [], complete: true }),
    remove: readOnly,
  };
}

/** Keys `primary` owns are kept there; every other key is kept in `fallback`. */
export function layeredExecutionRows(
  primary: OwningExecutionRows,
  fallback: ExecutionRows,
): ExecutionRows {
  const of = (key: string) => (primary.owns(key) ? primary : fallback);
  return {
    read: (key) => of(key).read(key),
    admit: (row) => of(row.admission.execution.operationKey).admit(row),
    update: (key, change) => of(key).update(key, change),
    keys(limit) {
      const first = primary.keys(limit),
        second = fallback.keys(Math.max(0, limit - first.keys.length));
      return {
        keys: [...first.keys, ...second.keys],
        complete: first.complete && second.complete,
      };
    },
    async remove(keys) {
      await primary.remove(keys.filter((key) => primary.owns(key)));
      await fallback.remove(keys.filter((key) => !primary.owns(key)));
    },
  };
}
