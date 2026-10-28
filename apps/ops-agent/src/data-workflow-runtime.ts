/** Full Update runs its data and target-owning phases through the same real CLI.
 * An attempted invocation is observation-only, including after a lost response. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import type { DataWorkflowReceipt, ExecutionRef, OpsOperation } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import type { FixedCliRunner } from "./administrative-runtime";
import { assertStagedCoordinatorConfigurationWrite } from "./configuration-maintenance-runtime";
import { OpsExecutionFailure, OpsHostUpdateRequiredError, type OpsRuntime } from "./runtime";

const sources = new WeakMap<OpsRuntime, { rootDir: string }>();
export function prepareDataUpdateAdmission(
  runtime: OpsRuntime,
  parent: ExecutionRef,
  operation: Extract<OpsOperation, { kind: "data.update" }>,
  serviceIds: readonly string[],
) {
  const source = sources.get(runtime);
  if (!source) throw new OpsHostUpdateRequiredError();
  return control.planDataUpdate({
    infraDir: join(source.rootDir, "infra/docker"),
    parent,
    operation,
    serviceIds,
    defaultRegion: process.env.OPENMAPX_REGION,
    defaultCountries: process.env.TRANSITOUS_COUNTRIES,
  });
}
export function installDataWorkflowRuntime(
  runtime: OpsRuntime,
  options: { rootDir: string; runFixedCli: FixedCliRunner },
) {
  sources.set(runtime, options);
  runtime["data.update"] = async (operation, context) => {
    const authority = context.controlAuthority;
    if (!authority) throw new OpsHostUpdateRequiredError();
    const infraDir = join(options.rootDir, "infra/docker"),
      plan = control.readDataUpdatePlan(authority),
      args = control.fixedCliArguments(operation);
    const progress = await services.openAdminDataWorkflow({
      dataRoot: join(infraDir, "data"),
      operationKey: authority.execution.operationKey,
      fingerprint: authority.execution.fingerprint,
      authority,
    });
    const checkpoint = async (receipt: DataWorkflowReceipt) => {
      await progress.checkpoint(receipt);
      await context.checkpointDataWorkflow?.(receipt);
    };
    const run = async (
      phase: "data-workflow" | "data-finalization",
      lease?: control.ArtifactTargetLease,
      initial?: DataWorkflowReceipt,
    ) => {
      const slot = phase === "data-workflow" ? plan.dataReservation : plan.finalizationReservation,
        delegationId =
          phase === "data-workflow" ? plan.dataDelegationId : plan.finalizationDelegationId;
      const bound = await control.bindControlChildPhase(authority, slot);
      let attempted = control.lookupControlChildPhaseAttempt(authority, slot),
        failure: unknown;
      if (!attempted) {
        const key = control.prepareFixedControlChild(authority, delegationId);
        control.retainFixedCliSpawnIntent(authority, {
          delegationId,
          execution: bound.execution,
          operation,
          args,
          reservations: phase === "data-workflow" ? plan.dataChildren : plan.finalizationChildren,
          dataUpdatePlan: plan,
          ...(initial ? { dataWorkflowInitial: initial } : {}),
        });
        const issued = await control.issueControlChildPhase(authority, {
          phase,
          ordinal: slot.ordinal,
          childPublicKey: key,
          ...(lease ? { lease } : {}),
        });
        control.consumeControlChildDispatch(issued.dispatchTicket);
        try {
          await options.runFixedCli(args, {
            ...context,
            execution: bound.execution,
            operationKind: "data.update",
            ...(lease
              ? { controlAssertion: issued.assertion }
              : { parentAssertion: issued.assertion }),
          });
        } catch (error) {
          failure = error;
        }
        attempted = control.lookupControlChildPhaseAttempt(authority, slot);
      }
      if (!attempted) throw new OpsExecutionFailure("recovery_required", {});
      const installation = control.openFixedChildInstallation({
        infraDir,
        assertion: attempted.assertion,
        container: existsSync("/run/secrets/openmapx-control-verifiers"),
      });
      try {
        const childAuthority = control.restoreAdmittedControlExecution(
            installation,
            bound.execution,
          ),
          store = await services.openAdminDataWorkflow({
            dataRoot: join(infraDir, "data"),
            operationKey: bound.execution.operationKey,
            fingerprint: bound.execution.fingerprint,
            authority: childAuthority,
          }),
          receipt = store.read();
        if (receipt) await checkpoint(receipt);
        if (
          failure ||
          !receipt ||
          receipt.phase !== (phase === "data-workflow" ? "build" : "complete")
        )
          throw new OpsExecutionFailure(
            "recovery_required",
            receipt ? { dataWorkflow: receipt } : {},
          );
        control.verifyControlEffectSettlement(installation, bound.execution);
        if (lease) {
          const settled = control.inspectArtifactTargetLeaseChildSettlement(lease, bound.execution);
          if (settled?.outcome !== "committed" || settled.publication !== "committed")
            throw new OpsExecutionFailure("recovery_required", { dataWorkflow: receipt });
        }
        return receipt;
      } finally {
        control.closeControlInstallation(installation);
      }
    };
    await assertStagedCoordinatorConfigurationWrite(runtime, operation, context, context.signal);
    await run("data-workflow");
    context.signal.throwIfAborted();
    const initial = await control.verifyDataUpdatePrerequisites(authority);
    await assertStagedCoordinatorConfigurationWrite(runtime, operation, context, context.signal);
    const lease = await control.acquireArtifactTargetLease({
      dataRoot: join(infraDir, "data"),
      serviceIds: plan.dataReservation.serviceIds,
      owner: authority,
      signal: context.signal,
    });
    context.ownDataFinalizationLease?.(lease);
    try {
      const receipt = await run("data-finalization", lease, initial);
      return { completed: true, dataWorkflow: receipt };
    } finally {
      if (!context.ownDataFinalizationLease) control.closeArtifactTargetLeaseHandle(lease);
    }
  };
}
