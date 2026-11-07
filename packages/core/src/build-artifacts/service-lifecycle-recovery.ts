import { join, resolve } from "node:path";
import { z } from "zod";
import { parseControlRootOperationKey } from "../ops/control-root-key";
import { executionRefSchema } from "../ops/execution-ref";
import {
  currentConfigurationGeneration,
  withConfigurationGenerationWriter,
} from "../services/configuration-generation";
import { recoverUnadmittedGenerationHardlinks } from "../services/data-manager/generated/data-manager.generated";
import {
  type DataManagerTransport,
  unwrapDataManagerResponse,
} from "../services/data-manager/transport";
import { readFailedServiceHardlinksReceipt } from "../services/service-lifecycle-receipt";
import { lookupControlChildPhaseAttempt } from "./child-phase";
import {
  type ControlInstallation,
  controlDigest,
  executionAuthorityState,
  installationState,
  readPrivateRecord,
  restoreAdmittedControlExecution,
  retainControlEffectReceipt,
  type VerifiedExecutionAuthority,
  verifyControlRecoveryAuthority,
} from "./control-authority";
import { readGenerationHardlinksOwnerPlan } from "./generation-hardlinks-owner";
import {
  closeArtifactTargetLeaseHandle,
  prepareFailedServiceLifecycleRecovery,
  reconcileArtifactTargetLease,
  restoreArtifactTargetLeaseForSettlement,
  revokeUnadoptedServiceHardlinks,
  verifyFailedServiceLifecycleContainment,
  verifyRetainedArtifactTargetRootRelease,
} from "./target-lease";

/** Recovery only: never issue, replay, render, pull or recreate. */
export async function reconcileFailedServiceLifecycle(options: {
  infraDir: string;
  authority: VerifiedExecutionAuthority;
  transport: DataManagerTransport;
}): Promise<void> {
  const { authority, infraDir } = options,
    owner = executionAuthorityState(authority);
  if (resolve(owner.installation.dataRoot) !== resolve(join(infraDir, "data")))
    throw Error("Original lifecycle installation required");
  if (Date.now() < owner.execution.deadlineAt) throw Error("Original lifecycle must be expired");
  await withConfigurationGenerationWriter(infraDir, async () => {
    const failure = readFailedServiceHardlinksReceipt(authority);
    let prior: ReturnType<typeof verifyFailedServiceLifecycleContainment> | undefined;
    try {
      const source = verifyFailedServiceLifecycleContainment(authority);
      prior = source;
    } catch {
      /* An initial attempt has no revocation/effect receipt yet. */
    }
    if (prior) {
      retainControlEffectReceipt(authority, {
        outcome: "contained",
        publication: "committed",
        receipt: {
          kind: "service-lifecycle-contained-failure",
          failedReceiptDigest: prior.failedReceiptDigest,
        },
      });
      if (
        (await reconcileArtifactTargetLease({
          dataRoot: owner.installation.dataRoot,
          leaseId: prior.leaseId,
          authority: verifyControlRecoveryAuthority(authority),
        })) !== "released"
      )
        throw Error("Original lifecycle remains fenced");
      verifyRetainedArtifactTargetRootRelease(authority);
      return;
    }
    if (currentConfigurationGeneration(infraDir) !== failure.finalRevisionId)
      throw Error("Committed lifecycle generation changed; supervised recovery required");
    const lease = restoreArtifactTargetLeaseForSettlement(authority);
    try {
      await prepareFailedServiceLifecycleRecovery(authority, lease);
      const plan = readGenerationHardlinksOwnerPlan(authority),
        attempt = lookupControlChildPhaseAttempt(authority, { phase: "hardlinks", ordinal: 0 });
      if (!attempt || attempt.channel !== "delegation")
        throw Error("Original hardlink outbox required");
      const nonAdmission = unwrapDataManagerResponse(
        await recoverUnadmittedGenerationHardlinks(
          {
            operationKey: attempt.execution.operationKey,
            requestedDeadlineAt: attempt.execution.deadlineAt,
            input: {
              kind: "generation-hardlinks",
              revisionId: plan.revisionId,
              coordinatorMode: plan.coordinatorMode,
              planDigest: controlDigest(plan.plan),
            },
            plan: plan.plan,
          },
          {
            transport: options.transport,
            headers: { "x-openmapx-control-delegation": attempt.assertion },
          },
        ),
      );
      await revokeUnadoptedServiceHardlinks(authority, lease, nonAdmission);
      retainControlEffectReceipt(authority, {
        outcome: "contained",
        publication: "committed",
        receipt: {
          kind: "service-lifecycle-contained-failure",
          failedReceiptDigest: controlDigest(failure),
        },
      });
      if (
        (await reconcileArtifactTargetLease({
          dataRoot: owner.installation.dataRoot,
          leaseId: lease.leaseId,
          authority: verifyControlRecoveryAuthority(authority),
        })) !== "released"
      )
        throw Error("Original lifecycle remains fenced");
      verifyRetainedArtifactTargetRootRelease(authority);
    } finally {
      closeArtifactTargetLeaseHandle(lease);
    }
  });
}

/** The operator supplies only a lookup key; authority always comes from the
 * original anchored, signed local execution, not from request identity fields. */
export async function recoverServiceLifecycleByKey(options: {
  infraDir: string;
  installation: ControlInstallation;
  operationKey: string;
  transport: DataManagerTransport;
}) {
  parseControlRootOperationKey(options.operationKey);
  const local = installationState(options.installation);
  if (options.installation.role !== "host-cli" || local.fixedChildId)
    throw Error("Recovery requires the installation host");
  const original = z
    .object({ payload: z.object({ execution: executionRefSchema }) })
    .parse(readPrivateRecord(local, "executions", `${options.operationKey}.json`));
  if (original.payload.execution.operationKey !== options.operationKey)
    throw Error("Original lifecycle lookup identity changed");
  const authority = restoreAdmittedControlExecution(
    options.installation,
    original.payload.execution,
  );
  await reconcileFailedServiceLifecycle({
    infraDir: options.infraDir,
    authority,
    transport: options.transport,
  });
  return {
    operationKey: options.operationKey,
    revisionId: readFailedServiceHardlinksReceipt(authority).finalRevisionId!,
  };
}
