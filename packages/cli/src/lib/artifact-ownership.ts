/** Standalone host-CLI roots for the two fixed artifact operations. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import type { ArtifactPublicationResult, OpsOperation, OpsResultFor } from "@openmapx/core/ops";
import {
  createControlRootOperationKey,
  executionFingerprint,
  opsExecutionBudget,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { cliControlContext } from "./control-context";
import { cliAcquisitionOptions, cliProcessOptions } from "./execution-deadline";
import { repoPaths } from "./paths";

type ArtifactOperation = Extract<
  OpsOperation,
  { kind: "artifactTransfer.import" | "artifactTransfer.export" }
>;
export async function openCliArtifactOwner(operation: ArtifactOperation, rootDir?: string) {
  if (cliControlContext())
    throw Error("Artifact transfers require their standalone original host owner");
  const paths = repoPaths(rootDir),
    registry = new services.ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  const targets = registry
    .list()
    .map((service) => service.manifest.id)
    .sort();
  if (!existsSync("/run/secrets/openmapx-control-verifiers"))
    await control.provisionControlInstallation(paths.infraDir);
  const installation = control.openControlInstallation({
    infraDir: paths.infraDir,
    role: "host-cli",
    serviceIds: targets,
  });
  let lease: control.TargetLeaseAuthority | undefined;
  try {
    const admittedAt = Date.now(),
      budget =
        cliProcessOptions(opsExecutionBudget(operation.kind).processMs).timeout ??
        opsExecutionBudget(operation.kind).processMs,
      deadlineAt = admittedAt + budget,
      operationFingerprint = opsOperationFingerprint(operation),
      execution = {
        executor: "host-cli" as const,
        principal: "host-cli" as const,
        executionId: randomUUID(),
        operationKey: createControlRootOperationKey({
          notAfter: deadlineAt,
          nonce: randomBytes(16),
        }),
        operationFingerprint,
        deadlineAt,
        fingerprint: executionFingerprint({
          kind: operation.kind,
          operationFingerprint,
          deadlineAt,
        }),
      };
    const signal = AbortSignal.any([
      AbortSignal.timeout(budget),
      ...(cliAcquisitionOptions().signal ? [cliAcquisitionOptions().signal!] : []),
    ]);
    const hardlinks =
      operation.kind === "artifactTransfer.import" && operation.expectedCurrentRevisionId
        ? control.planGenerationHardlinksOwner({
            infraDir: paths.infraDir,
            parent: execution,
            revisionId: operation.expectedCurrentRevisionId,
            coordinatorMode: "require-running",
            serviceIds: targets,
          })
        : undefined;
    const authority = control.retainAdmittedControlExecution(installation, {
      execution,
      operation,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt: deadlineAt,
      serviceIds: targets,
      ...(hardlinks ? { reservations: hardlinks.reservation ? [hardlinks.reservation] : [] } : {}),
    });
    if (hardlinks) control.retainGenerationHardlinksOwnerPlan(authority, hardlinks);
    lease = await control.acquireArtifactTargetLease({
      dataRoot: join(paths.infraDir, "data"),
      serviceIds: targets,
      owner: authority,
      signal,
    });
    return { paths, authority, installation, lease, signal, hardlinks };
  } catch (error) {
    if (lease) control.closeArtifactTargetLeaseHandle(lease);
    control.closeControlInstallation(installation);
    throw error;
  }
}
/** Export reads managed targets; it publishes no managed files. The fixed
 * caller invokes this only after its external output stream has completed. */
export async function settleCliReadOnlyExport(owner: CliArtifactOwner) {
  if (control.executionAuthorityState(owner.authority).kind !== "artifactTransfer.export")
    throw Error("Original read-only export required");
  control.retainControlEffectReceipt(owner.authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  await control.settleArtifactTargetLeaseChild(
    owner.lease,
    control.verifyControlEffectSettlement(owner.installation, owner.authority.execution),
  );
  await control.releaseArtifactTargetLease(owner.lease);
}
export type CliArtifactOwner = Awaited<ReturnType<typeof openCliArtifactOwner>>;
export async function settleCliArtifactOwner(
  owner: CliArtifactOwner,
  result: ArtifactPublicationResult | OpsResultFor<"artifactTransfer.export">,
) {
  const notCommitted = "outcome" in result && result.outcome === "not_committed";
  control.retainControlEffectReceipt(owner.authority, {
    outcome: notCommitted ? "contained" : "committed",
    publication: notCommitted ? "not_started" : "committed",
    receipt: { kind: "ops-result", result },
  });
  await control.settleArtifactTargetLeaseChild(
    owner.lease,
    control.verifyControlEffectSettlement(owner.installation, owner.authority.execution),
  );
  await control.releaseArtifactTargetLease(owner.lease);
}
export function closeCliArtifactOwner(owner: CliArtifactOwner) {
  control.closeArtifactTargetLeaseHandle(owner.lease);
  control.closeControlInstallation(owner.installation);
}
