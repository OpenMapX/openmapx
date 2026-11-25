import { createHash } from "node:crypto";
import {
  assertExecutionRowCapacity,
  type ContainedDataExecution,
  type ControlAdmissionInput,
  type ControlTransportPrincipal,
  type DataExecutionControlJournal,
  dataChildRecord,
  dataExecutionChildren,
  executionProgressSchema,
  retainedDataDatabaseTimestamp,
  type SenderLease,
} from "@openmapx/core/build-artifacts";
import {
  type DataExecutionIdentity,
  type DataExecutionInput,
  type DataExecutionStatus,
  dataExecutionStatusSchema,
  isDataExecutionTerminal,
  normalizeDataExecutionInput,
  SHORT_DATA_EXECUTION_KINDS,
} from "@openmapx/core/data-manager-contracts";
import { DATA_ADVISORY_LOCKS } from "@openmapx/core/data-manager-sdk";
import { uuidv7 } from "@openmapx/core/ids/uuidv7";
import { DATA_JOB_TRIGGERS, type DataJobTrigger } from "@openmapx/core/jobs";
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
  type DataAgentOperation,
  dataAgentOperationSchema,
  reserveAgentOperations,
} from "./agent-operations.js";
import {
  type DataOpsChildAttempt,
  type DataOpsChildReserved,
  dataChildControlReservation,
  dataOpsChildAttemptSchema,
  dataOpsChildReservedSchema,
  reserveTransitChildOperations,
  sameDataChildBody,
} from "./ops-children.js";

const reservationBrand = Symbol("data-child-reservation");
/** Handed out only by the reservation that took a phase up: its holder may bind and send it. */
export type FreshDataChildReservation = Readonly<{ [reservationBrand]: true }>;

import type { DataConfigurationMaintenance } from "./configuration-maintenance.js";
export const DATA_ADMISSION_LOCK = DATA_ADVISORY_LOCKS.dataAdmission;
export class DataExecutionConflict extends Error {
  readonly statusCode = 409;
}
export class DataConfigurationMaintenanceBusy extends Error {
  readonly statusCode = 409;
  constructor() {
    super("configuration_maintenance_busy");
  }
}
export interface DataExecutionRecord {
  trigger: DataJobTrigger;
  triggeredByUserId: string | null;
  execution: ExecutionRef;
  status: DataExecutionStatus;
  input: DataExecutionInput;
  operationFingerprint: string;
  requestedDeadlineAt: number | null;
  parent: RetainedParentExecution | null;
  version: number;
  children: DataOpsChildAttempt[];
  reservations: DataOpsChildReserved[];
  agentOperations: DataAgentOperation[];
  finishedAt: number | null;
}
export interface DataExecutionAdmissionOptions {
  /** Who sent a hardlink application under its own lease, and what the agent
   * showed of that lease. */
  linkSender?: { caller: ControlTransportPrincipal; lease: SenderLease };
  operationKey: string;
  requestedDeadlineAt?: number;
  parent?: VerifiedParentExecution;
  id?: string;
  principal?: ExecutionRef["principal"];
  /** What started the job, and the administrator the API started it for. */
  trigger: DataJobTrigger;
  triggeredByUserId?: string;
  idempotencyKey?: string;
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
/** The services an execution leases: data-manager itself, and for transit work
 * the primary MOTIS, its staging slot and the feed proxy. */
export function dataExecutionTargetIds(input: DataExecutionInput): string[] {
  return ["transit-sync", "catalog.validate", "catalog.activate"].includes(input.kind)
    ? ["data-manager", "motis", "motis-feed-proxy", "motis-staging"]
    : input.kind === "transit-maintenance"
      ? input.action === "restart-primary"
        ? ["data-manager", "motis"]
        : ["data-manager", "motis-feed-proxy"]
      : ["data-manager"];
}
/** What the control kernel records about a data execution when it is admitted. */
export function dataControlAdmission(value: {
  execution: ExecutionRef;
  input: DataExecutionInput;
  admittedAt: number;
  requestedDeadlineAt: number | null | undefined;
  parent: RetainedParentExecution | undefined;
  reservations: readonly (DataOpsChildReserved | DataOpsChildAttempt)[];
}): ControlAdmissionInput {
  return {
    execution: value.execution,
    kind: value.input.kind,
    operation: value.input,
    admittedAt: value.admittedAt,
    ...(value.requestedDeadlineAt != null
      ? { requestedDeadlineAt: value.requestedDeadlineAt }
      : {}),
    ...(value.parent ? { parent: value.parent } : {}),
    serviceIds: dataExecutionTargetIds(value.input),
    reservations: value.reservations.map(dataChildControlReservation),
  };
}
export interface DataExecutionStore {
  /** Absent only when the control installation could not be opened; nothing is admitted then. */
  readonly controlJournal?: DataExecutionControlJournal;
  admit(
    input: DataExecutionInput,
    options: DataExecutionAdmissionOptions,
  ): Promise<{ created: boolean; record: DataExecutionRecord }>;
  inspect(id: string): Promise<DataExecutionRecord | null>;
  lookup(operationKey: string): Promise<DataExecutionRecord | null>;
  lookupByIdempotencyKey?(key: string): Promise<DataExecutionRecord | null>;
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
  checkpointAgentOperation(
    id: string,
    expectedVersion: number,
    entry: DataAgentOperation,
  ): Promise<DataExecutionRecord | null>;
  reserveChild(
    id: string,
    expectedVersion: number,
    child: DataOpsChildReserved,
  ): Promise<{
    record: DataExecutionRecord;
    continuation: FreshDataChildReservation | null;
  } | null>;
  requestCancel(identity: DataExecutionIdentity): Promise<DataExecutionRecord | null>;
  /** Records that a finished job released what it held. */
  recordReleased(id: string): Promise<void>;
  /**
   * The rows startup recovery looks at: every unfinished job, and every
   * finished one whose execution row is kept and that has not released what it
   * held. A job a backup restore closed has no execution row and is left to
   * the prune.
   */
  listUnsettled(): Promise<DataExecutionRecord[]>;
  finalize(
    id: string,
    expectedVersion: number,
    patch: DataExecutionPatch,
    completion: ContainedDataExecution,
  ): Promise<DataExecutionRecord | null>;
}
interface Row extends Record<string, unknown> {
  trigger: string;
  triggered_by_user_id: string | null;
  id: string;
  kind: string;
  status: string;
  operation_key: string;
  operation_fingerprint: string;
  execution_fingerprint: string;
  admitted_at: Date | string;
  deadline_at: Date | string;
  requested_deadline_at: Date | string | null;
  execution_parent: unknown;
  execution_input: unknown;
  execution_state: unknown;
  execution_ref: unknown;
  execution_progress: unknown;
  execution_agent_operations: unknown;
  ownership_version: number;
  finished_at: Date | string | null;
}
/** A stored instant as epoch milliseconds, the form the execution contracts carry. */
function epochOf(value: unknown): number {
  return retainedDataDatabaseTimestamp(value).getTime();
}
/** Epoch milliseconds as the text form a `timestamptz` parameter is cast from. */
function instant(epoch: number): string;
function instant(epoch: number | null | undefined): string | null;
function instant(epoch: number | null | undefined): string | null {
  return epoch == null ? null : new Date(epoch).toISOString();
}
const executionRefColumnSchema = z.strictObject({
  execution: executionRefSchema,
  childReservations: z.array(dataOpsChildReservedSchema).max(32),
});
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
    admittedAt: epochOf(row.admitted_at),
    deadlineAt: epochOf(row.deadline_at),
    ...mutable,
  });
  if (dataExecutionInputFingerprint(input) !== row.operation_fingerprint || row.kind !== input.kind)
    throw Error("Stored execution body mismatch");
  const { execution, childReservations } = executionRefColumnSchema.parse(row.execution_ref);
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
  const reservations = childReservations.map((value) => {
    const parsed = dataOpsChildAttemptSchema.parse(value);
    if (parsed.state !== "reserved") throw Error("Invalid reserved body");
    return parsed;
  });
  return {
    trigger: z.enum(DATA_JOB_TRIGGERS).parse(row.trigger),
    triggeredByUserId: z
      .string()
      .nullable()
      .parse(row.triggered_by_user_id ?? null),
    execution,
    status,
    input,
    operationFingerprint: row.operation_fingerprint,
    requestedDeadlineAt:
      row.requested_deadline_at === null ? null : epochOf(row.requested_deadline_at),
    parent,
    version: z.number().int().nonnegative().safe().parse(row.ownership_version),
    children: childrenOf(reservations, row.execution_progress),
    reservations,
    agentOperations: z.array(dataAgentOperationSchema).max(8).parse(row.execution_agent_operations),
    finishedAt:
      row.finished_at === null ? null : retainedDataDatabaseTimestamp(row.finished_at).getTime(),
  };
}
/** The children an execution row records: the cells of its progress that data-manager took up. */
function childrenOf(
  reservations: readonly DataOpsChildReserved[],
  progress: unknown,
): DataOpsChildAttempt[] {
  return dataExecutionChildren(
    reservations,
    progress === null ? null : executionProgressSchema.parse(progress),
  ).map((child) => dataOpsChildAttemptSchema.parse(child));
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
      await tx`SELECT maintenance_id FROM data_manager.configuration_fence WHERE status='prepared' LIMIT 1`;
    if (guard.length) throw new DataConfigurationMaintenanceBusy();
    return { value: await run(tx) };
  });
  return result.value;
}
export function createPostgresDataExecutionStore(
  sql: postgres.Sql,
  options: {
    now?: () => number;
    controlJournal: DataExecutionControlJournal | undefined;
    configurationFence?: DataConfigurationMaintenance;
  },
): DataExecutionStore {
  const now = options.now ?? Date.now;
  const findByIdempotencyKey = async (tx: postgres.Sql | postgres.TransactionSql, key: string) => {
    const rows = await tx.unsafe<Row[]>(
      "SELECT * FROM data_manager.job WHERE idempotency_key=$1 AND (admitted_at >= $2::text::timestamptz OR finished_at IS NULL) ORDER BY admitted_at DESC,id LIMIT 1",
      [key, instant(now() - 24 * 3600000)],
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
      `SELECT * FROM data_manager.job WHERE ${key}=$1${lock ? " FOR UPDATE" : ""}`,
      [value],
    );
    return rows[0] ? decode(rows[0]) : null;
  };
  const update = async (
    tx: postgres.TransactionSql,
    record: DataExecutionRecord,
    change: {
      status?: DataExecutionStatus;
      agentOperations?: DataAgentOperation[];
      terminalAt?: number;
    },
  ) => {
    const { status = record.status, agentOperations = record.agentOperations, terminalAt } = change;
    if (
      isDataExecutionTerminal(status) &&
      agentOperations.some((entry) => entry.state === "attempted")
    )
      throw new DataExecutionConflict("An attempted agent operation retains the execution");
    if (isDataExecutionTerminal(status) && record.children.some((c) => c.state !== "terminal"))
      throw new DataExecutionConflict("Unsettled children retain the execution fence");
    const { cancellationRequestedAt, progress, diagnostics, publication, result } = status;
    const finishedAt = isDataExecutionTerminal(status)
      ? (record.finishedAt ?? terminalAt ?? now())
      : null;
    const rows = await tx<
      Row[]
    >`UPDATE data_manager.job SET status=${status.status},ownership_version=ownership_version+1,
      execution_state=${canonicalJson({ cancellationRequestedAt, progress, diagnostics, publication, ...(result ? { result } : {}) })}::text::jsonb,
      execution_agent_operations=${canonicalJson(agentOperations)}::text::jsonb,finished_at=${finishedAt === null ? null : new Date(finishedAt).toISOString()}::text::timestamptz
      WHERE id=${status.id} AND ownership_version=${record.version} RETURNING *`;
    return rows[0] ? decode(rows[0]) : null;
  };
  /**
   * Records data-manager's own part of `child` on its cell; `record` was read
   * under the job row's lock in `tx`. The binding and grant are the control
   * kernel's, so the child must be exactly what the cell then composes.
   */
  async function writeCell(
    tx: postgres.TransactionSql,
    record: DataExecutionRecord,
    child: DataOpsChildAttempt,
  ) {
    const [row] = await tx<
      { execution_progress: unknown }[]
    >`SELECT execution_progress FROM data_manager.job WHERE id=${record.status.id}`;
    const progress = executionProgressSchema.parse(row?.execution_progress);
    const cell = progress.children.find((entry) => entry.ordinal === child.ordinal);
    if (!cell) throw new DataExecutionConflict("Child is absent from original owned reservations");
    cell.owner = dataChildRecord(child);
    const composed = childrenOf(record.reservations, progress).find(
      (entry) => entry.ordinal === child.ordinal,
    );
    if (canonicalJson(composed) !== canonicalJson(child))
      throw new DataExecutionConflict("Child differs from its original body, binding or grant");
    const serialized = canonicalJson(progress);
    assertExecutionRowCapacity(serialized);
    const rows = await tx<
      Row[]
    >`UPDATE data_manager.job SET ownership_version=ownership_version+1,execution_progress=${serialized}::text::jsonb
      WHERE id=${record.status.id} AND ownership_version=${record.version} RETURNING *`;
    return rows[0] ? decode(rows[0]) : null;
  }
  const order: readonly DataOpsChildAttempt["state"][] = [
    "reserved",
    "bound",
    "attempted",
    "observing",
    "terminal",
  ];
  async function writeChild(
    tx: postgres.TransactionSql,
    record: DataExecutionRecord,
    child: DataOpsChildAttempt,
  ) {
    const previous = record.children.find((entry) => entry.operationKey === child.operationKey);
    if (!previous)
      throw new DataExecutionConflict("A fresh reserved CAS is required before binding");
    if (canonicalJson(previous) === canonicalJson(child)) return record;
    if (isDataExecutionTerminal(record.status))
      throw new DataExecutionConflict("Terminal execution cannot change children");
    if (
      previous.state === "terminal" ||
      order.indexOf(child.state) < order.indexOf(previous.state) ||
      canonicalJson(previous.proxyRecovery ?? null) !==
        canonicalJson(child.proxyRecovery ?? null) ||
      (previous.cancellationRequestedAt &&
        previous.cancellationRequestedAt !== child.cancellationRequestedAt)
    )
      throw new DataExecutionConflict("Retained child identity/state conflict");
    return writeCell(tx, record, child);
  }
  /** Reserved → attempted (never after cancellation or a terminal) → terminal.
   * The attempted body never changes; only its cancellation time is added. */
  function nextAgentOperations(record: DataExecutionRecord, entry: DataAgentOperation) {
    const at = record.agentOperations.findIndex((op) => op.operationKey === entry.operationKey),
      previous = record.agentOperations[at];
    if (!previous || previous.kind !== entry.kind)
      throw new DataExecutionConflict("Agent operation is absent from the original reservations");
    if (canonicalJson(previous) === canonicalJson(entry)) return null;
    const body = (op: DataAgentOperation) =>
      op.state === "reserved"
        ? null
        : canonicalJson({
            operation: op.operation,
            fingerprint: op.fingerprint,
            admittedAt: op.admittedAt,
            deadlineAt: op.deadlineAt,
          });
    const allowed =
      previous.state === "reserved"
        ? entry.state === "attempted" &&
          entry.cancellationRequestedAt === null &&
          record.status.cancellationRequestedAt === null &&
          !isDataExecutionTerminal(record.status)
        : previous.state === "attempted" &&
          entry.state !== "reserved" &&
          body(previous) === body(entry) &&
          (previous.cancellationRequestedAt === null ||
            previous.cancellationRequestedAt === entry.cancellationRequestedAt);
    if (!allowed) throw new DataExecutionConflict("Agent operation state conflict");
    const next = [...record.agentOperations];
    next[at] = entry;
    return next;
  }
  return {
    controlJournal: options.controlJournal,
    async admit(value, admission) {
      const journal = options.controlJournal;
      if (!journal)
        throw Object.assign(Error("Durable control prerequisites are unavailable"), {
          statusCode: 503,
        });
      const input = normalizeDataExecutionInput(value),
        operationFingerprint = dataExecutionInputFingerprint(input);
      const idempotencyKey = admission.idempotencyKey
        ? z.string().max(200).parse(admission.idempotencyKey)
        : undefined;
      if (idempotencyKey && (input.kind !== "transit-sync" || admission.parent))
        throw new DataExecutionConflict("Idempotency key is bound only to local transit admission");
      const matchIdempotent = (row: Row) => {
        const record = decode(row);
        if (
          record.input.kind !== "transit-sync" ||
          record.operationFingerprint !== operationFingerprint ||
          record.trigger !== admission.trigger ||
          record.triggeredByUserId !== (admission.triggeredByUserId ?? null)
        )
          throw new DataExecutionConflict("Idempotency key body or actor conflict");
        return { created: false, record };
      };
      if (idempotencyKey) {
        const original = await findByIdempotencyKey(sql, idempotencyKey);
        if (original) return matchIdempotent(original);
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
          (admission.triggeredByUserId !== undefined &&
            record.triggeredByUserId !== admission.triggeredByUserId)
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
      const short = SHORT_DATA_EXECUTION_KINDS.includes(input.kind);
      const admitTransaction = async <T>(
        run: (tx: postgres.TransactionSql) => Promise<T>,
      ): Promise<T> => {
        // A short traffic run only needs configuration maintenance kept out,
        // so it shares the lock that maintenance takes exclusively.
        if (short)
          return sql
            .begin(async (tx) => {
              const lock =
                await tx`SELECT pg_try_advisory_xact_lock_shared(${DATA_ADMISSION_LOCK[0]},${DATA_ADMISSION_LOCK[1]}) AS held`;
              if (lock[0]?.held !== true) throw new DataConfigurationMaintenanceBusy();
              await options.configurationFence?.assertAdmission(tx);
              return { value: await run(tx) };
            })
            .then((result) => result.value);
        if (!(input.kind === "generation-link" && input.leaseId))
          return withDataAdmissionTransaction(sql, run);
        // A hardlink application under its sender's lease: admitted beside a
        // prepared fence only for that fence's own maintenance.
        const fence = options.configurationFence,
          sender = admission.linkSender,
          leaseId = input.leaseId;
        if (!fence || !sender) throw new DataConfigurationMaintenanceBusy();
        const result = await sql.begin(async (tx) => {
          const held =
            await tx`SELECT pg_try_advisory_xact_lock(${DATA_ADMISSION_LOCK[0]},${DATA_ADMISSION_LOCK[1]}) AS held`;
          if (held[0]?.held !== true) throw new DataConfigurationMaintenanceBusy();
          await fence.assertLinkAdmission(
            tx,
            { revisionId: input.revisionId, planDigest: input.planDigest, leaseId },
            sender,
          );
          return { value: await run(tx) };
        });
        return result.value;
      };
      const borrowsLease = input.kind === "generation-link" && input.leaseId !== null;
      return admitTransaction(async (tx) => {
        if (idempotencyKey) {
          const original = await findByIdempotencyKey(tx, idempotencyKey);
          if (original) return matchIdempotent(original);
        }
        if (!borrowsLease && !short) await options.configurationFence?.assertAdmission(tx);
        const retained = await find(tx, "operation_key", admission.operationKey);
        if (retained) return match(retained);
        // One exclusive execution at a time; short traffic runs neither count
        // nor wait.
        if (!short) {
          const active =
            await tx`SELECT id FROM data_manager.job WHERE finished_at IS NULL AND kind <> ALL(${[...SHORT_DATA_EXECUTION_KINDS]}) LIMIT 1`;
          if (active.length) throw new DataConfigurationMaintenanceBusy();
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
          id: admission.id ?? uuidv7(),
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
        const childReservations = reserveTransitChildOperations(execution, input),
          agentOperations = reserveAgentOperations(input, status.deadlineAt);
        // The execution row goes in with the job row: no job row exists without one.
        const row = journal.newExecutionRow(
          dataControlAdmission({
            execution,
            input,
            admittedAt: status.admittedAt,
            requestedDeadlineAt: admission.requestedDeadlineAt,
            parent: admission.parent,
            reservations: childReservations,
          }),
        );
        const rows = await tx<
          Row[]
        >`INSERT INTO data_manager.job(id,kind,status,trigger,triggered_by_user_id,idempotency_key,operation_key,operation_fingerprint,
          execution_fingerprint,admitted_at,deadline_at,requested_deadline_at,execution_parent,execution_input,execution_state,execution_ref,execution_agent_operations,
          execution_admission,execution_progress)
          VALUES(${status.id},${input.kind},'queued',${admission.trigger},${admission.triggeredByUserId ?? null},${idempotencyKey ?? null},${status.operationKey},${operationFingerprint},
          ${status.fingerprint},${instant(status.admittedAt)}::text::timestamptz,${instant(status.deadlineAt)}::text::timestamptz,${instant(admission.requestedDeadlineAt)}::text::timestamptz,
          ${admission.parent ? canonicalJson(admission.parent) : null}::text::jsonb,${canonicalJson(input)}::text::jsonb,${canonicalJson({ cancellationRequestedAt: null, progress: null, diagnostics: status.diagnostics, publication: status.publication })}::text::jsonb,${canonicalJson({ execution, childReservations })}::text::jsonb,${canonicalJson(agentOperations)}::text::jsonb,
          ${row.admission}::text::jsonb,${row.progress}::text::jsonb) RETURNING *`;
        if (!rows[0]) throw Error("Execution admission did not return its durable row");
        return { created: true, record: decode(rows[0]) };
      }).catch(async (error) => {
        if (idempotencyKey && error instanceof DataConfigurationMaintenanceBusy) {
          // The competing admission may still be committing its mapping. Only
          // read the winner; never repeat a transaction or start another root.
          for (let n = 0; n < 10; n++) {
            const original = await findByIdempotencyKey(sql, idempotencyKey);
            if (original) return matchIdempotent(original);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        throw error;
      });
    },
    async lookupByIdempotencyKey(key) {
      const row = await findByIdempotencyKey(sql, z.string().max(200).parse(key));
      return row ? decode(row) : null;
    },
    inspect: (id) => find(sql, "id", id),
    lookup: (key) => find(sql, "operation_key", key),
    async checkpoint(id, version, value) {
      const patch = validateDataExecutionPatch(value);
      return sql.begin(async (tx) => {
        const record = await find(tx, "id", id, true);
        if (!record || record.version !== version) return null;
        const status = dataExecutionStatusSchema.parse({ ...record.status, ...patch });
        if (!isDataExecutionTerminal(record.status) && isDataExecutionTerminal(status))
          throw new DataExecutionConflict("Actual contained worker terminal commitment required");
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
        return update(tx, record, { status });
      });
    },
    async checkpointChild(id, version, value) {
      const child = dataOpsChildAttemptSchema.parse(value);
      return sql.begin(async (tx) => {
        const record = await find(tx, "id", id, true);
        if (!record || record.version !== version) return null;
        return writeChild(tx, record, child);
      });
    },
    async checkpointAgentOperation(id, version, value) {
      const entry = dataAgentOperationSchema.parse(value);
      return sql.begin(async (tx) => {
        const record = await find(tx, "id", id, true);
        if (!record || record.version !== version) return null;
        const agentOperations = nextAgentOperations(record, entry);
        return agentOperations ? update(tx, record, { agentOperations }) : record;
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
        const updated = await writeCell(tx, record, child);
        return updated ? { record: updated, created: true } : null;
      });
      if (!saved) return null;
      if (!saved.created) return { record: saved.record, continuation: null };
      return {
        record: saved.record,
        continuation: Object.freeze({ [reservationBrand]: true as const }),
      };
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
        return update(tx, record, {
          status: {
            ...record.status,
            status: "cancel_pending",
            cancellationRequestedAt: new Date(now()).toISOString(),
          },
        });
      });
    },
    async recordReleased(id) {
      // On a row without its execution row `released_at` records that the
      // control prune swept the files named by its key; only that prune sets it.
      await sql`UPDATE data_manager.job SET released_at=now()
        WHERE id=${id} AND finished_at IS NOT NULL AND execution_admission IS NOT NULL AND released_at IS NULL`;
    },
    async listUnsettled() {
      const rows = await sql<Row[]>`SELECT * FROM data_manager.job
        WHERE (finished_at IS NULL OR (execution_admission IS NOT NULL AND released_at IS NULL))
        ORDER BY admitted_at,id`;
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
      if (record.agentOperations.some((entry) => entry.state === "attempted"))
        throw new DataExecutionConflict("An attempted agent operation retains the execution");
      const terminalAt = await options.controlJournal.prepareTerminal(completion, status, now());
      return sql.begin(async (tx) => {
        const current = await find(tx, "id", id, true);
        if (!current || current.version !== version) return null;
        return update(tx, current, { status, terminalAt });
      });
    },
  };
}
