/** The data-manager's configuration fence: one row in
 * `data_manager.configuration_fence`. While a row is `prepared`, no data job
 * is admitted. Only the operations agent prepares and settles it, authenticated
 * by its own data-manager token; both calls are idempotent on the same body.
 * The agent records the fence leaf in its lease store and settles it from the
 * receipt this returns. */
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { executionFingerprint, type VerifiedParentExecution } from "../ops/execution-identity";
import {
  type DataConfigurationFencePrepare,
  type DataConfigurationFenceReceipt,
  type DataConfigurationFenceSettle,
  dataConfigurationFenceOutcomeSchema,
  dataConfigurationFencePrepareSchema,
  dataConfigurationFenceSettleSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import { startGenerationHardlinksExecutionSchema } from "../services/data-manager/contracts/executions";
import {
  beginControlEffect,
  type ControlInstallation,
  type ControlTransportPrincipal,
  childSettlementState,
  controlDigest,
  executionAuthorityState,
  inspectRemoteDelegation,
  installationState,
  readPrivateRecord,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainedControlParent,
  settleExecutionLifecycle,
  type VerifiedExecutionAuthority,
  verifyControlEffectSettlement,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "./control-authority";

export interface DataFenceSql {
  unsafe(
    query: string,
    parameters?: (string | number | null)[],
  ): Promise<readonly Record<string, unknown>[]>;
  transaction<T>(run: (tx: Pick<DataFenceSql, "unsafe">) => Promise<T>): Promise<T>;
}
type Tx = Pick<DataFenceSql, "unsafe">;
const fenceRowSchema = z.object({
  maintenance_id: z.uuid(),
  fence_id: z.uuid(),
  operation_key: z.string(),
  candidate_id: z.uuid(),
  plan_digest: z.string(),
  input: dataConfigurationFencePrepareSchema,
  state: z.enum(["prepared", "settled"]),
  outcome: dataConfigurationFenceOutcomeSchema.nullable(),
});
type FenceRow = z.infer<typeof fenceRowSchema>;
/** Data jobs whose effects are unknown keep the data plane fenced: their
 * publication was not observed, or a legacy job was interrupted unfinished. */
const UNKNOWN_DATA_JOB =
  "SELECT id FROM data_manager.jobs WHERE execution_state->>'publication'='unknown' OR (execution_version IS NULL AND finished_at IS NULL AND status='interrupted') LIMIT 1";
export class DataFenceBusy extends Error {
  readonly statusCode = 409;
  constructor() {
    super("configuration_maintenance_busy");
  }
}
function conflict(message: string): Error {
  return Object.assign(Error(message), { statusCode: 409 });
}
function forbidden(message: string): Error {
  return Object.assign(Error(message), { statusCode: 403 });
}
function receiptOf(row: FenceRow): DataConfigurationFenceReceipt {
  const { serviceIds: _serviceIds, coordinatorMode: _coordinatorMode, ...binding } = row.input;
  return {
    ...binding,
    fenceId: row.fence_id,
    sequence: row.state === "prepared" ? 0 : 1,
    state: row.state,
  };
}
declare const preparedGenerationBrand: unique symbol;
export type VerifiedPreparedGenerationAdmission = Readonly<{ [preparedGenerationBrand]: true }>;
const preparedGenerations = new WeakMap<
  VerifiedPreparedGenerationAdmission,
  {
    installation: ControlInstallation;
    request: ReturnType<typeof startGenerationHardlinksExecutionSchema.parse>;
    headers: readonly string[];
    principal: ControlTransportPrincipal;
    parent: VerifiedParentExecution;
    fenceDigest: string;
    execution: ReturnType<typeof inspectRemoteDelegation>["execution"];
  }
>();
export function createDataConfigurationFenceStore(
  installation: ControlInstallation,
  sql: DataFenceSql,
) {
  const local = installationState(installation);
  if (installation.role !== "data-manager" || local.fixedChildId)
    throw Error("Fixed DM fence receiver required");
  let open = false;
  async function lock(tx: Tx) {
    const rows = await tx.unsafe(
      "SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS held",
      [0x4f4d58, 2],
    );
    if (rows[0]?.held !== true) throw new DataFenceBusy();
  }
  async function row(tx: Tx, where: "maintenance_id" | "state", value: string) {
    // The primary key and the one-prepared index allow at most one row.
    const rows = await tx.unsafe(
      `SELECT * FROM data_manager.configuration_fence WHERE ${where}=$1`,
      [value],
    );
    return rows[0] ? fenceRowSchema.parse(rows[0]) : null;
  }
  function inspectDelegation(
    body: DataConfigurationFencePrepare,
    rawHeaders: readonly string[],
    transportPrincipal: ControlTransportPrincipal,
  ) {
    const kind = "configuration-maintenance.prepare";
    try {
      if (transportPrincipal !== "ops-agent") throw Error("Agent transport required");
      const delegation = inspectRemoteDelegation(installation, rawHeaders, transportPrincipal);
      const operation = { kind, ...body };
      if (
        delegation.parent.executor !== "ops-agent" ||
        delegation.kind !== kind ||
        delegation.phase !== "configuration-fence" ||
        controlDigest(delegation.parent) !== controlDigest(body.ownerPrepare) ||
        controlDigest(delegation.owner) !== controlDigest(body.ownerPrepare) ||
        delegation.execution.operationFingerprint !== controlDigest(operation) ||
        delegation.execution.fingerprint !==
          executionFingerprint({
            kind,
            operationFingerprint: controlDigest(operation),
            deadlineAt: delegation.execution.deadlineAt,
            parent: retainedControlParent(delegation.parent),
          }) ||
        canonicalJson(delegation.serviceIds) !== canonicalJson(body.serviceIds)
      )
        throw Error("Configuration fence delegation identity conflict");
      return { delegation, operation };
    } catch {
      // Classify verification failures before any fence SQL.
      throw forbidden("Agent configuration fence delegation rejected");
    }
  }
  /** Writes the leaf's own terminal effect record. */
  function recordLeaf(
    authority: VerifiedExecutionAuthority,
    outcome: "committed" | "failed_without_effect",
    receipt: unknown,
  ) {
    const state = executionAuthorityState(authority),
      effect = {
        identity: state.execution,
        outcome,
        publication: outcome === "committed" ? "committed" : "not_started",
        terminalReceiptDigest: controlDigest(receipt),
        receipt,
      };
    withPrivateEffectWriter(state, () => {
      settleExecutionLifecycle(state);
      writePrivateRecord(local, "effects", `${state.execution.operationKey}.json`, effect, false);
    });
  }
  /** Records the agent's fence leaf as this receiver's execution and runs the
   * fence transition once. A repeated request returns the recorded result. */
  async function withLeaf(
    verified: ReturnType<typeof inspectDelegation>,
    run: () => Promise<DataConfigurationFenceReceipt>,
  ): Promise<DataConfigurationFenceReceipt> {
    const { delegation } = verified;
    // The fence holds the whole application closure the agent leased.
    // Startup registers only the release's built-in services; installed
    // community-extension services are known to the agent alone.
    local.registeredTargets = new Set([...local.registeredTargets, ...delegation.serviceIds]);
    let authority: VerifiedExecutionAuthority | undefined;
    try {
      authority = restoreAdmittedControlExecution(installation, delegation.execution);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!authority) {
      if (Date.now() >= delegation.execution.deadlineAt) throw new DataFenceBusy();
      authority = retainAdmittedControlExecution(installation, {
        execution: delegation.execution,
        kind: delegation.kind,
        operation: verified.operation,
        admittedAt: Date.now(),
        requestedDeadlineAt: delegation.execution.deadlineAt,
        parent: delegation.verifiedParent,
        serviceIds: delegation.serviceIds,
      });
    }
    let prior: unknown;
    try {
      prior = readPrivateRecord(local, "effects", `${delegation.execution.operationKey}.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (prior !== undefined && prior !== null) {
      const settled = childSettlementState(
        verifyControlEffectSettlement(installation, delegation.execution),
      ).evidence;
      if (settled.outcome !== "committed") throw new DataFenceBusy();
      const saved = await row(sql, "maintenance_id", verified.operation.maintenanceId);
      if (!saved) throw new DataFenceBusy();
      return receiptOf(saved);
    }
    beginControlEffect(authority);
    let receipt: DataConfigurationFenceReceipt;
    try {
      receipt = await run();
    } catch (error) {
      // A busy refusal made no write: the leaf failed without effect.
      if (error instanceof DataFenceBusy)
        recordLeaf(authority, "failed_without_effect", {
          kind: "data-configuration-fence-refused",
          maintenanceId: verified.operation.maintenanceId,
          reason: "busy",
        });
      throw error;
    }
    recordLeaf(authority, "committed", {
      kind: "data-configuration-fence",
      receipt: { ...receipt, sequence: 0, state: "prepared" },
    });
    return receipt;
  }
  async function assertAdmission(tx: Tx) {
    if (!open) throw new DataFenceBusy();
    if (await row(tx, "state", "prepared")) throw new DataFenceBusy();
    if ((await tx.unsafe(UNKNOWN_DATA_JOB)).length) throw new DataFenceBusy();
  }
  async function inspectGenerationAdmission(
    value: unknown,
    rawHeaders: readonly string[],
    principal: ControlTransportPrincipal,
    tx: Tx,
  ) {
    const request = startGenerationHardlinksExecutionSchema.parse(value);
    let delegation: ReturnType<typeof inspectRemoteDelegation>;
    try {
      delegation = inspectRemoteDelegation(installation, rawHeaders, principal);
    } catch {
      throw forbidden("Generation delegation required");
    }
    if (
      delegation.kind !== "generation-hardlinks" ||
      delegation.phase !== "hardlinks" ||
      delegation.execution.operationKey !== request.operationKey ||
      delegation.execution.operationFingerprint !== controlDigest(request.input) ||
      request.input.planDigest !== controlDigest(request.plan) ||
      request.plan.plan.some((entry) => !delegation.serviceIds.includes(entry.consumerService))
    )
      throw forbidden("Generation plan/delegation binding conflict");
    if (!open) throw new DataFenceBusy();
    const fence = await row(tx, "state", "prepared");
    if (!fence) return;
    const receipt = receiptOf(fence);
    // During maintenance only the maintenance owner's own hardlink leaf runs:
    // the agent issued it under the maintenance owner the fence was prepared for.
    if (
      principal !== "ops-agent" ||
      canonicalJson(delegation.owner) !== canonicalJson(receipt.ownerPrepare) ||
      request.input.revisionId !== receipt.revisionId ||
      request.input.planDigest !== receipt.hardlinkPlanDigest ||
      request.input.coordinatorMode !== fence.input.coordinatorMode ||
      delegation.serviceIds.some((id) => !fence.input.serviceIds.includes(id))
    )
      throw forbidden("Generation maintenance owner/revision/hash conflict");
    if ((await tx.unsafe(UNKNOWN_DATA_JOB)).length) throw new DataFenceBusy();
    return { request, delegation, fenceDigest: controlDigest(fence) };
  }
  return {
    /** Whether the original expired preparation was ever admitted, observed
     * under the admission lock. An expired preparation can no longer be
     * admitted, so a negative answer stays true. */
    async recoverUnadmittedPreparation(
      value: unknown,
      rawHeaders: readonly string[],
      transportPrincipal: ControlTransportPrincipal,
    ) {
      const input = dataConfigurationFencePrepareSchema.parse(value);
      const { delegation } = inspectDelegation(input, rawHeaders, transportPrincipal);
      if (Date.now() <= Math.max(delegation.execution.deadlineAt, delegation.owner.deadlineAt))
        throw conflict("Original configuration preparation has not expired");
      return sql.transaction(async (tx) => {
        await lock(tx);
        const admitted = await tx.unsafe(
          "SELECT maintenance_id FROM data_manager.configuration_fence WHERE operation_key=$1 OR fence_id=$2::uuid OR maintenance_id=$3::uuid UNION ALL SELECT id FROM data_manager.jobs WHERE operation_key=$1 OR id=$2::uuid LIMIT 1",
          [
            delegation.execution.operationKey,
            delegation.execution.executionId,
            input.maintenanceId,
          ],
        );
        if (admitted.length) throw conflict("Original configuration preparation was admitted");
        // Any private trace of the execution means it may have been admitted.
        for (const namespace of ["executions", "effects", "effect-started"]) {
          try {
            readPrivateRecord(local, namespace, `${delegation.execution.operationKey}.json`);
            throw conflict("Original configuration preparation was admitted");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        return {
          version: 2 as const,
          kind: "configuration-prepare-not-admitted" as const,
          leaseId: delegation.leaseId,
          delegationId: delegation.delegationId,
          child: delegation.execution,
          input,
          observedAt: Date.now(),
        };
      });
    },
    /** Admission opens once the fence table is readable. */
    async startup() {
      open = false;
      await sql.unsafe("SELECT 1 FROM data_manager.configuration_fence LIMIT 1");
      open = true;
    },
    assertAdmission,
    async assertGenerationAdmission(
      value: unknown,
      rawHeaders: readonly string[],
      principal: ControlTransportPrincipal,
      parent?: VerifiedParentExecution,
    ): Promise<VerifiedPreparedGenerationAdmission | undefined> {
      const checked = await inspectGenerationAdmission(value, rawHeaders, principal, sql);
      if (!checked) return undefined;
      if (!parent) throw new DataFenceBusy();
      const proof = Object.freeze({}) as VerifiedPreparedGenerationAdmission;
      preparedGenerations.set(proof, {
        installation,
        request: checked.request,
        headers: Object.freeze([...rawHeaders]),
        principal,
        parent,
        fenceDigest: checked.fenceDigest,
        execution: checked.delegation.execution,
      });
      return proof;
    },
    async assertPreparedGenerationAdmission(
      tx: Tx,
      proof: VerifiedPreparedGenerationAdmission,
      input: unknown,
      admission: {
        operationKey: string;
        requestedDeadlineAt?: number;
        parent?: VerifiedParentExecution;
        id?: string;
        principal?: string;
      },
    ): Promise<void> {
      const source = preparedGenerations.get(proof);
      if (
        !source ||
        source.installation !== installation ||
        source.parent !== admission.parent ||
        canonicalJson(input) !== canonicalJson(source.request.input) ||
        admission.operationKey !== source.request.operationKey ||
        admission.requestedDeadlineAt !== source.request.requestedDeadlineAt ||
        admission.id !== source.execution.executionId ||
        admission.principal !== source.execution.principal
      )
        throw new DataFenceBusy();
      const checked = await inspectGenerationAdmission(
        source.request,
        source.headers,
        source.principal,
        tx,
      );
      if (
        !checked ||
        checked.fenceDigest !== source.fenceDigest ||
        canonicalJson(checked.delegation.execution) !== canonicalJson(source.execution)
      )
        throw new DataFenceBusy();
    },
    async withAdmission<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
      return sql.transaction(async (tx) => {
        await lock(tx);
        await assertAdmission(tx);
        return run(tx);
      });
    },
    /** Same body returns the recorded receipt; another body for the same
     * maintenance is a conflict; unfinished or unknown data jobs refuse. */
    async prepare(
      value: DataConfigurationFencePrepare,
      rawHeaders: readonly string[],
      transportPrincipal: ControlTransportPrincipal,
    ) {
      const input = dataConfigurationFencePrepareSchema.parse(value),
        verified = inspectDelegation(input, rawHeaders, transportPrincipal),
        execution = verified.delegation.execution,
        assertSame = (existing: FenceRow) => {
          if (
            canonicalJson(existing.input) !== canonicalJson(input) ||
            existing.fence_id !== execution.executionId ||
            existing.operation_key !== execution.operationKey
          )
            throw conflict("Configuration fence conflict");
        },
        existing = await row(sql, "maintenance_id", input.maintenanceId);
      if (existing) assertSame(existing);
      return withLeaf(verified, () =>
        sql.transaction(async (tx) => {
          await lock(tx);
          const current = await row(tx, "maintenance_id", input.maintenanceId);
          if (current) {
            assertSame(current);
            return receiptOf(current);
          }
          await assertAdmission(tx);
          const active = await tx.unsafe(
            "SELECT id FROM data_manager.jobs WHERE finished_at IS NULL OR execution_state->>'publication'='unknown' LIMIT 1",
          );
          const transfers = await tx.unsafe(
            "SELECT id FROM data_manager.offline_package_jobs WHERE status='preparing' LIMIT 1",
          );
          if (active.length || transfers.length) throw new DataFenceBusy();
          const inserted = await tx.unsafe(
            "INSERT INTO data_manager.configuration_fence(maintenance_id,fence_id,operation_key,candidate_id,plan_digest,input,state) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::text::jsonb,'prepared') RETURNING *",
            [
              input.maintenanceId,
              execution.executionId,
              execution.operationKey,
              input.candidateId,
              input.planDigest,
              canonicalJson(input),
            ],
          );
          return receiptOf(fenceRowSchema.parse(inserted[0]));
        }),
      );
    },
    /** The fence row of `maintenanceId`, for the agent only. */
    async inspect(
      maintenanceId: string,
      expected: { candidateId: string },
      transportPrincipal: ControlTransportPrincipal,
    ) {
      if (transportPrincipal !== "ops-agent") throw forbidden("Agent transport required");
      const saved = await row(sql, "maintenance_id", maintenanceId);
      if (!saved) return null;
      if (saved.candidate_id !== expected.candidateId)
        throw Error("Configuration fence owner changed");
      return receiptOf(saved);
    },
    /** Settles the prepared row once. The header is the agent's original
     * prepare delegation; a repeated settle with the same outcome returns the
     * settled receipt, another outcome is a conflict. The host CLI's token
     * settles without a delegation: that is the operator resolving the
     * maintenance with `openmapx control resolve`. */
    async settle(
      value: DataConfigurationFenceSettle,
      rawHeaders: readonly string[],
      transportPrincipal: ControlTransportPrincipal,
    ) {
      const input = dataConfigurationFenceSettleSchema.parse(value);
      let execution: z.infer<typeof fenceRowSchema>["input"]["ownerPrepare"] | undefined;
      if (transportPrincipal !== "host-cli")
        try {
          if (transportPrincipal !== "ops-agent") throw Error("Agent transport required");
          const delegation = inspectRemoteDelegation(installation, rawHeaders, transportPrincipal);
          if (
            delegation.parent.executor !== "ops-agent" ||
            delegation.kind !== "configuration-maintenance.prepare" ||
            delegation.phase !== "configuration-fence"
          )
            throw Error("Configuration fence delegation identity conflict");
          execution = delegation.execution;
        } catch {
          throw forbidden("Agent configuration fence delegation rejected");
        }
      // The conditional UPDATE and its read-back are the guard: a racing data
      // admission sees the row either prepared (busy) or settled (open).
      return sql.transaction(async (tx) => {
        const saved = await row(tx, "maintenance_id", input.maintenanceId);
        if (!saved)
          throw Object.assign(Error("Configuration maintenance identity is unknown"), {
            statusCode: 404,
          });
        if (
          execution &&
          (saved.fence_id !== execution.executionId ||
            saved.operation_key !== execution.operationKey)
        )
          throw forbidden("Configuration fence delegation identity conflict");
        if (saved.candidate_id !== input.candidateId || saved.plan_digest !== input.planDigest)
          throw conflict("Configuration fence settlement conflict");
        await tx.unsafe(
          "UPDATE data_manager.configuration_fence SET state='settled',outcome=$2,settled_at=now() WHERE maintenance_id=$1::uuid AND state='prepared'",
          [input.maintenanceId, input.outcome],
        );
        const settled = await row(tx, "maintenance_id", input.maintenanceId);
        if (settled?.state !== "settled" || settled.outcome !== input.outcome)
          throw conflict("Configuration fence was settled with another outcome");
        return receiptOf(settled);
      });
    },
  };
}
