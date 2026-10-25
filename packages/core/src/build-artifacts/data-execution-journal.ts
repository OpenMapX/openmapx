/** Fixed data-manager database/worker journal. No public row or callback boolean
 * can mint a completion or repair an absent original terminal commitment. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import { canonicalJson } from "../ops/fingerprint";
import {
  type DataExecutionResult,
  type DataExecutionStatus,
  dataExecutionResultSchema,
  dataExecutionStatusSchema,
  generationHardlinksPlanSchema,
  isDataExecutionTerminal,
} from "../services/data-manager/contracts/executions";
import {
  transitousRunnerRequestSchema,
  transitousRunnerResultSchema,
} from "../transitous-runner/contract";
import {
  beginControlEffect,
  type ControlInstallation,
  controlDigest,
  executionAuthorityState,
  installationState,
  publishDataControlTerminalWitness,
  readPrivateRecord,
  requireControlJournalRetention,
  restoreAdmittedControlExecution,
  settleExecutionLifecycle,
  type VerifiedExecutionAuthority,
  verifyControlEffectSettlement,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "./control-authority";
import {
  controlOriginSchema,
  sameControlOrigin,
  signControl,
  verifyControl,
} from "./control-records";
import {
  dataFenceRetirementTuple,
  verifyRetainedDataFenceRefusal,
  verifyRetainedDataFenceTerminal,
} from "./data-configuration-fence";
import { retainedDataDatabaseTimestamp } from "./data-database-time";
import { DataExecutionPartialResult } from "./data-execution-outcome";
import { verifyFeedProxyCanonicalTerminal } from "./feed-proxy-validation";
import {
  assertFamilyCanonicalCompatibility,
  completeFamilyJournal,
  markFamilyTerminal,
  publishFamilyCanonicalTerminal,
} from "./retention-family";
import {
  closeArtifactTargetLeaseHandle,
  inspectArtifactTargetLeaseChildSettlement,
  restoreArtifactTargetLeaseForSettlement,
  restoreGenerationHardlinksLeaseForSettlement,
  type TargetLeaseAuthority,
  verifyRetainedArtifactTargetRootRelease,
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
    authority: VerifiedExecutionAuthority;
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
    installationId: z.uuid(),
    origin: controlOriginSchema,
    execution: executionRefSchema,
    admissionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    workerId: z.uuid(),
    containedAt: z.number().int().positive().safe(),
    outcome: z.enum(["returned", "partial", "failed"]),
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
  installationId: z.uuid(),
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
export function createDataExecutionControlJournal(
  installation: ControlInstallation,
  database: DataExecutionJournalDatabase,
) {
  const local = installationState(installation);
  if (installation.role !== "data-manager" || local.fixedChildId || local.retentionJournal)
    throw Error("Fixed data-manager journal required");
  const contained = new Map<string, string>();
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
  function recoveryIntent(authority: VerifiedExecutionAuthority) {
    const s = executionAuthorityState(authority);
    try {
      const proof = verifyControl(
        installation.publicKey,
        "openmapx-data-proxy-recovery-v1",
        readPrivateRecord(
          local,
          "observations",
          `proxy-recovery-${s.execution.operationKey}.json`,
          8192,
        ),
        recoverySchema,
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
  /** One fixed policy over the current actual row, original signed plan and
   * authenticated shared child/canonical receipts. No status/result shortcut. */
  async function assertOwnedProxyRecoverySettled(
    execution: ExecutionRef,
  ): Promise<"not_required" | "settled"> {
    const value = await load(execution),
      authority = restoreAdmittedControlExecution(installation, execution),
      s = executionAuthorityState(authority);
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
          proxyRecovery: z.object({ version: z.literal(1), backupDigest: z.string() }).optional(),
        })
        .passthrough()
        .parse(raw),
    );
    const intent = recoveryIntent(authority);
    let required = intent !== null || children.some((child) => child.phase === "proxy-restore");
    let lease: TargetLeaseAuthority | undefined;
    try {
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
        lease ??= restoreArtifactTargetLeaseForSettlement(authority);
        const shared = inspectArtifactTargetLeaseChildSettlement(lease, child.execution);
        const canonical = verifyFeedProxyCanonicalTerminal(authority, child.execution);
        if (
          restore &&
          child.phase !== "proxy-restore" &&
          canonical.state === "failed" &&
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
      lease ??= restoreArtifactTargetLeaseForSettlement(authority);
      const shared = inspectArtifactTargetLeaseChildSettlement(lease, child.execution),
        canonical = verifyFeedProxyCanonicalTerminal(authority, child.execution);
      const result = z
        .strictObject({ candidateId: z.string(), reloaded: z.literal(true) })
        .parse(canonical.result);
      const operation = z
        .strictObject({ kind: z.literal("feedProxy.validateAndReload"), candidateId: z.string() })
        .parse(child.operation);
      if (
        canonical.state !== "succeeded" ||
        shared?.outcome !== "committed" ||
        shared.publication !== "committed" ||
        result.candidateId !== operation.candidateId ||
        controlDigest({ kind: "ops-result", result }) !== shared.terminalReceiptDigest
      )
        throw Error("Original successful proxy restore is not proved");
      return "settled";
    } finally {
      if (lease) closeArtifactTargetLeaseHandle(lease);
    }
  }
  function readProof(authority: VerifiedExecutionAuthority) {
    const s = executionAuthorityState(authority);
    const proof = verifyControl(
      installation.publicKey,
      "openmapx-data-terminal-v1",
      readPrivateRecord(local, "observations", `terminal-${s.execution.operationKey}.json`, 8192),
      terminalSchema,
    );
    if (
      proof.installationId !== installation.installationId ||
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
  const journal = {
    async prepare(executions: readonly { execution: ExecutionRef; digest?: string }[]) {
      contained.clear();
      for (const item of executions)
        try {
          const rows = await database.unsafe(
            "SELECT * FROM data_manager.jobs WHERE operation_key=$1",
            [item.execution.operationKey],
          );
          if (rows.length === 0) {
            const proof = verifyRetainedDataFenceRefusal(installation, item.execution);
            if (item.digest === proof.digest)
              contained.set(item.execution.operationKey, proof.digest);
            continue;
          }
          if (rows.length !== 1) continue;
          if (rows[0]!.kind === "configuration-maintenance") {
            const proof = verifyRetainedDataFenceTerminal(installation, item.execution, rows[0]!);
            if (item.digest !== undefined && item.digest !== proof.digest) continue;
            contained.set(item.execution.operationKey, proof.digest);
          } else {
            const { proof } = await verifyStored(item.execution, item.digest);
            contained.set(item.execution.operationKey, proof.terminalDigest);
          }
        } catch {
          /* Missing, unfinished or unknown guard/worker evidence is retained. */
        }
    },
    contained(execution: ExecutionRef, digest: string | undefined) {
      return digest !== undefined && contained.get(execution.operationKey) === digest;
    },
    async retire(
      executions: readonly { execution: ExecutionRef; digest: string; terminalAt?: number }[],
      _manifestDigest: string,
    ) {
      // The signed family manifest has already committed the original tuple
      // and time. Private records may already be removed on a resumed cleanup.
      for (const item of executions) {
        // A resumed, already committed family cleanup may have deleted its row.
        // Absence here permits no effects; the caller owns the signed manifest.
        const rows = await database.unsafe(
          "SELECT * FROM data_manager.jobs WHERE execution_version=2 AND operation_key=$1",
          [item.execution.operationKey],
        );
        if (rows.length === 0) {
          const guards = await database.unsafe(
            "SELECT * FROM data_manager.jobs WHERE kind='configuration-maintenance' AND operation_key=$1",
            [item.execution.operationKey],
          );
          if (guards.length) {
            const guard = guards[0]!,
              tuple = dataFenceRetirementTuple(guard);
            if (
              guards.length !== 1 ||
              guard.id !== item.execution.executionId ||
              tuple.digest !== item.digest ||
              tuple.terminalAt !== item.terminalAt
            )
              throw Error("Retiring guard tuple/time changed");
            const deleted = await database.unsafe(
              "DELETE FROM data_manager.jobs WHERE id=$1::uuid AND kind='configuration-maintenance' AND operation_key=$2 AND ownership_version=$3 RETURNING id",
              [
                item.execution.executionId,
                item.execution.operationKey,
                z.number().int().parse(guard.ownership_version),
              ],
            );
            if (deleted.length !== 1) throw Error("Guard retirement CAS conflict");
          }
          contained.delete(item.execution.operationKey);
          continue;
        }
        const value = statusOf(rows[0]);
        if (
          rows.length !== 1 ||
          controlDigest(value.execution) !== controlDigest(item.execution) ||
          !isDataExecutionTerminal(value.status) ||
          dataTerminalReceiptDigest(value.status) !== item.digest ||
          !item.terminalAt ||
          value.row.finished_at?.getTime() !== item.terminalAt
        )
          throw Error("Retiring data terminal tuple/time changed");
        const removed = await database.unsafe(
          "DELETE FROM data_manager.jobs WHERE id=$1::uuid AND execution_version=2 AND operation_key=$2 AND ownership_version=$3 AND finished_at=$4::text::timestamptz RETURNING id",
          [
            value.status.id,
            item.execution.operationKey,
            value.row.ownership_version,
            value.row.finished_at.toISOString(),
          ],
        );
        if (removed.length !== 1) throw Error("Data journal retirement CAS conflict");
        contained.delete(item.execution.operationKey);
      }
    },
  };
  local.retentionJournal = journal;
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
        /* Below requires the original signed proxy plan and current row. */
      }
      const authority = restoreAdmittedControlExecution(installation, execution),
        s = executionAuthorityState(authority),
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
    async retainProxyRecoveryIntent(authority: VerifiedExecutionAuthority, backupDigest: string) {
      const value = await load(authority.execution),
        s = executionAuthorityState(authority),
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
        !s.origin ||
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
        signControl(local.privateKey, "openmapx-data-proxy-recovery-v1", payload),
        true,
        s.origin,
      );
    },
    pendingRunnerAttempts(authority: VerifiedExecutionAuthority) {
      const state = executionAuthorityState(authority);
      if (state.installation !== local || state.kind !== "transit-sync" || !state.origin)
        throw Error("Original transit worker required");
      try {
        const saved = verifyControl(
          installation.publicKey,
          "openmapx-data-runner-journal-v1",
          readPrivateRecord(
            local,
            "observations",
            `runners-${state.execution.operationKey}.json`,
            65536,
          ),
          runnerJournalSchema,
        );
        if (controlDigest(saved.execution) !== controlDigest(state.execution))
          throw Error("Original runner owner changed");
        return saved.attempts;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return [];
      }
    },
    retainRunnerAttempt(authority: VerifiedExecutionAuthority, request: unknown): void {
      const state = executionAuthorityState(authority),
        body = transitousRunnerRequestSchema.parse(request);
      if (state.installation !== local || state.kind !== "transit-sync" || !state.origin)
        throw Error("Original transit worker required");
      withPrivateEffectWriter(state, () => {
        const name = `runners-${state.execution.operationKey}.json`;
        let saved: z.infer<typeof runnerJournalSchema> = {
          version: 1,
          execution: state.execution,
          completed: 0,
          completedDigest: controlDigest([]),
          attempts: [],
        };
        try {
          saved = verifyControl(
            installation.publicKey,
            "openmapx-data-runner-journal-v1",
            readPrivateRecord(local, "observations", name, 65536),
            runnerJournalSchema,
          );
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
        writePrivateRecord(
          local,
          "observations",
          name,
          signControl(local.privateKey, "openmapx-data-runner-journal-v1", next),
          false,
          state.origin,
        );
      });
    },
    completeRunnerAttempt(
      authority: VerifiedExecutionAuthority,
      request: unknown,
      result: unknown,
    ): void {
      const state = executionAuthorityState(authority),
        body = transitousRunnerRequestSchema.parse(request),
        terminal = transitousRunnerResultSchema.parse(result);
      withPrivateEffectWriter(state, () => {
        const name = `runners-${state.execution.operationKey}.json`,
          saved = verifyControl(
            installation.publicKey,
            "openmapx-data-runner-journal-v1",
            readPrivateRecord(local, "observations", name, 65536),
            runnerJournalSchema,
          ),
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
          signControl(local.privateKey, "openmapx-data-runner-journal-v1", {
            ...saved,
            completed: saved.completed + 1,
            completedDigest: controlDigest({
              previous: saved.completedDigest,
              attempt: controlDigest(body),
              result: terminal,
            }),
            attempts: saved.attempts.filter((entry) => entry.capability !== body.capability),
          }),
          false,
          state.origin,
        );
      });
    },
    async retainHardlinksPlan(authority: VerifiedExecutionAuthority, plan: unknown) {
      const s = executionAuthorityState(authority),
        value = await load(authority.execution),
        body = generationHardlinksPlanSchema.parse(plan);
      if (value.status.kind !== "generation-hardlinks") throw Error("Generation leaf required");
      const input = z
        .object({
          execution_input: z.object({
            kind: z.literal("generation-hardlinks"),
            revisionId: z.string(),
            planDigest: z.string(),
            coordinatorMode: z.string(),
          }),
        })
        .parse(value.row).execution_input;
      if (
        input.planDigest !== controlDigest(body) ||
        body.plan.some((entry) => !s.serviceIds.includes(entry.consumerService))
      )
        throw Error("Signed generation plan/target binding mismatch");
      const payload = { version: 1, execution: s.execution, input, plan: body };
      let saved: unknown;
      try {
        saved = readPrivateRecord(
          local,
          "hardlinks",
          `${s.execution.executionId}.json`,
          1024 * 1024,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (saved) {
        const original = verifyControl(
          installation.publicKey,
          "openmapx-data-hardlinks-v1",
          saved,
          z.unknown(),
        );
        if (canonicalJson(original) !== canonicalJson(payload))
          throw Error("Original generation plan conflict");
        return;
      }
      writePrivateRecord(
        local,
        "hardlinks",
        `${s.execution.executionId}.json`,
        signControl(local.privateKey, "openmapx-data-hardlinks-v1", payload),
        true,
        s.origin,
      );
    },
    async readHardlinksPlan(execution: ExecutionRef) {
      const value = await load(execution),
        payload = verifyControl(
          installation.publicKey,
          "openmapx-data-hardlinks-v1",
          readPrivateRecord(local, "hardlinks", `${execution.executionId}.json`, 1024 * 1024),
          z.strictObject({
            version: z.literal(1),
            execution: executionRefSchema,
            input: z.object({
              kind: z.literal("generation-hardlinks"),
              revisionId: z.string(),
              planDigest: z.string(),
              coordinatorMode: z.string(),
            }),
            plan: generationHardlinksPlanSchema,
          }),
        );
      if (
        controlDigest(payload.execution) !== controlDigest(execution) ||
        controlDigest(payload.input) !== controlDigest(value.row.execution_input) ||
        payload.input.planDigest !== controlDigest(payload.plan)
      )
        throw Error("Original generation plan changed");
      return payload.plan;
    },
    async begin(authority: VerifiedExecutionAuthority) {
      const value = await load(authority.execution);
      if (value.status.status !== "queued" || value.status.cancellationRequestedAt)
        throw Error("Only a newly admitted data worker may begin");
      requireControlJournalRetention(authority);
      beginControlEffect(authority);
    },
    /** The actual dispatcher promise must contain and await all of its process,
     * transfer, transaction and remote-child continuations before settling. */
    async contain(
      authority: VerifiedExecutionAuthority,
      worker: Promise<DataExecutionResult>,
      lease?: TargetLeaseAuthority,
    ) {
      const state = executionAuthorityState(authority);
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
        const remote = verifyControl(
          installation.publicKey,
          "openmapx-data-runner-journal-v1",
          readPrivateRecord(
            local,
            "observations",
            `runners-${state.execution.operationKey}.json`,
            65536,
          ),
          runnerJournalSchema,
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
      if (!state.origin) throw Error("Dated contained worker origin required");
      const proof = workerSchema.parse({
        version: 1,
        installationId: installation.installationId,
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
      // creates this immutable completion. Recovery only reads its signature.
      writePrivateRecord(
        local,
        "observations",
        `worker-${state.execution.operationKey}.json`,
        signControl(local.privateKey, "openmapx-data-worker-contained-v1", proof),
        true,
        state.origin,
      );
      const completion = Object.freeze({ [completionBrand]: true as const });
      completions.set(completion, {
        authority,
        workerId,
        publication,
        childrenDigest,
        partial,
        result,
        error,
        ...(lease ? { lease } : {}),
      });
      return { completion, result, error, partial };
    },
    async restoreCompletion(execution: ExecutionRef) {
      const value = await load(execution),
        authority = restoreAdmittedControlExecution(installation, execution),
        state = executionAuthorityState(authority);
      const proof = verifyControl(
        installation.publicKey,
        "openmapx-data-worker-contained-v1",
        readPrivateRecord(local, "observations", `worker-${execution.operationKey}.json`, 65536),
        workerSchema,
      );
      if (
        proof.installationId !== installation.installationId ||
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
      const lease =
          value.status.kind === "generation-hardlinks"
            ? restoreGenerationHardlinksLeaseForSettlement(authority)
            : restoreArtifactTargetLeaseForSettlement(authority),
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
    async prepareTerminal(
      completion: ContainedDataExecution,
      status: DataExecutionStatus,
      terminalAt: number,
    ) {
      const owned = completions.get(completion);
      if (!owned) throw Error("Actual contained data worker required");
      const { authority } = owned,
        s = executionAuthorityState(authority),
        value = await load(authority.execution),
        terminal = dataExecutionStatusSchema.parse(status);
      await assertOwnedProxyRecoverySettled(authority.execution);
      if (
        owned.childrenDigest !== undefined &&
        owned.childrenDigest !== controlDigest(value.row.execution_children)
      )
        throw Error("Contained worker/current child union changed");
      if (
        !s.origin ||
        !isDataExecutionTerminal(terminal) ||
        terminal.publication === "unknown" ||
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
          (owned.result.kind === "transit-sync"
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
        const proof = inspectArtifactTargetLeaseChildSettlement(owned.lease, child.execution);
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
      return withPrivateEffectWriter(s, () => {
        const raw = readPrivateRecord(
            local,
            "observations",
            `terminal-${s.execution.operationKey}.json`,
            8192,
          ),
          prior = raw === null ? undefined : readProof(authority);
        const original = prior?.terminalAt ?? terminalAt;
        if (
          prior &&
          (prior.terminalDigest !== digest ||
            prior.workerId !== owned.workerId ||
            prior.childrenDigest !== childrenDigest)
        )
          throw Error("Original data terminal tuple is immutable");
        assertFamilyCanonicalCompatibility(local, s.origin!, s.execution, digest, original);
        const payload = terminalSchema.parse({
          version: 1,
          phase: "prepared",
          installationId: installation.installationId,
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
          signControl(local.privateKey, "openmapx-data-terminal-v1", payload),
          false,
          s.origin,
        );
        const receipt = {
            kind: "data-execution" as const,
            status: terminal,
            workerId: owned.workerId,
            childrenDigest,
          },
          outcome =
            terminal.publication === "committed" ? ("committed" as const) : ("contained" as const);
        const effect = {
          identity: s.execution,
          outcome,
          publication: terminal.publication,
          terminalReceiptDigest: controlDigest(receipt),
          receipt,
        };
        settleExecutionLifecycle(s);
        writePrivateRecord(
          local,
          "effects",
          `${s.execution.operationKey}.json`,
          signControl(local.privateKey, "openmapx-control-settlement-v1", effect),
          false,
          s.origin,
        );
        markFamilyTerminal(local, s.origin!, s.execution, true, controlDigest(effect));
        return original;
      });
    },
    async publishTerminal(execution: ExecutionRef) {
      await assertOwnedProxyRecoverySettled(execution);
      const value = await load(execution),
        authority = restoreAdmittedControlExecution(installation, execution),
        s = executionAuthorityState(authority),
        proof = readProof(authority);
      if (
        !isDataExecutionTerminal(value.status) ||
        value.row.finished_at?.getTime() !== proof.terminalAt ||
        dataTerminalReceiptDigest(value.status) !== proof.terminalDigest ||
        controlDigest(value.row.execution_children) !== proof.childrenDigest
      )
        throw Error("Original committed data terminal tuple/time required");
      verifyControlEffectSettlement(installation, execution);
      withPrivateEffectWriter(s, () => {
        if (proof.phase !== "canonical")
          writePrivateRecord(
            local,
            "observations",
            `terminal-${execution.operationKey}.json`,
            signControl(local.privateKey, "openmapx-data-terminal-v1", {
              ...proof,
              phase: "canonical",
            }),
            false,
            s.origin,
          );
        publishFamilyCanonicalTerminal(
          local,
          proof.origin,
          execution,
          true,
          proof.terminalDigest,
          proof.terminalAt,
        );
        completeFamilyJournal(local, proof.origin, execution, proof.terminalAt);
      });
      contained.set(execution.operationKey, proof.terminalDigest);
    },
    async publishContainedTerminal(execution: ExecutionRef) {
      const { value, authority, proof } = await verifyStored(execution);
      verifyRetainedArtifactTargetRootRelease(authority);
      publishDataControlTerminalWitness(authority, value.status, proof.terminalAt);
    },
    repairTerminal: async (execution: ExecutionRef) => {
      await assertOwnedProxyRecoverySettled(execution);
      // existing signed commitment only; never reconstruct one from a row
      const authority = restoreAdmittedControlExecution(installation, execution);
      readProof(authority);
      await (async () => {
        const value = await load(execution);
        if (!isDataExecutionTerminal(value.status)) throw Error("Data terminal row required");
      })();
      // Use the same exact tuple/time verifier and publisher above via the fixed method.
      return authority;
    },
    close() {
      if (local.retentionJournal === journal) local.retentionJournal = undefined;
      contained.clear();
    },
  };
}
export type DataExecutionControlJournal = ReturnType<typeof createDataExecutionControlJournal>;
