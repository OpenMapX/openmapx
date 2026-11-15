/** The data-manager's configuration fence: one row in
 * `data_manager.configuration_fence`. While a row is `prepared`, no data job
 * is admitted. The agent prepares and settles it with its signed delegation;
 * both calls are idempotent on the same body. */
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { executionFingerprint, type VerifiedParentExecution } from "../ops/execution-identity";
import type { ExecutionRef } from "../ops/execution-ref";
import {
  type DataConfigurationFencePrepare,
  type DataConfigurationFenceReceipt,
  type DataConfigurationFenceSettle,
  dataConfigurationFenceOutcomeSchema,
  dataConfigurationFencePrepareSchema,
  dataConfigurationFenceSettleSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import {
  GENERATION_HARDLINKS_NON_ADMISSION_DOMAIN,
  startGenerationHardlinksExecutionSchema,
} from "../services/data-manager/contracts/executions";
import {
  beginControlEffect,
  type ControlInstallation,
  type ControlTransportPrincipal,
  childSettlementState,
  controlDigest,
  controlHeaders,
  executionAuthorityState,
  installationState,
  readPrivateRecord,
  reserveControlTerminal,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainedControlParent,
  settleExecutionLifecycle,
  type VerifiedExecutionAuthority,
  verifyConfigurationMaintenanceGenerationWitness,
  verifyControlEffectSettlement,
  verifyControlPeer,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "./control-authority";
import { signControl, verifyControl } from "./control-records";
import { verifiedParentForArtifactDelegation } from "./peer-admission";
import {
  adoptArtifactTargetLease,
  assertArtifactDelegationRootHeld,
  assertArtifactTargetLeaseForward,
  bindBorrowedControlExecution,
  closeArtifactTargetLeaseHandle,
  inspectArtifactDelegation,
  observeUnadoptedServiceHardlinkGrant,
  settleArtifactTargetLeaseChild,
  settleUnadmittedConfigurationPrepare,
  withConfigurationFenceReceiverAdmission,
} from "./target-lease";

export interface DataFenceSql {
  unsafe(
    query: string,
    parameters?: (string | number | null)[],
  ): Promise<readonly Record<string, unknown>[]>;
  transaction<T>(run: (tx: Pick<DataFenceSql, "unsafe">) => Promise<T>): Promise<T>;
}
type Tx = Pick<DataFenceSql, "unsafe">;
const inspectWitnessSchema = z.strictObject({
  installationId: z.uuid(),
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  ownerCertificateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});
const fenceRowSchema = z.object({
  maintenance_id: z.uuid(),
  fence_id: z.uuid(),
  operation_key: z.string(),
  candidate_id: z.uuid(),
  plan_digest: z.string(),
  owner_certificate_digest: z.string(),
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
    parent: VerifiedParentExecution;
    fenceDigest: string;
    execution: ReturnType<typeof inspectArtifactDelegation>["execution"];
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
  function inspectGrant(
    body: DataConfigurationFencePrepare,
    rawHeaders: readonly string[],
    transportPrincipal: Exclude<ControlTransportPrincipal, "data-manager">,
  ) {
    const kind = "configuration-maintenance.prepare";
    try {
      const headers = controlHeaders(rawHeaders);
      if (!headers.delegation || headers.parent) throw Error("Pinned agent fence grant required");
      const grant = inspectArtifactDelegation({
        dataRoot: local.dataRoot,
        assertion: headers.delegation,
        installation,
      });
      const operation = { kind, ...body };
      if (
        grant.recipient !== "data-manager" ||
        grant.parent.executor !== "ops-agent" ||
        grant.kind !== kind ||
        grant.phase !== "configuration-fence" ||
        controlDigest(grant.parent) !== controlDigest(body.ownerPrepare) ||
        grant.execution.operationFingerprint !== controlDigest(operation) ||
        grant.execution.executor !== "data-manager" ||
        grant.execution.fingerprint !==
          executionFingerprint({
            kind,
            operationFingerprint: controlDigest(operation),
            deadlineAt: grant.execution.deadlineAt,
            parent: retainedControlParent(grant.parent),
          }) ||
        canonicalJson(grant.serviceIds) !== canonicalJson(body.serviceIds)
      )
        throw Error("Configuration fence grant identity conflict");
      const peer = verifyControlPeer(installation, {
        rawHeaders,
        transportPrincipal,
        execution: grant.execution,
        kind,
      });
      return {
        grant,
        peer,
        operation,
        parent: verifiedParentForArtifactDelegation(
          installation,
          headers.delegation,
          grant.execution,
        ),
        assertion: headers.delegation,
      };
    } catch {
      // Classify verification failures before any fence SQL or adoption.
      throw forbidden("Pinned agent configuration fence grant rejected");
    }
  }
  /** Writes the leaf's terminal effect and settles it in the agent's lease, so
   * the agent can release its root once every child is known. */
  async function settleLeaf(
    lease: Awaited<ReturnType<typeof adoptArtifactTargetLease>>,
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
      writePrivateRecord(
        local,
        "effects",
        `${state.execution.operationKey}.json`,
        signControl(local.privateKey, "openmapx-control-settlement-v1", effect),
        false,
      );
    });
    await settleArtifactTargetLeaseChild(
      lease,
      verifyControlEffectSettlement(installation, state.execution),
    );
  }
  /** Adopts the agent's delegation as this receiver's leaf execution and runs
   * the fence transition once. A repeated request returns the recorded result. */
  async function withLeaf(
    verified: ReturnType<typeof inspectGrant>,
    run: () => Promise<DataConfigurationFenceReceipt>,
  ): Promise<DataConfigurationFenceReceipt> {
    const { grant, peer } = verified;
    const lease = await adoptArtifactTargetLease({
      dataRoot: local.dataRoot,
      assertion: verified.assertion,
      peer,
      execution: grant.execution,
      serviceIds: grant.serviceIds,
    });
    // The fence holds the whole application closure the agent signed into
    // the lease. Startup registers only the release's built-in services;
    // installed community-extension services are known to the agent alone.
    local.registeredTargets = new Set([...local.registeredTargets, ...lease.serviceIds]);
    try {
      const authority = withConfigurationFenceReceiverAdmission(lease, () => {
        let admitted: VerifiedExecutionAuthority | undefined;
        try {
          admitted = restoreAdmittedControlExecution(installation, grant.execution);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!admitted) {
          assertArtifactTargetLeaseForward(lease);
          admitted = retainAdmittedControlExecution(installation, {
            execution: grant.execution,
            kind: grant.kind,
            operation: verified.operation,
            admittedAt: Date.now(),
            requestedDeadlineAt: grant.execution.deadlineAt,
            parent: verified.parent,
            serviceIds: grant.serviceIds,
          });
        }
        bindBorrowedControlExecution(lease, admitted);
        return admitted;
      });
      let prior: unknown;
      try {
        prior = readPrivateRecord(local, "effects", `${grant.execution.operationKey}.json`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (prior !== undefined && prior !== null) {
        const settlement = verifyControlEffectSettlement(installation, grant.execution);
        // A crash between the effect record and the lease child leaves the
        // child unsettled; settling it again is idempotent.
        await settleArtifactTargetLeaseChild(lease, settlement);
        const settled = childSettlementState(settlement).evidence;
        if (settled.outcome !== "committed") throw new DataFenceBusy();
        const saved = await row(sql, "maintenance_id", verified.operation.maintenanceId);
        if (!saved) throw new DataFenceBusy();
        return receiptOf(saved);
      }
      reserveControlTerminal(authority);
      assertArtifactTargetLeaseForward(lease);
      beginControlEffect(authority);
      let receipt: DataConfigurationFenceReceipt;
      try {
        receipt = await run();
      } catch (error) {
        // A busy refusal made no write: settle this leaf as failed without effect.
        if (error instanceof DataFenceBusy)
          await settleLeaf(lease, authority, "failed_without_effect", {
            kind: "data-configuration-fence-refused",
            maintenanceId: verified.operation.maintenanceId,
            reason: "busy",
          });
        throw error;
      }
      await settleLeaf(lease, authority, "committed", {
        kind: "data-configuration-fence",
        receipt: { ...receipt, sequence: 0, state: "prepared" },
      });
      return receipt;
    } finally {
      closeArtifactTargetLeaseHandle(lease);
    }
  }
  async function assertAdmission(tx: Tx) {
    if (!open) throw new DataFenceBusy();
    if (await row(tx, "state", "prepared")) throw new DataFenceBusy();
    if ((await tx.unsafe(UNKNOWN_DATA_JOB)).length) throw new DataFenceBusy();
  }
  async function inspectGenerationAdmission(
    value: unknown,
    rawHeaders: readonly string[],
    parent: VerifiedParentExecution | undefined,
    tx: Tx,
  ) {
    const request = startGenerationHardlinksExecutionSchema.parse(value),
      headers = controlHeaders(rawHeaders);
    if (!headers.delegation || headers.parent) throw forbidden("Signed generation grant required");
    const grant = inspectArtifactDelegation({
      dataRoot: local.dataRoot,
      assertion: headers.delegation,
      installation,
    });
    if (
      grant.recipient !== "data-manager" ||
      grant.kind !== "generation-hardlinks" ||
      grant.phase !== "hardlinks" ||
      grant.execution.operationKey !== request.operationKey ||
      grant.execution.operationFingerprint !== controlDigest(request.input) ||
      request.input.planDigest !== controlDigest(request.plan) ||
      request.plan.plan.some((entry) => !grant.serviceIds.includes(entry.consumerService))
    )
      throw forbidden("Generation plan/grant binding conflict");
    if (!open) throw new DataFenceBusy();
    const fence = await row(tx, "state", "prepared");
    if (!fence) return;
    const receipt = receiptOf(fence);
    if (
      grant.ownerCertificateDigest !== fence.owner_certificate_digest ||
      canonicalJson(grant.owner) !== canonicalJson(receipt.ownerPrepare) ||
      grant.owner.executor !== "ops-agent" ||
      request.input.revisionId !== receipt.revisionId ||
      request.input.planDigest !== receipt.hardlinkPlanDigest ||
      request.input.coordinatorMode !== fence.input.coordinatorMode ||
      grant.serviceIds.some((id) => !fence.input.serviceIds.includes(id))
    )
      throw forbidden("Generation maintenance owner/revision/hash conflict");
    if (!parent) throw new DataFenceBusy();
    try {
      verifyConfigurationMaintenanceGenerationWitness(installation, request, parent, grant, {
        maintenanceId: receipt.maintenanceId,
        candidateId: receipt.candidateId,
        ownerPrepare: receipt.ownerPrepare,
        revisionId: receipt.revisionId,
        hardlinkPlanDigest: receipt.hardlinkPlanDigest!,
        coordinatorMode: fence.input.coordinatorMode,
        serviceIds: fence.input.serviceIds,
        rootCertificateDigest: fence.owner_certificate_digest,
      });
    } catch {
      throw new DataFenceBusy();
    }
    if ((await tx.unsafe(UNKNOWN_DATA_JOB)).length) throw new DataFenceBusy();
    return { request, grant, fenceDigest: controlDigest(fence) };
  }
  return {
    /** Negative receiver observation under the same admission lock. It cannot
     * admit or replay the original expired preparation. */
    async recoverUnadmittedPreparation(value: unknown, rawHeaders: readonly string[]) {
      const input = dataConfigurationFencePrepareSchema.parse(value),
        headers = controlHeaders(rawHeaders);
      if (!headers.delegation || headers.parent)
        throw forbidden("Original signed configuration delegation required");
      const grant = inspectArtifactDelegation({
        dataRoot: local.dataRoot,
        installation,
        assertion: headers.delegation,
      });
      return sql.transaction(async (tx) => {
        await lock(tx);
        const admitted = await tx.unsafe(
          "SELECT maintenance_id FROM data_manager.configuration_fence WHERE operation_key=$1 OR fence_id=$2::uuid OR maintenance_id=$3::uuid UNION ALL SELECT id FROM data_manager.jobs WHERE operation_key=$1 OR id=$2::uuid LIMIT 1",
          [grant.execution.operationKey, grant.execution.executionId, input.maintenanceId],
        );
        if (admitted.length) throw conflict("Original configuration preparation was admitted");
        return settleUnadmittedConfigurationPrepare(installation, headers.delegation!, input);
      });
    },
    /** A fixed receiver observes its own locked SQL and private admission facts.
     * The bearer, an HTTP 404, or an owner assertion alone is never this proof. */
    async attestUnadoptedGenerationHardlinks(value: unknown, rawHeaders: readonly string[]) {
      const request = startGenerationHardlinksExecutionSchema.parse(value),
        headers = controlHeaders(rawHeaders);
      if (!headers.delegation || headers.parent)
        throw forbidden("Original signed delegation required");
      const observe = () => observeUnadoptedServiceHardlinkGrant(installation, headers.delegation!);
      const original = observe();
      if (
        request.operationKey !== original.child.operationKey ||
        request.requestedDeadlineAt !== original.child.deadlineAt ||
        controlDigest(request.input) !== original.child.operationFingerprint ||
        request.input.planDigest !== controlDigest(request.plan)
      )
        throw Error("Original hardlink request changed");
      return sql.transaction(async (tx) => {
        await lock(tx);
        const admitted = await tx.unsafe(
          "SELECT id FROM data_manager.jobs WHERE operation_key=$1 OR id=$2 LIMIT 1",
          [original.child.operationKey, original.child.executionId],
        );
        if (admitted.length) throw conflict("Original hardlink execution was already admitted");
        for (const [namespace, name] of [
          ["executions", `${original.child.operationKey}.json`],
          ["adoptions", `${original.delegationId}.json`],
        ] as const) {
          try {
            readPrivateRecord(local, namespace, name);
            throw Error("Original receiver admission or adoption requires recovery");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (canonicalJson(observe()) !== canonicalJson(original))
          throw Error("Original canceled grant changed during observation");
        return signControl(local.privateKey, GENERATION_HARDLINKS_NON_ADMISSION_DOMAIN, original);
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
      parent?: VerifiedParentExecution,
    ): Promise<VerifiedPreparedGenerationAdmission | undefined> {
      const checked = await inspectGenerationAdmission(value, rawHeaders, parent, sql);
      if (!checked) return undefined;
      const proof = Object.freeze({}) as VerifiedPreparedGenerationAdmission;
      preparedGenerations.set(proof, {
        installation,
        request: checked.request,
        headers: Object.freeze([...rawHeaders]),
        parent: parent!,
        fenceDigest: checked.fenceDigest,
        execution: checked.grant.execution,
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
        source.parent,
        tx,
      );
      if (
        !checked ||
        checked.fenceDigest !== source.fenceDigest ||
        canonicalJson(checked.grant.execution) !== canonicalJson(source.execution)
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
      transportPrincipal: Exclude<ControlTransportPrincipal, "data-manager">,
    ) {
      const input = dataConfigurationFencePrepareSchema.parse(value),
        verified = inspectGrant(input, rawHeaders, transportPrincipal),
        execution = verified.grant.execution,
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
            "INSERT INTO data_manager.configuration_fence(maintenance_id,fence_id,operation_key,candidate_id,plan_digest,owner_certificate_digest,input,state) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7::text::jsonb,'prepared') RETURNING *",
            [
              input.maintenanceId,
              execution.executionId,
              execution.operationKey,
              input.candidateId,
              input.planDigest,
              verified.grant.ownerCertificateDigest,
              canonicalJson(input),
            ],
          );
          return receiptOf(fenceRowSchema.parse(inserted[0]));
        }),
      );
    },
    async inspect(maintenanceId: string, rawHeaders: readonly string[]) {
      const index = rawHeaders.findIndex(
          (name, i) =>
            i % 2 === 0 && name.toLowerCase() === "x-openmapx-configuration-fence-witness",
        ),
        encoded = rawHeaders[index + 1];
      if (
        index < 0 ||
        rawHeaders.some(
          (name, i) =>
            i !== index &&
            i % 2 === 0 &&
            name.toLowerCase() === "x-openmapx-configuration-fence-witness",
        )
      )
        throw Error("Purpose-bound agent fence witness required");
      if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded))
        throw Error("Invalid fence witness");
      const witness = verifyControl(
          local.publicKeys["ops-agent"],
          "openmapx-configuration-fence-inspect-v1",
          JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
          inspectWitnessSchema,
        ),
        now = Date.now();
      if (
        witness.installationId !== installation.installationId ||
        witness.maintenanceId !== maintenanceId ||
        witness.issuedAt > now ||
        witness.expiresAt <= now ||
        witness.expiresAt - witness.issuedAt > 15000
      )
        throw Error("Expired or foreign fence witness");
      const saved = await row(sql, "maintenance_id", maintenanceId);
      if (!saved) return null;
      if (
        saved.candidate_id !== witness.candidateId ||
        saved.owner_certificate_digest !== witness.ownerCertificateDigest
      )
        throw Error("Configuration fence owner changed");
      return receiptOf(saved);
    },
    /** Settles the prepared row once. The header is the agent's original
     * prepare delegation; a repeated settle with the same outcome returns the
     * settled receipt, another outcome is a conflict. */
    async settle(
      value: DataConfigurationFenceSettle,
      rawHeaders: readonly string[],
      transportPrincipal: Exclude<ControlTransportPrincipal, "data-manager">,
    ) {
      const input = dataConfigurationFenceSettleSchema.parse(value);
      let execution: ExecutionRef;
      try {
        const headers = controlHeaders(rawHeaders);
        if (transportPrincipal !== "ops-agent") throw Error("Agent transport required");
        if (!headers.delegation || headers.parent) throw Error("Prepare delegation required");
        const grant = inspectArtifactDelegation({
          dataRoot: local.dataRoot,
          assertion: headers.delegation,
          installation,
        });
        if (
          grant.recipient !== "data-manager" ||
          grant.parent.executor !== "ops-agent" ||
          grant.kind !== "configuration-maintenance.prepare" ||
          grant.phase !== "configuration-fence"
        )
          throw Error("Configuration fence grant identity conflict");
        // Only the owner that still holds the maintenance root may settle.
        assertArtifactDelegationRootHeld(installation, headers.delegation);
        execution = grant.execution;
      } catch {
        throw forbidden("Pinned agent configuration fence grant rejected");
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
          saved.fence_id !== execution.executionId ||
          saved.operation_key !== execution.operationKey
        )
          throw forbidden("Configuration fence grant identity conflict");
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
