/** Fixed data-manager database/worker journal. No public row or callback boolean
 * can mint a completion or repair an absent original terminal commitment. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import {
  pairedPinApprovalInputSchema,
  pairedPinApprovalResultSchema,
} from "../ops/catalog-pin-approval";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import {
  type DataExecutionResult,
  type DataExecutionStatus,
  dataExecutionInputSchema,
  dataExecutionResultSchema,
  dataExecutionStatusSchema,
  generationHardlinksPlanSchema,
  isDataExecutionTerminal,
  LOCAL_DATA_EXECUTION_KINDS,
  SHORT_DATA_EXECUTION_KINDS,
} from "../services/data-manager/contracts/executions";
import {
  transitousRunnerRequestSchema,
  transitousRunnerResultSchema,
} from "../transitous-runner/contract";
import {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  sameControlOrigin,
} from "./control-records";
import { retainedDataDatabaseTimestamp } from "./data-database-time";
import { DataExecutionPartialResult } from "./data-execution-outcome";
import {
  beginControlEffect,
  cancelControlExecution,
  type ExecutionHandle,
  restoreAdmittedControlExecution,
  settleExecution,
  verifyControlEffectSettlement,
} from "./execution-record";
import { installationState, readPrivateRecord, writePrivateRecord } from "./private-records";
import {
  assertRetainedCatalogActivationChildrenSettled,
  inspectArtifactTargetLeaseChildSettlement,
  inspectRetainedOwnedArtifactTargetChildSettlement,
  restoreArtifactTargetLeaseForSettlement,
  type TargetLeaseAuthority,
} from "./target-lease";

export interface DataExecutionJournalDatabase {
  unsafe(
    query: string,
    parameters?: (string | number | null)[],
  ): Promise<readonly Record<string, unknown>[]>;
}
const completionBrand = Symbol("contained-data-worker");
export type ContainedDataExecution = Readonly<{ [completionBrand]: true }>;
const completions = new WeakMap<
  ContainedDataExecution,
  {
    authority: ExecutionHandle;
    workerId: string;
    publication: "not_started" | "committed" | "unknown";
    childrenDigest?: string;
    result?: DataExecutionResult;
    error?: unknown;
    partial?: boolean;
    lease?: TargetLeaseAuthority;
  }
>();
const workerSchema = z
  .strictObject({
    version: z.literal(1),
    origin: controlOriginSchema,
    execution: executionRefSchema,
    admissionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    workerId: z.uuid(),
    containedAt: z.number().int().positive().safe(),
    outcome: z.enum(["returned", "partial", "failed", "catalog-activation-committed"]),
    publication: z.enum(["not_started", "committed", "unknown"]),
    childrenDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    proxyRecovery: z.enum(["not_required", "settled", "pending"]).optional(),
    result: dataExecutionResultSchema.optional(),
  })
  .refine((value) => (value.outcome !== "failed") === (value.result !== undefined));
const runnerJournalSchema = z.strictObject({
  version: z.literal(1),
  execution: executionRefSchema,
  completed: z.number().int().nonnegative().safe(),
  completedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  attempts: z.array(transitousRunnerRequestSchema).max(32),
});
const terminalSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["prepared", "canonical"]),
  origin: controlOriginSchema,
  execution: executionRefSchema,
  admissionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  terminalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  terminalAt: z.number().int().positive().safe(),
  workerId: z.uuid(),
  childrenDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const rowSchema = z.object({
  id: z.uuid(),
  execution_version: z.literal(2),
  operation_key: z.string(),
  execution_fingerprint: z.string(),
  admitted_at: z.union([z.string(), z.number()]),
  deadline_at: z.union([z.string(), z.number()]),
  kind: z.string(),
  status: z.string(),
  execution_state: z.unknown(),
  execution_input: z.unknown(),
  execution_children: z.array(z.unknown()),
  finished_at: z
    .unknown()
    .transform((value) => (value === null ? null : retainedDataDatabaseTimestamp(value))),
  ownership_version: z.number().int(),
  metadata: z.unknown(),
});
const mutableSchema = z.strictObject({
  cancellationRequestedAt: z.string().nullable(),
  progress: z.number().nullable(),
  diagnostics: z.unknown(),
  publication: z.enum(["not_started", "committed", "unknown"]),
  result: z.unknown().optional(),
});
const childSchema = z
  .object({
    state: z.string(),
    execution: executionRefSchema.optional(),
    settlement: z
      .object({
        outcome: z.enum(["contained", "committed", "failed_without_effect"]),
        terminalReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
  })
  .passthrough();
export const dataTerminalReceiptDigest = (status: DataExecutionStatus) =>
  controlDigest({ version: 1, status: dataExecutionStatusSchema.parse(status) });
function statusOf(raw: unknown) {
  const row = rowSchema.parse(raw),
    state = mutableSchema.parse(row.execution_state);
  const status = dataExecutionStatusSchema.parse({
    id: row.id,
    operationKey: row.operation_key,
    fingerprint: row.execution_fingerprint,
    admittedAt: Number(row.admitted_at),
    deadlineAt: Number(row.deadline_at),
    kind: row.kind,
    status: row.status,
    ...state,
  });
  const execution = z
    .object({ dataExecution: z.object({ execution: executionRefSchema }) })
    .parse(row.metadata).dataExecution.execution;
  if (
    execution.executionId !== status.id ||
    execution.operationKey !== status.operationKey ||
    execution.fingerprint !== status.fingerprint ||
    execution.deadlineAt !== status.deadlineAt ||
    execution.executor !== "data-manager"
  )
    throw Error("Data journal identity conflict");
  return { row, status, execution };
}
/** Whether an execution holds a lease of its own in the agent's store. A
 * hardlink application sent with a lease id runs under its sender's lease, and
 * the short traffic kinds run under none. */
export function dataExecutionHoldsLease(input: { kind: string; leaseId?: unknown }): boolean {
  return (
    !SHORT_DATA_EXECUTION_KINDS.includes(input.kind) &&
    !(input.kind === "generation-link" && typeof input.leaseId === "string")
  );
}
export function createDataExecutionControlJournal(
  installation: ControlInstallation,
  database: DataExecutionJournalDatabase,
) {
  const local = installationState(installation);
  if (installation.role !== "data-manager" || local.fixedChildId)
    throw Error("Fixed data-manager journal required");
  async function load(execution: ExecutionRef) {
    const rows = await database.unsafe(
      "SELECT * FROM data_manager.jobs WHERE execution_version=2 AND operation_key=$1",
      [execution.operationKey],
    );
    if (rows.length !== 1) throw Error("Original data journal row required");
    const value = statusOf(rows[0]);
    if (controlDigest(value.execution) !== controlDigest(execution))
      throw Error("Original data journal execution changed");
    return value;
  }
  const recoverySchema = z.strictObject({
    version: z.literal(1),
    execution: executionRefSchema,
    admissionDigest: z.string(),
    origin: controlOriginSchema,
    restore: z.unknown(),
    backupDigest: z.string().regex(/^[a-f0-9]{64}$/),
  });
  function recoveryIntent(s: ExecutionHandle) {
    try {
      const proof = recoverySchema.parse(
        readPrivateRecord(
          local,
          "observations",
          `proxy-recovery-${s.execution.operationKey}.json`,
          8192,
        ),
      );
      if (
        proof.admissionDigest !== s.receiptDigest ||
        controlDigest(proof.execution) !== controlDigest(s.execution) ||
        !sameControlOrigin(proof.origin, s.origin)
      )
        throw Error("Original proxy recovery identity changed");
      return proof;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  /** One fixed policy over the current actual row, original retained plan and
   * authenticated shared child/canonical receipts. No status/result shortcut. */
  async function assertOwnedProxyRecoverySettled(
    execution: ExecutionRef,
  ): Promise<"not_required" | "settled"> {
    const value = await load(execution),
      authority = restoreAdmittedControlExecution(installation, execution),
      s = authority;
    const restore = s.reservations.find((slot) => slot.phase === "proxy-restore");
    const children = value.row.execution_children.map((raw) =>
      z
        .object({
          phase: z.string(),
          ordinal: z.number(),
          operationKey: z.string(),
          operationFingerprint: z.string(),
          serviceIds: z.array(z.string()),
          parentExecution: executionRefSchema,
          operation: z.unknown(),
          state: z.string(),
          execution: executionRefSchema.optional(),
          agentState: z.enum(["succeeded", "failed", "timed_out"]).optional(),
          result: z.unknown().optional(),
          proxyRecovery: z.object({ version: z.literal(1), backupDigest: z.string() }).optional(),
        })
        .passthrough()
        .parse(raw),
    );
    const intent = recoveryIntent(authority);
    let required = intent !== null || children.some((child) => child.phase === "proxy-restore");
    {
      for (const child of children.filter((child) =>
        ["proxy-stage", "proxy-commit", "proxy-restore"].includes(child.phase),
      )) {
        const slot = s.reservations.find(
          (slot) => slot.phase === child.phase && slot.ordinal === child.ordinal,
        );
        if (
          !slot ||
          slot.execution.operationKey !== child.operationKey ||
          slot.operationFingerprint !== child.operationFingerprint ||
          controlDigest(child.operation) !== slot.operationFingerprint ||
          controlDigest(child.parentExecution) !== controlDigest(execution) ||
          controlDigest(child.serviceIds) !== controlDigest(slot.serviceIds)
        )
          throw Error("Original proxy phase changed");
        if (child.state !== "terminal" || !child.execution) continue;
        const shared = await inspectRetainedOwnedArtifactTargetChildSettlement(
          authority,
          child.execution,
        );
        if (
          restore &&
          child.phase !== "proxy-restore" &&
          child.agentState === "failed" &&
          shared?.outcome === "contained" &&
          shared.publication === "not_started"
        )
          required = true;
      }
      if (!required) return "not_required";
      if (!restore || !intent || controlDigest(intent.restore) !== controlDigest(restore))
        throw Error("Original proxy restore obligation remains pending");
      const child = children.find(
        (child) => child.phase === "proxy-restore" && child.ordinal === restore.ordinal,
      );
      if (
        !child ||
        child.state !== "terminal" ||
        !child.execution ||
        child.proxyRecovery?.backupDigest !== intent.backupDigest ||
        child.execution.executionId !== restore.execution.executionId ||
        child.execution.operationKey !== restore.execution.operationKey
      )
        throw Error("Original proxy restore obligation remains pending");
      const shared = await inspectRetainedOwnedArtifactTargetChildSettlement(
        authority,
        child.execution,
      );
      const result = z
        .strictObject({ candidateId: z.string(), reloaded: z.literal(true) })
        .parse(child.result);
      const operation = z
        .strictObject({ kind: z.literal("feedProxy.validateAndReload"), candidateId: z.string() })
        .parse(child.operation);
      if (
        child.agentState !== "succeeded" ||
        shared?.outcome !== "committed" ||
        shared.publication !== "committed" ||
        result.candidateId !== operation.candidateId ||
        controlDigest({ kind: "ops-result", result }) !== shared.terminalReceiptDigest
      )
        throw Error("Original successful proxy restore is not proved");
      return "settled";
    }
  }
  /** Only the final fixed paired leaf can close a killed activation worker.
   * Its untrusted result is accepted solely by the exact recorded physical receipt.
   * No phase is dispatched and no public status alone proves completion. */
  async function catalogActivationCompletion(authority: ExecutionHandle) {
    const state = authority,
      value = await load(state.execution);
    const input = dataExecutionInputSchema.parse(value.row.execution_input);
    if (
      state.kind !== "catalog.activate" ||
      input.kind !== "catalog.activate" ||
      !input.acknowledgeLicenseChanges ||
      controlDigest(input) !== state.execution.operationFingerprint
    )
      throw Error("Original reviewed catalog activation required");
    await assertRetainedCatalogActivationChildrenSettled(authority);
    const children = value.row.execution_children.map((raw) =>
      z
        .object({
          phase: z.string(),
          ordinal: z.number(),
          state: z.literal("terminal"),
          operationKey: z.string(),
          operationFingerprint: z.string(),
          parentExecution: executionRefSchema,
          execution: executionRefSchema,
          operation: z.unknown(),
          result: z.unknown().optional(),
        })
        .passthrough()
        .parse(raw),
    );
    for (const child of children) {
      const slot = state.reservations.find(
        (slot) => slot.phase === child.phase && slot.ordinal === child.ordinal,
      );
      if (
        !slot ||
        slot.execution.operationKey !== child.operationKey ||
        slot.operationFingerprint !== child.operationFingerprint ||
        controlDigest(child.operation) !== child.operationFingerprint ||
        controlDigest(child.parentExecution) !== controlDigest(state.execution) ||
        !(await inspectRetainedOwnedArtifactTargetChildSettlement(authority, child.execution))
      )
        throw Error("Original settled activation child required");
    }
    const matches = children.filter(
      (child) => child.phase === "paired-pin-commit" && child.ordinal === 0,
    );
    if (matches.length !== 1) throw Error("Original paired approval required");
    const child = matches[0]!,
      operation = pairedPinApprovalInputSchema.parse(child.operation),
      result = pairedPinApprovalResultSchema.parse(child.result);
    const physical = await inspectRetainedOwnedArtifactTargetChildSettlement(
      authority,
      child.execution,
    );
    if (
      !physical ||
      physical.outcome !== "committed" ||
      physical.publication !== "committed" ||
      physical.terminalReceiptDigest !== controlDigest({ kind: "ops-result", result }) ||
      operation.proposalId !== input.proposalId ||
      operation.validationId !== input.validationId ||
      operation.diffDigest !== input.diffDigest ||
      operation.expectedGenerationId !== input.expectedGenerationId ||
      !operation.acknowledgeLicenseChanges ||
      result.proposalId !== input.proposalId ||
      result.validationId !== input.validationId ||
      result.previousGenerationId !== input.expectedGenerationId
    )
      throw Error("Actual committed paired approval evidence required");
    const recovery = await assertOwnedProxyRecoverySettled(state.execution),
      stamp = Date.parse(result.committedAt),
      digest = controlDigest({
        execution: state.execution,
        approval: child.execution,
        receipt: physical.terminalReceiptDigest,
      });
    if (stamp < value.status.admittedAt || stamp > Date.now())
      throw Error("Original catalog commit time changed");
    return workerSchema.parse({
      version: 1,
      origin: state.origin,
      execution: state.execution,
      admissionDigest: state.receiptDigest,
      workerId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
      containedAt: stamp,
      outcome: "catalog-activation-committed",
      publication: "committed",
      childrenDigest: controlDigest(value.row.execution_children),
      proxyRecovery: recovery,
      result: {
        kind: "catalog.activate",
        proposalId: input.proposalId,
        validationId: input.validationId,
        outcome: "activated",
        generationId: result.generationId,
        reason: null,
      },
    });
  }
  function readProof(s: ExecutionHandle) {
    const proof = terminalSchema.parse(
      readPrivateRecord(local, "observations", `terminal-${s.execution.operationKey}.json`, 8192),
    );
    if (
      proof.admissionDigest !== s.receiptDigest ||
      !sameControlOrigin(proof.origin, s.origin) ||
      controlDigest(proof.execution) !== controlDigest(s.execution)
    )
      throw Error("Original data terminal commitment changed");
    return proof;
  }
  async function verifyStored(execution: ExecutionRef, digest?: string) {
    await assertOwnedProxyRecoverySettled(execution);
    const value = await load(execution),
      authority = restoreAdmittedControlExecution(installation, execution),
      proof = readProof(authority);
    if (
      !isDataExecutionTerminal(value.status) ||
      !value.row.finished_at ||
      proof.phase !== "canonical" ||
      proof.terminalAt !== value.row.finished_at.getTime() ||
      proof.terminalDigest !== dataTerminalReceiptDigest(value.status) ||
      (digest !== undefined && proof.terminalDigest !== digest) ||
      value.row.execution_children.some((raw) => childSchema.parse(raw).state !== "terminal")
    )
      throw Error("Data journal terminal containment is not proved");
    verifyControlEffectSettlement(installation, execution);
    return { value, authority, proof };
  }
  return {
    installation,
    dataRoot: local.dataRoot,
    assertOwnedProxyRecoverySettled,
    /** Repair only an unproved proxy root's public finality. Its original
     * identity, local write evidence, child receipts and physical lease stay. */
    async fenceUnsettledProxyRecovery(execution: ExecutionRef): Promise<void> {
      try {
        await assertOwnedProxyRecoverySettled(execution);
        return;
      } catch {
        /* Below requires the original retained proxy plan and current row. */
      }
      const s = restoreAdmittedControlExecution(installation, execution),
        value = await load(execution);
      if (
        !s.reservations.some((slot) => slot.phase === "proxy-restore") ||
        !value.row.execution_children.some((raw) =>
          z.object({ phase: z.string() }).parse(raw).phase.startsWith("proxy-"),
        )
      )
        throw Error("Original proxy recovery root required");
      const status = {
        ...value.status,
        status: value.status.cancellationRequestedAt ? "cancel_pending" : "interrupted",
        publication: "unknown",
      };
      const rows = await database.unsafe(
        "UPDATE data_manager.jobs SET status=$1,execution_state=$2::text::jsonb,finished_at=NULL,ownership_version=ownership_version+1 WHERE id=$3::uuid AND execution_version=2 AND operation_key=$4 AND ownership_version=$5 RETURNING id",
        [
          status.status,
          canonicalJson({
            ...mutableSchema.parse(value.row.execution_state),
            publication: "unknown",
          }),
          execution.executionId,
          execution.operationKey,
          value.row.ownership_version,
        ],
      );
      if (rows.length !== 1) throw Error("Proxy recovery finality repair CAS lost");
    },
    async retainProxyRecoveryIntent(authority: ExecutionHandle, backupDigest: string) {
      const value = await load(authority.execution),
        s = authority,
        restore = s.reservations.find((slot) => slot.phase === "proxy-restore");
      const child = value.row.execution_children
        .map((raw) =>
          z
            .object({
              phase: z.string(),
              state: z.string(),
              operationKey: z.string(),
              proxyRecovery: z.object({ backupDigest: z.string() }).optional(),
            })
            .parse(raw),
        )
        .find((child) => child.phase === "proxy-restore");
      if (
        s.installation !== local ||
        !restore ||
        child?.state !== "reserved" ||
        child.operationKey !== restore.execution.operationKey ||
        child.proxyRecovery?.backupDigest !== backupDigest
      )
        throw Error("Confirmed original restore reservation required");
      const payload = recoverySchema.parse({
        version: 1,
        execution: s.execution,
        admissionDigest: s.receiptDigest,
        origin: s.origin,
        restore,
        backupDigest,
      });
      const prior = recoveryIntent(authority);
      if (prior) {
        if (controlDigest(prior) !== controlDigest(payload))
          throw Error("Original recovery backup changed");
        return;
      }
      writePrivateRecord(
        local,
        "observations",
        `proxy-recovery-${s.execution.operationKey}.json`,
        payload,
        true,
      );
    },
    pendingRunnerAttempts(state: ExecutionHandle) {
      if (
        state.installation !== local ||
        !["transit-sync", "catalog.validate"].includes(state.kind)
      )
        throw Error("Original transit worker required");
      try {
        const saved = runnerJournalSchema.parse(
          readPrivateRecord(
            local,
            "observations",
            `runners-${state.execution.operationKey}.json`,
            65536,
          ),
        );
        if (controlDigest(saved.execution) !== controlDigest(state.execution))
          throw Error("Original runner owner changed");
        return saved.attempts;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return [];
      }
    },
    retainRunnerAttempt(state: ExecutionHandle, request: unknown): void {
      const body = transitousRunnerRequestSchema.parse(request);
      if (
        state.installation !== local ||
        !["transit-sync", "catalog.validate"].includes(state.kind)
      )
        throw Error("Original transit worker required");
      const name = `runners-${state.execution.operationKey}.json`;
      let saved: z.infer<typeof runnerJournalSchema> = {
        version: 1,
        execution: state.execution,
        completed: 0,
        completedDigest: controlDigest([]),
        attempts: [],
      };
      try {
        saved = runnerJournalSchema.parse(readPrivateRecord(local, "observations", name, 65536));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        controlDigest(saved.execution) !== controlDigest(state.execution) ||
        saved.attempts.some((attempt) => attempt.capability === body.capability) ||
        saved.attempts.length >= 32
      )
        throw Error("Runner attempt replay/capacity conflict");
      const next = { ...saved, attempts: [...saved.attempts, body] };
      writePrivateRecord(local, "observations", name, next, false);
    },
    completeRunnerAttempt(state: ExecutionHandle, request: unknown, result: unknown): void {
      const body = transitousRunnerRequestSchema.parse(request),
        terminal = transitousRunnerResultSchema.parse(result);
      const name = `runners-${state.execution.operationKey}.json`,
        saved = runnerJournalSchema.parse(readPrivateRecord(local, "observations", name, 65536)),
        attempt = saved.attempts.find((attempt) => attempt.capability === body.capability);
      if (
        controlDigest(saved.execution) !== controlDigest(state.execution) ||
        !attempt ||
        canonicalJson(attempt) !== canonicalJson(body)
      )
        throw Error("Original runner attempt required");
      writePrivateRecord(
        local,
        "observations",
        name,
        {
          ...saved,
          completed: saved.completed + 1,
          completedDigest: controlDigest({
            previous: saved.completedDigest,
            attempt: controlDigest(body),
            result: terminal,
          }),
          attempts: saved.attempts.filter((entry) => entry.capability !== body.capability),
        },
        false,
      );
    },
    async begin(authority: ExecutionHandle) {
      const value = await load(authority.execution);
      if (value.status.status !== "queued" || value.status.cancellationRequestedAt)
        throw Error("Only a newly admitted data worker may begin");
      await beginControlEffect(authority);
    },
    /** The actual dispatcher promise must contain and await all of its process,
     * transfer, transaction and remote-child continuations before settling. */
    async contain(
      authority: ExecutionHandle,
      worker: Promise<DataExecutionResult>,
      lease?: TargetLeaseAuthority,
    ) {
      const state = authority;
      if (state.installation !== local) throw Error("Foreign data worker");
      let result: DataExecutionResult | undefined,
        error: unknown,
        partial = false;
      try {
        result = await worker;
      } catch (value) {
        if (value instanceof DataExecutionPartialResult) {
          result = value.result;
          partial = true;
        } else error = value;
      }
      if (result !== undefined) {
        try {
          result = dataExecutionResultSchema.parse(result);
          if (result.kind !== state.kind) throw Error("Worker result kind changed");
        } catch (value) {
          result = undefined;
          error = value;
        }
      }
      let remotePending = false;
      try {
        const remote = runnerJournalSchema.parse(
          readPrivateRecord(
            local,
            "observations",
            `runners-${state.execution.operationKey}.json`,
            65536,
          ),
        );
        remotePending = remote.attempts.length > 0;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const value = await load(authority.execution),
        workerId = randomUUID();
      let recovery: "not_required" | "settled" | "pending";
      try {
        recovery = await assertOwnedProxyRecoverySettled(authority.execution);
      } catch {
        recovery = "pending";
      }
      const childrenDigest = controlDigest(value.row.execution_children),
        publication =
          remotePending || recovery === "pending"
            ? "unknown"
            : result
              ? "committed"
              : value.status.publication;
      if (remotePending) {
        result = undefined;
        error = Error("Remote runner containment remains unknown");
      }
      const proof =
        state.kind === "catalog.activate" &&
        result?.kind === "catalog.activate" &&
        result.outcome === "activated"
          ? await catalogActivationCompletion(authority)
          : workerSchema.parse({
              version: 1,
              origin: state.origin,
              execution: state.execution,
              admissionDigest: state.receiptDigest,
              workerId,
              containedAt: Date.now(),
              outcome: result ? (partial ? "partial" : "returned") : "failed",
              publication,
              childrenDigest,
              proxyRecovery: recovery,
              ...(result ? { result } : {}),
            });
      // Only the live producer, after awaiting the actual dispatcher promise,
      // creates this immutable completion. Recovery only reads it back.
      writePrivateRecord(
        local,
        "observations",
        `worker-${state.execution.operationKey}.json`,
        proof,
        true,
      );
      const completion = Object.freeze({ [completionBrand]: true as const });
      completions.set(completion, {
        authority,
        workerId: proof.workerId,
        publication,
        childrenDigest,
        partial,
        result,
        error,
        ...(lease ? { lease } : {}),
      });
      return { completion, result, error, partial, publication };
    },
    async repairCommittedCatalogActivation(execution: ExecutionRef): Promise<void> {
      const authority = restoreAdmittedControlExecution(installation, execution);
      if (authority.kind !== "catalog.activate")
        throw Error("Original catalog activation owner required");
      // This closes all future issuance under the original owner, even when its
      // deadline passed. Every already-issued physical child must be settled.
      await cancelControlExecution(authority);
      const proof = await catalogActivationCompletion(authority),
        name = `worker-${execution.operationKey}.json`;
      try {
        const retained = readPrivateRecord(local, "observations", name, 65536);
        if (canonicalJson(retained) !== canonicalJson(proof))
          throw Error("Original worker completion already differs");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      writePrivateRecord(local, "observations", name, proof, true);
    },
    async restoreCompletion(execution: ExecutionRef) {
      const value = await load(execution),
        authority = restoreAdmittedControlExecution(installation, execution),
        state = authority;
      const proof = workerSchema.parse(
        readPrivateRecord(local, "observations", `worker-${execution.operationKey}.json`, 65536),
      );
      if (proof.outcome === "catalog-activation-committed") {
        if (canonicalJson(proof) !== canonicalJson(await catalogActivationCompletion(authority)))
          throw Error("Original final approval completion changed");
      }
      if (
        proof.admissionDigest !== state.receiptDigest ||
        !sameControlOrigin(proof.origin, state.origin) ||
        controlDigest(proof.execution) !== controlDigest(execution) ||
        proof.containedAt < value.status.admittedAt ||
        (proof.result && proof.result.kind !== value.status.kind)
      )
        throw Error("Original contained worker identity changed");
      if (
        (proof.childrenDigest &&
          proof.childrenDigest !== controlDigest(value.row.execution_children)) ||
        (!proof.childrenDigest && value.row.execution_children.length > 0)
      )
        throw Error("Original worker child snapshot changed");
      await assertOwnedProxyRecoverySettled(execution);
      const lease = dataExecutionHoldsLease(
          dataExecutionInputSchema.parse(value.row.execution_input),
        )
          ? restoreArtifactTargetLeaseForSettlement(authority)
          : undefined,
        error = proof.outcome === "failed" ? Error("Original contained worker failed") : undefined;
      const completion = Object.freeze({ [completionBrand]: true as const });
      completions.set(completion, {
        authority,
        workerId: proof.workerId,
        partial: proof.outcome === "partial",
        publication: proof.publication,
        childrenDigest: proof.childrenDigest,
        result: proof.result,
        error,
        lease,
      });
      return {
        completion,
        authority,
        lease,
        result: proof.result,
        error,
        publication: proof.publication,
        partial: proof.outcome === "partial",
      };
    },
    /** Records the end of a worker that ran inside a previous data-manager
     * process and died with it. Only work data-manager runs in its own process
     * qualifies, and only once no completion exists. The caller has settled every
     * agent operation the worker attempted; `publication` says whether the
     * worker may have changed data. */
    async containAbandoned(execution: ExecutionRef, publication: "not_started" | "committed") {
      const value = await load(execution),
        authority = restoreAdmittedControlExecution(installation, execution),
        state = authority,
        name = `worker-${execution.operationKey}.json`;
      if (!(LOCAL_DATA_EXECUTION_KINDS as readonly string[]).includes(value.status.kind))
        throw Error("Only an in-process data worker can be abandoned");
      try {
        readPrivateRecord(local, "observations", name, 65536);
        throw Error("Original worker completion exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const proof = workerSchema.parse({
        version: 1,
        origin: state.origin,
        execution: state.execution,
        admissionDigest: state.receiptDigest,
        workerId: randomUUID(),
        containedAt: Date.now(),
        outcome: "failed",
        publication,
        childrenDigest: controlDigest(value.row.execution_children),
        proxyRecovery: "not_required",
      });
      writePrivateRecord(local, "observations", name, proof, true);
      const lease = dataExecutionHoldsLease(
          dataExecutionInputSchema.parse(value.row.execution_input),
        )
          ? restoreArtifactTargetLeaseForSettlement(authority)
          : undefined,
        completion = Object.freeze({ [completionBrand]: true as const });
      completions.set(completion, {
        authority,
        workerId: proof.workerId,
        publication,
        childrenDigest: proof.childrenDigest,
        error: Error("Data worker ended with its process"),
        lease,
      });
      return { completion, lease };
    },
    async prepareTerminal(
      completion: ContainedDataExecution,
      status: DataExecutionStatus,
      terminalAt: number,
    ) {
      const owned = completions.get(completion);
      if (!owned) throw Error("Actual contained data worker required");
      const { authority } = owned,
        s = authority,
        value = await load(authority.execution),
        terminal = dataExecutionStatusSchema.parse(status);
      await assertOwnedProxyRecoverySettled(authority.execution);
      if (
        owned.childrenDigest !== undefined &&
        owned.childrenDigest !== controlDigest(value.row.execution_children)
      )
        throw Error("Contained worker/current child union changed");
      if (
        owned.publication === "unknown" ||
        terminal.publication !== owned.publication ||
        !isDataExecutionTerminal(terminal) ||
        terminal.id !== value.status.id ||
        terminal.operationKey !== value.status.operationKey ||
        terminal.fingerprint !== value.status.fingerprint ||
        terminal.admittedAt !== value.status.admittedAt ||
        terminal.deadlineAt !== value.status.deadlineAt ||
        terminal.kind !== value.status.kind ||
        !Number.isSafeInteger(terminalAt) ||
        terminalAt < terminal.admittedAt
      )
        throw Error("Invalid original data terminal tuple");
      if (
        terminal.result !== undefined &&
        canonicalJson(terminal.result) !== canonicalJson(owned.result)
      )
        throw Error("Terminal result differs from actual dispatcher result");
      if (
        owned.result &&
        terminal.status !==
          (owned.result.kind === "catalog.validate" && owned.result.status === "failed"
            ? "error"
            : owned.result.kind === "catalog.activate" && owned.result.outcome !== "activated"
              ? "error"
              : owned.result.kind === "transit-sync"
                ? owned.result.finalStatus
                : owned.partial
                  ? "partial"
                  : "ok")
      )
        throw Error("Terminal status differs from actual dispatcher outcome");
      if (terminal.status === "ok" && owned.error !== undefined)
        throw Error("Failed dispatcher cannot succeed");
      const children = value.row.execution_children.map((raw) => childSchema.parse(raw));
      for (const child of children) {
        if (child.state !== "terminal" || !child.execution || !child.settlement || !owned.lease)
          throw Error("Unsettled data descendant");
        const proof = await inspectArtifactTargetLeaseChildSettlement(owned.lease, child.execution);
        if (
          !proof ||
          controlDigest(proof) !==
            controlDigest({
              identity: child.execution,
              ...child.settlement,
              publication: child.publication,
            })
        )
          throw Error("Original shared child settlement changed");
      }
      const childrenDigest = controlDigest(children),
        digest = dataTerminalReceiptDigest(terminal);
      let raw: unknown = null;
      try {
        raw = readPrivateRecord(
          local,
          "observations",
          `terminal-${s.execution.operationKey}.json`,
          8192,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const prior = raw === null ? undefined : readProof(authority);
      const original = prior?.terminalAt ?? terminalAt;
      if (
        prior &&
        (prior.terminalDigest !== digest ||
          prior.workerId !== owned.workerId ||
          prior.childrenDigest !== childrenDigest)
      )
        throw Error("Original data terminal tuple is immutable");
      const payload = terminalSchema.parse({
        version: 1,
        phase: "prepared",
        origin: s.origin,
        execution: s.execution,
        admissionDigest: s.receiptDigest,
        terminalDigest: digest,
        terminalAt: original,
        workerId: owned.workerId,
        childrenDigest,
      });
      writePrivateRecord(
        local,
        "observations",
        `terminal-${s.execution.operationKey}.json`,
        payload,
        false,
      );
      await settleExecution(s, {
        outcome: terminal.publication === "committed" ? "committed" : "contained",
        publication: terminal.publication,
        receipt: {
          kind: "data-execution",
          status: terminal,
          workerId: owned.workerId,
          childrenDigest,
        },
      });
      return original;
    },
    async publishTerminal(execution: ExecutionRef) {
      await assertOwnedProxyRecoverySettled(execution);
      const value = await load(execution),
        authority = restoreAdmittedControlExecution(installation, execution),
        proof = readProof(authority);
      if (
        !isDataExecutionTerminal(value.status) ||
        value.row.finished_at?.getTime() !== proof.terminalAt ||
        dataTerminalReceiptDigest(value.status) !== proof.terminalDigest ||
        controlDigest(value.row.execution_children) !== proof.childrenDigest
      )
        throw Error("Original committed data terminal tuple/time required");
      verifyControlEffectSettlement(installation, execution);
      if (proof.phase !== "canonical")
        writePrivateRecord(
          local,
          "observations",
          `terminal-${execution.operationKey}.json`,
          { ...proof, phase: "canonical" },
          false,
        );
    },
    /** Checks the committed terminal and every child's terminal before the
     * execution's own lease is released. */
    async verifyContainedTerminal(execution: ExecutionRef) {
      await verifyStored(execution);
    },
    repairTerminal: async (execution: ExecutionRef) => {
      await assertOwnedProxyRecoverySettled(execution);
      // existing recorded commitment only; never reconstruct one from a row
      const authority = restoreAdmittedControlExecution(installation, execution);
      readProof(authority);
      await (async () => {
        const value = await load(execution);
        if (!isDataExecutionTerminal(value.status)) throw Error("Data terminal row required");
      })();
      // Use the same exact tuple/time verifier and publisher above via the fixed method.
      return authority;
    },
  };
}
export type DataExecutionControlJournal = ReturnType<typeof createDataExecutionControlJournal>;
