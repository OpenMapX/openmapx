import {
  type ControlInstallation,
  cancelArtifactTargetLease,
  cancelControlExecution,
  closeArtifactTargetLeaseHandle,
  releaseArtifactTargetLease,
  restoreAdmittedControlExecution,
  restoreArtifactTargetLeaseForSettlement,
  retainControlEffectReceipt,
  settleArtifactTargetLeaseChild,
  verifyControlEffectSettlement,
} from "@openmapx/core/build-artifacts";
import { inspectArtifactPublication } from "@openmapx/core/build-artifacts/publication";
import { opsOperationFingerprint } from "@openmapx/core/ops";
import type { JobRunner } from "../job-run";
import { executionFor, type JobRecord, type JobTable } from "../job-table";
import type { OpsResourceClaimer } from "../policy";
import type { OpsRuntime } from "../runtime";
import {
  finishRestoredPreparedImport,
  inspectSettledImport,
  recoverPreparedImportFiles,
} from "./import-runtime";
import type { ArtifactTransferStore } from "./store";

/**
 * Recovery of artifact imports and validations the agent recorded: a prepared
 * import that did not publish is finished or contained from its files, a
 * released one reconciles its claim, and a claim inspection rejoins the job
 * that owns it. Unknown paths keep their fences.
 */
export function createImportRecovery(options: {
  table: JobTable;
  runner: JobRunner;
  runtime: OpsRuntime;
  installation: ControlInstallation;
  artifactTransfers: ArtifactTransferStore | undefined;
  resourceClaimer: OpsResourceClaimer;
  now: () => Date;
}) {
  const { table, installation, artifactTransfers } = options;
  const reconciling = new Map<string, Promise<void>>();

  const reconcile = (job: JobRecord): Promise<void> => {
    if (job.operation.kind !== "artifactTransfer.import" || job.state === "succeeded")
      return Promise.resolve();
    const prior = reconciling.get(job.operationId);
    if (prior) return prior;
    const pending = (async () => {
      try {
        const authority = restoreAdmittedControlExecution(installation, executionFor(job)),
          lease = restoreArtifactTargetLeaseForSettlement(authority);
        table.authorities.set(job.operationId, authority);
        table.leases.set(job.operationId, lease);
        const publication = inspectArtifactPublication(authority);
        if (publication?.phase !== "committed") {
          cancelControlExecution(authority);
          await cancelArtifactTargetLease(lease);
        }
        const signal = AbortSignal.timeout(30000),
          claim = await options.resourceClaimer.claim(
            job.operation,
            opsOperationFingerprint(job.operation),
            signal,
            { role: job.role, operationKey: job.operationKey },
          );
        if (!claim) throw Error("Original import source unavailable");
        const context = options.runner.contextFor(job, signal, claim),
          result = await recoverPreparedImportFiles(options.runtime, context);
        if (result) {
          retainControlEffectReceipt(authority, {
            outcome: result.outcome === "committed" ? "committed" : "contained",
            publication: result.outcome === "committed" ? "committed" : "not_started",
            receipt: { kind: "ops-result", result },
          });
          await settleArtifactTargetLeaseChild(
            lease,
            verifyControlEffectSettlement(installation, authority.execution),
          );
          await releaseArtifactTargetLease(lease);
          table.leases.delete(job.operationId);
          if (result.outcome === "not_committed")
            await finishRestoredPreparedImport(options.runtime, context);
          await table.transition(job, "succeeded", {
            result,
            errorClass: undefined,
            terminalAt: options.now().getTime(),
          });
          table.stickyRecoveryRequired.delete(job.operationId);
        }
      } catch {
        /* Unknown/foreign paths or the operator-owned configuration lock retain their original fences. */
      }
    })().finally(() => reconciling.delete(job.operationId));
    reconciling.set(job.operationId, pending);
    return pending;
  };

  /** A claim inspection for a recorded import or validation rejoins its job. */
  const inspectClaim = async (
    artifactTransfers: ArtifactTransferStore,
    operation: Parameters<ArtifactTransferStore["inspectClaim"]>[0],
  ) => {
    let found = await artifactTransfers.inspectClaim(operation);
    if (!found || !["import-build", "validate-build"].includes(found.claim.use)) return found;
    const job = table.byId.get(found.claim.identity.executionId);
    if (
      !job ||
      !["artifactTransfer.import", "artifactTransfer.validate"].includes(job.operation.kind) ||
      !("stageId" in job.operation) ||
      job.operation.stageId !== operation.stageId ||
      !("ownerId" in job.operation) ||
      job.operation.ownerId !== operation.ownerId ||
      job.fingerprint !== operation.identity.fingerprint ||
      job.operationKey !== operation.identity.operationKey ||
      new Date(job.deadlineAt).toISOString() !== operation.identity.executionDeadlineAt ||
      job.terminalAt === undefined
    )
      return found;
    if (job.operation.kind === "artifactTransfer.import") {
      await reconcile(job);
      found = await artifactTransfers.inspectClaim(operation);
      if (!found) return null;
    }
    try {
      const authority = restoreAdmittedControlExecution(installation, executionFor(job));
      if (
        job.operation.kind === "artifactTransfer.validate" &&
        found.claim.use === "validate-build"
      ) {
        const validation = await artifactTransfers.recoverPreparedValidation(authority);
        cancelControlExecution(authority);
        retainControlEffectReceipt(authority, {
          outcome: "committed",
          publication: "committed",
          receipt: { kind: "ops-result", result: validation },
        });
        table.stickyRecoveryRequired.delete(job.operationId);
        return { ...found, validation };
      }
      if (job.operation.kind !== "artifactTransfer.import" || found.claim.use !== "import-build")
        return found;
      const publication = await inspectSettledImport(
        options.runtime,
        authority,
        job.operation.expectedCurrentRevisionId,
      );
      return { ...found, publication };
    } catch {
      return found;
    }
  };
  if (artifactTransfers)
    options.runtime["artifactTransfer.inspectClaim"] = (operation) =>
      inspectClaim(artifactTransfers, operation);

  return {
    reconcile,
    /** A cancel of a terminal, unpublished import reaches its root and lease. */
    async cancelTerminal(job: JobRecord): Promise<void> {
      if (job.operation.kind !== "artifactTransfer.import" || job.state === "succeeded") return;
      let lease: ReturnType<typeof restoreArtifactTargetLeaseForSettlement> | undefined;
      try {
        const authority = restoreAdmittedControlExecution(installation, executionFor(job));
        lease = restoreArtifactTargetLeaseForSettlement(authority);
        cancelControlExecution(authority);
        await cancelArtifactTargetLease(lease);
      } catch {
        /* Released or unverifiable roots grant no new cancellation authority. */
      } finally {
        if (lease) closeArtifactTargetLeaseHandle(lease);
      }
    },
    /** A released import reconciles its prepared files' claim. */
    async reconcileReleased(job: JobRecord): Promise<void> {
      if (
        !artifactTransfers ||
        job.operation.kind !== "artifactTransfer.import" ||
        job.terminalAt === undefined
      )
        return;
      try {
        await artifactTransfers.reconcileReleasedPreparedImport(
          restoreAdmittedControlExecution(installation, executionFor(job)),
        );
      } catch {
        /* No conclusive nonissuance/root release; keep claim pinned. */
      }
    },
  };
}
