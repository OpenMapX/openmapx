/** The data-manager's configuration fence: one row in
 * `data_manager.configuration_fence`. While a row is `prepared`, no data job
 * is admitted. Only the operations agent prepares and settles it, authenticated
 * by its own data-manager token; both calls are idempotent on the same body.
 * The agent records the fence leaf in its lease store and settles it from the
 * receipt this returns. */
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { executionFingerprint } from "../ops/execution-identity";
import { DATA_ADVISORY_LOCKS } from "../services/data-manager/advisory-locks";
import {
  type DataConfigurationFencePrepare,
  type DataConfigurationFencePrepareRequest,
  type DataConfigurationFenceReceipt,
  type DataConfigurationFenceSettleRequest,
  dataConfigurationFenceOutcomeSchema,
  dataConfigurationFencePrepareRequestSchema,
  dataConfigurationFencePrepareSchema,
  dataConfigurationFenceSettleRequestSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import { type ControlInstallation, controlDigest } from "./control-records";
import {
  beginControlEffect,
  type ControlDelegation,
  type ControlTransportPrincipal,
  childSettlementState,
  executionAuthorityState,
  inspectRemoteDelegation,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainedControlParent,
  settleExecutionLifecycle,
  type VerifiedExecutionAuthority,
  verifyControlEffectSettlement,
  withPrivateEffectWriter,
} from "./execution-record";
import { rootLeaseId } from "./lease-store";
import { installationState, readPrivateRecord, writePrivateRecord } from "./private-records";

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
/** Data jobs whose publication was not observed keep the data plane fenced. */
const UNKNOWN_DATA_JOB =
  "SELECT id FROM data_manager.jobs WHERE execution_state->>'publication'='unknown' LIMIT 1";
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
/** What the agent's store shows about the lease a hardlink plan's sender
 * names: `held` while that sender holds it live on data-manager, `unreadable`
 * when the agent did not answer. */
export type SenderLease = "held" | "not_held" | "unreadable";
export async function inspectSenderLease(
  installation: ControlInstallation,
  leaseId: string,
  sender: "ops-agent" | "host-cli",
): Promise<SenderLease> {
  const leases = installationState(installation).leases;
  let lease: Awaited<ReturnType<typeof leases.read>>;
  try {
    lease = await leases.read(leaseId);
  } catch {
    return "unreadable";
  }
  return lease?.state === "held" &&
    lease.owner.executor === sender &&
    lease.targets.includes("data-manager")
    ? "held"
    : "not_held";
}
export function createDataConfigurationFenceStore(
  installation: ControlInstallation,
  sql: DataFenceSql,
) {
  const local = installationState(installation);
  if (installation.role !== "data-manager" || local.fixedChildId)
    throw Error("Fixed DM fence receiver required");
  let open = false;
  async function lock(tx: Tx) {
    const rows = await tx.unsafe("SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS held", [
      ...DATA_ADVISORY_LOCKS.dataAdmission,
    ]);
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
    value: ControlDelegation,
    transportPrincipal: ControlTransportPrincipal,
  ) {
    const kind = "configuration-maintenance.prepare";
    try {
      if (transportPrincipal !== "ops-agent") throw Error("Agent transport required");
      const delegation = inspectRemoteDelegation(installation, value, transportPrincipal);
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
  /** A generation's hardlink plan sent with the sender's lease id. Outside a
   * maintenance it is admitted only under a lease the agent's store shows the
   * sender holding on data-manager. While a fence is prepared only the
   * maintenance's own plan runs: the agent sends it under the lease the
   * maintenance owner holds, for the revision and plan the fence names. */
  async function assertLinkAdmission(
    tx: Tx,
    input: { revisionId: string; planDigest: string; leaseId: string },
    sender: { caller: ControlTransportPrincipal; lease: SenderLease },
  ) {
    const { caller } = sender;
    if (caller !== "ops-agent" && caller !== "host-cli")
      throw forbidden("Only the agent or the host CLI links under its own lease");
    if (!open) throw new DataFenceBusy();
    const fence = await row(tx, "state", "prepared");
    if (fence) {
      const receipt = receiptOf(fence);
      if (
        caller !== "ops-agent" ||
        input.leaseId !== rootLeaseId(receipt.ownerPrepare) ||
        input.revisionId !== receipt.revisionId ||
        input.planDigest !== receipt.hardlinkPlanDigest
      )
        throw new DataFenceBusy();
    } else if (sender.lease === "unreadable")
      throw Object.assign(Error("The agent did not answer for the sender's lease"), {
        statusCode: 503,
      });
    else if (sender.lease !== "held")
      throw forbidden("The sender holds no live lease on data-manager under this id");
    if ((await tx.unsafe(UNKNOWN_DATA_JOB)).length) throw new DataFenceBusy();
  }
  return {
    /** Admission opens once the fence table is readable. */
    async startup() {
      open = false;
      await sql.unsafe("SELECT 1 FROM data_manager.configuration_fence LIMIT 1");
      open = true;
    },
    assertAdmission,
    assertLinkAdmission,
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
      value: DataConfigurationFencePrepareRequest,
      transportPrincipal: ControlTransportPrincipal,
    ) {
      const { delegation, ...input } = dataConfigurationFencePrepareRequestSchema.parse(value),
        verified = inspectDelegation(input, delegation, transportPrincipal),
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
    /** The fence row of `maintenanceId`, for the agent and for the operator's
     * `openmapx control resolve`. */
    async inspect(
      maintenanceId: string,
      expected: { candidateId: string },
      transportPrincipal: ControlTransportPrincipal,
    ) {
      if (transportPrincipal !== "ops-agent" && transportPrincipal !== "host-cli")
        throw forbidden("Agent or host CLI transport required");
      const saved = await row(sql, "maintenance_id", maintenanceId);
      if (!saved) return null;
      if (saved.candidate_id !== expected.candidateId)
        throw Error("Configuration fence owner changed");
      return receiptOf(saved);
    },
    /** Settles the prepared row once. The delegation is the agent's original
     * fence child; a repeated settle with the same outcome returns the
     * settled receipt, another outcome is a conflict. The host CLI's token
     * settles without a delegation: that is the operator resolving the
     * maintenance with `openmapx control resolve`. */
    async settle(
      value: DataConfigurationFenceSettleRequest,
      transportPrincipal: ControlTransportPrincipal,
    ) {
      const { delegation: named, ...input } =
        dataConfigurationFenceSettleRequestSchema.parse(value);
      let execution: z.infer<typeof fenceRowSchema>["input"]["ownerPrepare"] | undefined;
      if (transportPrincipal !== "host-cli")
        try {
          if (transportPrincipal !== "ops-agent" || !named)
            throw Error("Agent delegation required");
          const delegation = inspectRemoteDelegation(installation, named, transportPrincipal);
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
