import { createHash, randomUUID } from "node:crypto";
import {
  type ContainedDataExecution,
  type DataExecutionControlJournal,
  retainedControlParent,
  retainedDataDatabaseTimestamp,
} from "@openmapx/core/build-artifacts";
import {
  type DataExecutionIdentity,
  type DataExecutionInput,
  type DataExecutionStatus,
  dataExecutionStatusSchema,
  isDataExecutionTerminal,
  normalizeDataExecutionInput,
} from "@openmapx/core/data-manager-contracts";
import {
  canonicalJson,
  type ExecutionRef,
  executionFingerprint,
  executionRefSchema,
  normalizeExecutionAdmission,
  parseControlRootOperationKey,
  type RetainedParentExecution,
  retainedParentExecutionSchema,
  type VerifiedParentExecution,
} from "@openmapx/core/ops";
import type postgres from "postgres";
import z from "zod/v4";
import {
  type DataOpsChildAttempt,
  type DataOpsChildReserved,
  dataOpsChildAttemptSchema,
  dataOpsChildReservedSchema,
  reserveTransitChildOperations,
  sameDataChildBody,
} from "./ops-children.js";

const reservationBrand = Symbol("data-child-reservation");
export type FreshDataChildReservation = Readonly<{ [reservationBrand]: true }>;
const reservationContinuations = new WeakMap<
  FreshDataChildReservation,
  { store: symbol; id: string; key: string; used: boolean }
>();

import type { DataConfigurationMaintenance } from "./configuration-maintenance.js";
export const DATA_ADMISSION_LOCK = [0x4f4d58, 2] as const;
export class DataExecutionConflict extends Error {
  readonly statusCode = 409;
}
export class LegacyTransitDuplicate extends Error {
  readonly statusCode = 409;
  constructor(readonly existingJobId: string) {
    super("duplicate-idempotency-key");
  }
}
export class DataConfigurationMaintenanceBusy extends Error {
  readonly statusCode = 409;
  constructor() {
    super("configuration_maintenance_busy");
  }
}
export interface DataExecutionRecord {
  triggeredBy: string | null;
  execution: ExecutionRef;
  status: DataExecutionStatus;
  input: DataExecutionInput;
  operationFingerprint: string;
  requestedDeadlineAt: number | null;
  parent: RetainedParentExecution | null;
  version: number;
  children: DataOpsChildAttempt[];
  reservations: DataOpsChildReserved[];
  finishedAt: number | null;
}
export interface DataExecutionAdmissionOptions {
  operationKey: string;
  requestedDeadlineAt?: number;
  parent?: VerifiedParentExecution;
  id?: string;
  principal?: ExecutionRef["principal"];
  sourceJobId?: string;
  triggeredBy?: string;
  legacyTransitKey?: string;
}
export type DataExecutionPatch = Partial<
  Pick<DataExecutionStatus, "status" | "progress" | "diagnostics" | "publication" | "result">
>;
const fields = dataExecutionStatusSchema.shape;
const patchSchema = z
  .strictObject({
    status: fields.status.optional(),
    progress: fields.progress.optional(),
    diagnostics: fields.diagnostics.optional(),
    publication: fields.publication.optional(),
    result: fields.result,
  })
  .partial();
export function validateDataExecutionPatch(value: unknown): DataExecutionPatch {
  return patchSchema.parse(value);
}
export function dataExecutionInputFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(normalizeDataExecutionInput(value)))
    .digest("hex");
}
export interface DataExecutionStore {
  readonly controlJournal?: DataExecutionControlJournal;
  admit(
    input: DataExecutionInput,
    options: DataExecutionAdmissionOptions,
  ): Promise<{ created: boolean; record: DataExecutionRecord }>;
  inspect(id: string): Promise<DataExecutionRecord | null>;
  lookup(operationKey: string): Promise<DataExecutionRecord | null>;
  checkpoint(
    id: string,
    expectedVersion: number,
    patch: DataExecutionPatch,
  ): Promise<DataExecutionRecord | null>;
  checkpointChild(
    id: string,
    expectedVersion: number,
    attempt: DataOpsChildAttempt,
  ): Promise<DataExecutionRecord | null>;
  reserveChild(
    id: string,
    expectedVersion: number,
    child: DataOpsChildReserved,
  ): Promise<{
    record: DataExecutionRecord;
    continuation: FreshDataChildReservation | null;
  } | null>;
  claimChildDispatch(
    id: string,
    expectedVersion: number,
    child: Extract<DataOpsChildAttempt, { state: "attempted" }>,
    continuation: FreshDataChildReservation,
  ): Promise<DataExecutionRecord | null>;
  requestCancel(identity: DataExecutionIdentity): Promise<DataExecutionRecord | null>;
  listUnsettled(): Promise<DataExecutionRecord[]>;
  finalize(
    id: string,
    expectedVersion: number,
    patch: DataExecutionPatch,
    completion: ContainedDataExecution,
  ): Promise<DataExecutionRecord | null>;
}
interface Row extends Record<string, unknown> {
  triggered_by: string | null;
  id: string;
  kind: string;
  status: string;
  operation_key: string;
  operation_fingerprint: string;
  execution_fingerprint: string;
  admitted_at: string | number;
  deadline_at: string | number;
  requested_deadline_at: string | number | null;
  execution_parent: unknown;
  execution_input: unknown;
  execution_state: unknown;
  execution_children: unknown;
  ownership_version: number;
  finished_at: Date | string | null;
  metadata: unknown;
}
function safeEpoch(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw Error("Invalid stored execution time");
  return result;
}
function decode(row: Row): DataExecutionRecord {
  const input = normalizeDataExecutionInput(row.execution_input);
  const mutable = z
    .strictObject({
      cancellationRequestedAt: z.iso.datetime({ offset: true }).nullable(),
      progress: z.number().nullable(),
      diagnostics: z.unknown(),
      publication: z.enum(["not_started", "committed", "unknown"]),
      result: z.unknown().optional(),
    })
    .parse(row.execution_state);
  const status = dataExecutionStatusSchema.parse({
    id: row.id,
    kind: input.kind,
    status: row.status,
    operationKey: row.operation_key,
    fingerprint: row.execution_fingerprint,
    admittedAt: safeEpoch(row.admitted_at),
    deadlineAt: safeEpoch(row.deadline_at),
    ...mutable,
  });
  if (dataExecutionInputFingerprint(input) !== row.operation_fingerprint || row.kind !== input.kind)
    throw Error("Stored execution body mismatch");
  const {
    dataExecution: { execution, childReservations },
  } = z
    .object({
      dataExecution: z.strictObject({
        version: z.literal(1),
        execution: executionRefSchema,
        childReservations: z.array(dataOpsChildReservedSchema).max(32).optional(),
      }),
    })
    .parse(row.metadata);
  if (
    execution.executor !== "data-manager" ||
    execution.executionId !== status.id ||
    execution.operationKey !== status.operationKey ||
    execution.operationFingerprint !== row.operation_fingerprint ||
    execution.fingerprint !== status.fingerprint ||
    execution.deadlineAt !== status.deadlineAt
  )
    throw Error("Stored execution authority identity mismatch");
  const parent =
    row.execution_parent === null
      ? null
      : retainedParentExecutionSchema.parse(row.execution_parent);
  if (
    execution.fingerprint !==
    executionFingerprint({
      kind: input.kind,
      operationFingerprint: execution.operationFingerprint,
      deadlineAt: execution.deadlineAt,
      ...(parent ? { parent } : {}),
    })
  )
    throw Error("Stored execution fingerprint mismatch");
  return {
    triggeredBy: z
      .string()
      .nullable()
      .parse(row.triggered_by ?? null),
    execution,
    status,
    input,
    operationFingerprint: row.operation_fingerprint,
    requestedDeadlineAt:
      row.requested_deadline_at === null ? null : safeEpoch(row.requested_deadline_at),
    parent,
    version: z.number().int().nonnegative().safe().parse(row.ownership_version),
    children: validateChildren(row.execution_children),
    reservations: (childReservations ?? []).map((value) => {
      const parsed = dataOpsChildAttemptSchema.parse(value);
      if (parsed.state !== "reserved") throw Error("Invalid reserved body");
      return parsed;
    }),
    finishedAt:
      row.finished_at === null ? null : retainedDataDatabaseTimestamp(row.finished_at).getTime(),
  };
}
function validateChildren(value: unknown): DataOpsChildAttempt[] {
  const children = z.array(dataOpsChildAttemptSchema).max(32).parse(value);
  if (Buffer.byteLength(JSON.stringify(children)) > 128 * 1024)
    throw Error("Data child capacity exceeded");
  const keys = new Set(children.map((child) => child.operationKey));
  if (keys.size !== children.length) throw Error("Duplicate child identity");
  return children;
}
/** The check and job/reservation insertion must share this connection and
 * transaction. A contending admission never waits while retaining targets. */
export async function withDataAdmissionTransaction<T>(
  sql: postgres.Sql,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    const lock =
      await tx`SELECT pg_try_advisory_xact_lock(${DATA_ADMISSION_LOCK[0]},${DATA_ADMISSION_LOCK[1]}) AS held`;
    if (lock[0]?.held !== true) throw new DataConfigurationMaintenanceBusy();
    const guard =
      await tx`SELECT id FROM data_manager.jobs WHERE kind='configuration-maintenance' AND coalesce(metadata->'configurationMaintenance'->>'guardState','recovery_required') <> 'settled' LIMIT 1`;
    if (guard.length) throw new DataConfigurationMaintenanceBusy();
    return { value: await run(tx) };
  });
  return result.value;
}
export function createPostgresDataExecutionStore(
  sql: postgres.Sql,
  options: {
    now?: () => number;
    controlJournal?: DataExecutionControlJournal;
    configurationFence?: DataConfigurationMaintenance;
  } = {},
): DataExecutionStore {
  const now = options.now ?? Date.now;
  const storeIdentity = Symbol("data-store");
  const findLegacyTransit = async (tx: postgres.Sql | postgres.TransactionSql, key: string) => {
    const rows = await tx.unsafe<Row[]>(
      "SELECT * FROM data_manager.jobs WHERE idempotency_key=$1 AND (started_at >= $2::text::timestamptz OR finished_at IS NULL) ORDER BY started_at DESC,id LIMIT 1",
      [key, new Date(now() - 24 * 3600000).toISOString()],
    );
    return rows[0];
  };
  const find = async (
    tx: postgres.Sql | postgres.TransactionSql,
    key: "id" | "operation_key",
    value: string,
    lock = false,
  ) => {
    const rows = await tx.unsafe<Row[]>(
      `SELECT * FROM data_manager.jobs WHERE execution_version=2 AND ${key}=$1${lock ? " FOR UPDATE" : ""}`,
      [value],
    );
    return rows[0] ? decode(rows[0]) : null;
  };
  const update = async (
    tx: postgres.TransactionSql,
    record: DataExecutionRecord,
    status: DataExecutionStatus,
    children: DataOpsChildAttempt[],
    terminalAt?: number,
  ) => {
    const { cancellationRequestedAt, progress, diagnostics, publication, result } = status;
    const finishedAt = isDataExecutionTerminal(status)
      ? (record.finishedAt ?? terminalAt ?? now())
      : null;
    const rows = await tx<
      Row[]
    >`UPDATE data_manager.jobs SET status=${status.status},ownership_version=ownership_version+1,
      execution_state=${canonicalJson({ cancellationRequestedAt, progress, diagnostics, publication, ...(result ? { result } : {}) })}::text::jsonb,
      execution_children=${canonicalJson(children)}::text::jsonb,finished_at=${finishedAt === null ? null : new Date(finishedAt).toISOString()}::text::timestamptz
      WHERE id=${status.id} AND ownership_version=${record.version} RETURNING *`;
    return rows[0] ? decode(rows[0]) : null;
  };
  function validateOwnedChild(record: DataExecutionRecord, child: DataOpsChildAttempt) {
    const template = record.reservations.find((slot) => slot.operationKey === child.operationKey);
    if (
      !template ||
      !sameDataChildBody(template, child) ||
      canonicalJson(child.parentExecution) !== canonicalJson(record.execution)
    )
      throw new DataExecutionConflict("Child is absent from original owned reservations");
    if (
      child.state !== "reserved" &&
      (child.execution.deadlineAt > record.status.deadlineAt ||
        child.execution.fingerprint !==
          executionFingerprint({
            kind: child.operation.kind,
            operationFingerprint: child.operationFingerprint,
            deadlineAt: child.requestedDeadlineAt,
            parent: retainedControlParent(record.execution),
          }))
    )
      throw new DataExecutionConflict("Invalid retained child execution identity");
  }
  async function writeChild(
    tx: postgres.TransactionSql,
    record: DataExecutionRecord,
    child: DataOpsChildAttempt,
    claim: boolean,
  ) {
    validateOwnedChild(record, child);
    const at = record.children.findIndex((entry) => entry.operationKey === child.operationKey),
      previous = record.children[at];
    if (!previous)
      throw new DataExecutionConflict("A fresh reserved CAS is required before binding");
    if (canonicalJson(previous) === canonicalJson(child)) return record;
    if (isDataExecutionTerminal(record.status))
      throw new DataExecutionConflict("Terminal execution cannot change children");
    const transitions: Record<
      DataOpsChildAttempt["state"],
      readonly DataOpsChildAttempt["state"][]
    > = {
      reserved: ["reserved", "bound"],
      bound: ["bound", "attempted"],
      attempted: ["attempted", "observing", "terminal", "unknown"],
      observing: ["observing", "terminal", "unknown"],
      unknown: ["unknown", "observing", "terminal"],
      terminal: ["terminal"],
    };
    if (
      !transitions[previous.state].includes(child.state) ||
      !sameDataChildBody(previous, child) ||
      canonicalJson(previous.proxyRecovery ?? null) !==
        canonicalJson(child.proxyRecovery ?? null) ||
      previous.state === "terminal" ||
      (previous.cancellationRequestedAt &&
        previous.cancellationRequestedAt !== child.cancellationRequestedAt)
    )
      throw new DataExecutionConflict("Retained child identity/state conflict");
    if (previous.state !== "reserved") {
      if (
        child.state === "reserved" ||
        canonicalJson(previous.execution) !== canonicalJson(child.execution) ||
        previous.requestedDeadlineAt !== child.requestedDeadlineAt ||
        previous.bindingDigest !== child.bindingDigest ||
        previous.candidateDigest !== child.candidateDigest
      )
        throw new DataExecutionConflict("Bound child identity is immutable");
    }
    if ("delegationId" in previous) {
      if (
        !("delegationId" in child) ||
        previous.delegationId !== child.delegationId ||
        previous.grantDigest !== child.grantDigest ||
        previous.leaseId !== child.leaseId ||
        (previous.dispatchState === "claimed" && child.dispatchState !== "claimed")
      )
        throw new DataExecutionConflict("Attempted child grant is immutable");
    }
    if (
      "acceptedId" in previous &&
      previous.acceptedId !== undefined &&
      (!("acceptedId" in child) || previous.acceptedId !== child.acceptedId)
    )
      throw new DataExecutionConflict("Accepted child identity is immutable");
    const claiming =
      "dispatchState" in child &&
      child.dispatchState === "claimed" &&
      (!("dispatchState" in previous) || previous.dispatchState !== "claimed");
    if (claiming && !claim)
      throw new DataExecutionConflict("A live confirmed reservation is required to claim dispatch");
    const children = [...record.children];
    children[at] = child;
    return update(tx, record, record.status, validateChildren(children));
  }
  return {
    controlJournal: options.controlJournal,
    async admit(value, admission) {
      const input = normalizeDataExecutionInput(value),
        operationFingerprint = dataExecutionInputFingerprint(input);
      const legacyKey = admission.legacyTransitKey
        ? z.string().max(200).parse(admission.legacyTransitKey)
        : undefined;
      if (legacyKey && (input.kind !== "transit-sync" || admission.parent))
        throw new DataExecutionConflict(
          "Legacy transit key is bound only to local transit admission",
        );
      const matchLegacy = (row: Row) => {
        if (row.execution_version !== 2) throw new LegacyTransitDuplicate(row.id);
        const record = decode(row);
        if (
          record.input.kind !== "transit-sync" ||
          record.operationFingerprint !== operationFingerprint ||
          record.triggeredBy !== (admission.triggeredBy ?? null)
        )
          throw new DataExecutionConflict("Legacy transit key body or actor conflict");
        return { created: false, record };
      };
      if (legacyKey) {
        const original = await findLegacyTransit(sql, legacyKey);
        if (original) return matchLegacy(original);
      }
      // Known duplicates are observations and remain available while fenced or expired.
      const existing = await find(sql, "operation_key", admission.operationKey);
      const match = (record: DataExecutionRecord) => {
        const normalized = normalizeExecutionAdmission({
          kind: input.kind,
          operationKey: admission.operationKey,
          operationFingerprint,
          admittedAt: record.status.admittedAt,
          requestedDeadlineAt: admission.requestedDeadlineAt,
          parent: admission.parent,
        });
        if (
          record.operationFingerprint !== operationFingerprint ||
          record.status.fingerprint !== normalized.fingerprint ||
          canonicalJson(record.parent) !== canonicalJson(admission.parent ?? null) ||
          record.execution.principal !== (admission.principal ?? "data-manager") ||
          (admission.id !== undefined && admission.id !== record.status.id) ||
          (admission.triggeredBy !== undefined && record.triggeredBy !== admission.triggeredBy)
        )
          throw new DataExecutionConflict("Data execution identity conflict");
        return { created: false, record };
      };
      if (existing) return match(existing);
      if (!admission.parent) {
        const root = parseControlRootOperationKey(admission.operationKey),
          wall = now();
        if (
          root.notAfter !== admission.requestedDeadlineAt ||
          root.notAfter <= wall ||
          root.notAfter - wall > 7 * 24 * 3600000
        )
          throw new DataExecutionConflict("A fresh dated data execution root is required");
      }
      return withDataAdmissionTransaction(sql, async (tx) => {
        if (legacyKey) {
          const original = await findLegacyTransit(tx, legacyKey);
          if (original) return matchLegacy(original);
        }
        await options.configurationFence?.assertAdmission(tx);
        const retained = await find(tx, "operation_key", admission.operationKey);
        if (retained) return match(retained);
        if (options.controlJournal) {
          const active =
            await tx`SELECT id FROM data_manager.jobs WHERE execution_version=2 AND finished_at IS NULL LIMIT 1`;
          if (active.length) throw new DataConfigurationMaintenanceBusy();
        }
        if (admission.sourceJobId) {
          const source =
            await tx`SELECT id FROM data_manager.jobs WHERE id=${admission.sourceJobId} AND kind LIKE 'transit-source-%' AND status='running' AND finished_at IS NULL FOR UPDATE`;
          if (source.length !== 1)
            throw new DataExecutionConflict("Original source reservation is not current");
        }
        const normalized = normalizeExecutionAdmission({
          kind: input.kind,
          operationKey: admission.operationKey,
          operationFingerprint,
          admittedAt: now(),
          requestedDeadlineAt: admission.requestedDeadlineAt,
          parent: admission.parent,
        });
        const status = dataExecutionStatusSchema.parse({
          id: admission.id ?? randomUUID(),
          operationKey: admission.operationKey,
          ...normalized,
          kind: input.kind,
          status: "queued",
          cancellationRequestedAt: null,
          progress: null,
          diagnostics: { tail: [], truncated: false },
          publication: "not_started",
        });
        const execution = executionRefSchema.parse({
          executor: "data-manager",
          principal: admission.principal ?? "data-manager",
          executionId: status.id,
          operationKey: status.operationKey,
          operationFingerprint,
          fingerprint: status.fingerprint,
          deadlineAt: status.deadlineAt,
        });
        const childReservations = reserveTransitChildOperations(execution, input);
        const rows = await tx<
          Row[]
        >`INSERT INTO data_manager.jobs(id,kind,status,triggered_by,idempotency_key,started_at,execution_version,operation_key,operation_fingerprint,
          execution_fingerprint,admitted_at,deadline_at,requested_deadline_at,execution_parent,execution_input,execution_state,metadata)
          VALUES(${status.id},${input.kind},'queued',${admission.triggeredBy ?? null},${legacyKey ?? null},${new Date(status.admittedAt).toISOString()}::text::timestamptz,2,${status.operationKey},${operationFingerprint},
          ${status.fingerprint},${status.admittedAt},${status.deadlineAt},${admission.requestedDeadlineAt ?? null},
          ${admission.parent ? canonicalJson(admission.parent) : null}::text::jsonb,${canonicalJson(input)}::text::jsonb,${canonicalJson({ cancellationRequestedAt: null, progress: null, diagnostics: status.diagnostics, publication: status.publication })}::text::jsonb,${canonicalJson({ dataExecution: { version: 1, execution, childReservations } })}::text::jsonb) RETURNING *`;
        if (!rows[0]) throw Error("Execution admission did not return its durable row");
        if (admission.sourceJobId)
          await tx`UPDATE data_manager.jobs SET metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{durableExecution}',${canonicalJson({ id: status.id, operationKey: status.operationKey, fingerprint: status.fingerprint })}::text::jsonb),ownership_version=ownership_version+1 WHERE id=${admission.sourceJobId}`;
        return { created: true, record: decode(rows[0]) };
      }).catch(async (error) => {
        if (legacyKey && error instanceof DataConfigurationMaintenanceBusy) {
          // The competing admission may still be committing its mapping. Only
          // read the winner; never repeat a transaction or start another root.
          for (let n = 0; n < 10; n++) {
            const original = await findLegacyTransit(sql, legacyKey);
            if (original) return matchLegacy(original);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        throw error;
      });
    },
    inspect: (id) => find(sql, "id", id),
    lookup: (key) => find(sql, "operation_key", key),
    async checkpoint(id, version, value) {
      const patch = validateDataExecutionPatch(value);
      return sql.begin(async (tx) => {
        const record = await find(tx, "id", id, true);
        if (!record || record.version !== version) return null;
        const status = dataExecutionStatusSchema.parse({ ...record.status, ...patch });
        if (
          options.controlJournal &&
          !isDataExecutionTerminal(record.status) &&
          isDataExecutionTerminal(status)
        )
          throw new DataExecutionConflict("Actual contained worker terminal commitment required");
        if (
          isDataExecutionTerminal(status) &&
          record.children.some((child) => child.state !== "terminal")
        )
          throw new DataExecutionConflict("Unsettled children retain the execution fence");
        if (
          isDataExecutionTerminal(record.status) &&
          canonicalJson(status) !== canonicalJson(record.status)
        )
          throw new DataExecutionConflict("Terminal execution cannot change");
        if (record.status.cancellationRequestedAt && ["queued", "running"].includes(status.status))
          throw new DataExecutionConflict("Cancellation is irreversible");
        if (record.status.publication === "committed" && status.publication === "not_started")
          throw new DataExecutionConflict("Committed publication cannot change");
        if (canonicalJson(status) === canonicalJson(record.status)) return record;
        return update(tx, record, status, record.children);
      });
    },
    async checkpointChild(id, version, value) {
      const child = dataOpsChildAttemptSchema.parse(value);
      return sql.begin(async (tx) => {
        const record = await find(tx, "id", id, true);
        if (!record || record.version !== version) return null;
        return writeChild(tx, record, child, false);
      });
    },
    async reserveChild(id, version, value) {
      const child = dataOpsChildAttemptSchema.parse(value);
      if (child.state !== "reserved") throw new DataExecutionConflict("Reserved body required");
      const saved = await sql.begin(async (tx) => {
        const record = await find(tx, "id", id, true);
        if (!record) return null;
        const existing = record.children.find((entry) => entry.operationKey === child.operationKey);
        if (existing) {
          if (
            !sameDataChildBody(existing, child) ||
            canonicalJson(existing.proxyRecovery ?? null) !==
              canonicalJson(child.proxyRecovery ?? null)
          )
            throw new DataExecutionConflict("Reserved child identity conflict");
          return { record, created: false };
        }
        if (record.version !== version) return null;
        if (record.status.cancellationRequestedAt || isDataExecutionTerminal(record.status))
          throw new DataExecutionConflict("Canceled execution cannot reserve a phase");
        validateOwnedChild(record, child);
        const updated = await update(
          tx,
          record,
          record.status,
          validateChildren([...record.children, child]),
        );
        return updated ? { record: updated, created: true } : null;
      });
      if (!saved) return null;
      if (!saved.created) return { record: saved.record, continuation: null };
      const continuation = Object.freeze({ [reservationBrand]: true as const });
      reservationContinuations.set(continuation, {
        store: storeIdentity,
        id,
        key: child.operationKey,
        used: false,
      });
      return { record: saved.record, continuation };
    },
    async claimChildDispatch(id, version, value, continuation) {
      const permission = reservationContinuations.get(continuation);
      if (
        !permission ||
        permission.used ||
        permission.store !== storeIdentity ||
        permission.id !== id ||
        permission.key !== value.operationKey
      )
        throw new DataExecutionConflict("Missing live reservation continuation");
      permission.used = true;
      const child = dataOpsChildAttemptSchema.parse(value);
      if (child.state !== "attempted" || child.dispatchState !== "claimed")
        throw new DataExecutionConflict("Dispatch claim must retain its real attempted grant");
      return sql.begin(async (tx) => {
        const record = await find(tx, "id", id, true);
        if (!record || record.version !== version) return null;
        if (record.status.cancellationRequestedAt || isDataExecutionTerminal(record.status))
          throw new DataExecutionConflict("Cancellation prevents a fresh dispatch claim");
        return writeChild(tx, record, child, true);
      });
    },
    async requestCancel(identity) {
      return sql.begin(async (tx) => {
        const record = await find(tx, "id", identity.id, true);
        if (!record) return null;
        if (
          record.status.operationKey !== identity.operationKey ||
          record.status.fingerprint !== identity.fingerprint
        )
          throw new DataExecutionConflict("Cancellation identity conflict");
        if (isDataExecutionTerminal(record.status) || record.status.cancellationRequestedAt)
          return record;
        return update(
          tx,
          record,
          {
            ...record.status,
            status: "cancel_pending",
            cancellationRequestedAt: new Date(now()).toISOString(),
          },
          record.children,
        );
      });
    },
    async listUnsettled() {
      const rows = await sql<
        Row[]
      >`SELECT * FROM data_manager.jobs WHERE execution_version=2 ORDER BY admitted_at,id`;
      return rows.map(decode);
    },
    async finalize(id, version, patch, completion) {
      if (!options.controlJournal) throw Error("Durable data journal is unavailable");
      const record = await find(sql, "id", id);
      if (!record || record.version !== version) return null;
      const status = dataExecutionStatusSchema.parse({
        ...record.status,
        ...validateDataExecutionPatch(patch),
      });
      const terminalAt = await options.controlJournal.prepareTerminal(completion, status, now());
      const result = await sql.begin(async (tx) => {
        const current = await find(tx, "id", id, true);
        if (!current || current.version !== version) return null;
        return update(tx, current, status, current.children, terminalAt);
      });
      if (result) await options.controlJournal.publishTerminal(result.execution);
      return result;
    },
  };
}
