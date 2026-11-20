import { join } from "node:path";
import {
  bindControlChildPhase,
  closeControlInstallation,
  consumeControlChildDispatch,
  type FixedServiceLifecyclePlan,
  fixedCliArguments,
  inspectLocalLeaseChildSettlement,
  issueControlChildPhase,
  openFixedChildInstallation,
  planFixedServiceUpdate,
  readFixedServiceLifecyclePlan,
  restoreAdmittedControlExecution,
  retainFixedCliSpawnIntent,
  type TargetLeaseAuthority,
  verifyControlEffectSettlement,
} from "@openmapx/core/build-artifacts";
import type { ExecutionRef, OpsOperation } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import type { FixedCliRunner } from "./administrative-runtime";
import { OpsExecutionFailure, OpsHostUpdateRequiredError, type OpsRuntime } from "./runtime";

const sources = new WeakMap<OpsRuntime, { infraDir: string }>();
export function prepareServiceUpdateAdmission(
  runtime: OpsRuntime,
  parent: ExecutionRef,
  operation: Extract<OpsOperation, { kind: "service.update" }>,
  serviceIds: readonly string[],
): FixedServiceLifecyclePlan {
  const source = sources.get(runtime);
  if (!source) throw Error("Production lifecycle source unavailable");
  return planFixedServiceUpdate({ ...source, parent, operation, serviceIds });
}
export function installServiceLifecycleRuntime(
  runtime: OpsRuntime,
  options: { rootDir: string; infraDir: string; runFixedCli: FixedCliRunner },
): void {
  sources.set(runtime, options);
  runtime["service.update"] = async (operation, context) => {
    const authority = context.controlAuthority,
      lease: TargetLeaseAuthority | undefined = context.artifactLease ?? context.ownedTargetLease;
    if (!authority || !lease) throw new OpsHostUpdateRequiredError();
    const plan = readFixedServiceLifecyclePlan(authority);
    const child = await bindControlChildPhase(authority, { phase: "lifecycle", ordinal: 0 });
    const args = fixedCliArguments(operation);
    await retainFixedCliSpawnIntent(authority, {
      childKey: plan.delegationId,
      execution: child.execution,
      operation,
      args,
      reservations: [],
    });
    const issued = await issueControlChildPhase(authority, {
      phase: "lifecycle",
      ordinal: 0,
      childKey: plan.delegationId,
      lease,
    });
    const fixedChild = { leaseId: lease.leaseId, childKey: issued.delegation.childKey };
    await services.withServiceLifecycleReceiptAuthority(
      authority,
      () =>
        services.openServiceLifecycleReceipt({
          dataRoot: join(options.infraDir, "data"),
          execution: child.execution,
          serviceIds: [operation.serviceId],
          action: "update",
          noDeps: operation.noDeps ?? false,
          coordinatorMode: "ensure-running",
          expectedRevisionId: operation.expectedConfigurationRevisionId,
          seedRevisionId: operation.expectedConfigurationRevisionId,
        }),
      { execution: child.execution, childKey: plan.delegationId },
    );
    await consumeControlChildDispatch(issued.dispatchTicket);
    let failure: unknown;
    try {
      await options.runFixedCli(args, {
        ...context,
        execution: child.execution,
        operationKind: "service.update",
        child: fixedChild,
      });
    } catch (error) {
      failure = error;
    }
    const installation = openFixedChildInstallation({
      infraDir: options.infraDir,
      child: fixedChild,
    });
    try {
      const childAuthority = await restoreAdmittedControlExecution(installation, child.execution);
      const receipt = await services.withServiceLifecycleReceiptAuthority(childAuthority, () =>
        services.readServiceLifecycleReceipt({
          dataRoot: join(options.infraDir, "data"),
          execution: child.execution,
        }),
      );
      const {
        version: _version,
        execution: _execution,
        serviceIds: _ids,
        action: _action,
        noDeps: _noDeps,
        coordinatorMode: _mode,
        hardlinks: _hardlinks,
        sequence: _sequence,
        ...evidence
      } = receipt;
      if (
        failure ||
        receipt.phase !== "complete" ||
        receipt.finalRevisionId !== plan.finalRevisionId
      )
        throw new OpsExecutionFailure(
          receipt.phase === "failed" ? "runtime" : "recovery_required",
          { serviceLifecycle: evidence },
        );
      await verifyControlEffectSettlement(installation, child.execution);
      const settled = inspectLocalLeaseChildSettlement(lease, child.execution);
      if (settled?.outcome !== "committed" || settled.publication !== "committed")
        throw new OpsExecutionFailure("recovery_required", { serviceLifecycle: evidence });
      return { changed: true, revisionId: receipt.finalRevisionId };
    } catch (error) {
      if (error instanceof OpsExecutionFailure) throw error;
      throw new OpsExecutionFailure("recovery_required", {
        serviceLifecycle: {
          expectedRevisionId: operation.expectedConfigurationRevisionId,
          seedRevisionId: operation.expectedConfigurationRevisionId,
          finalRevisionId: null,
          phase: "unknown",
          commit: "seed_committed",
          followUp: "unknown",
          failure: { reason: "receipt_io", failedServiceIds: [operation.serviceId] },
        },
      });
    } finally {
      closeControlInstallation(installation);
    }
  };
}
