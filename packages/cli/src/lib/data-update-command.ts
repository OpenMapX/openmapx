/** Concrete Full Update adapter shared by standalone and fixed CLI entrypoints. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import type { DataManagerTransport } from "@openmapx/core/data-manager-sdk";
import * as ops from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { renderComposeWithWriter } from "../commands/compose";
import { cliControlContext, withHostDataControlContext } from "./control-context";
import { ensureCliCoordinatorReady } from "./coordinator-ready";
import { runOwnedDataStep } from "./data-execution";
import { DataUpdateFailure, runDataUpdate } from "./data-update";
import { cliAcquisitionOptions } from "./execution-deadline";
import { readGeneratedHardlinkPlan } from "./hardlinks";
import { log } from "./output";
import { repoPaths } from "./paths";
import { buildServices, ServiceBuildExecutionError } from "./service-builds";

export async function runCliDataUpdate(options: {
  region?: string;
  countries: string[];
  failFast: boolean;
  transport: DataManagerTransport;
}): Promise<ops.DataWorkflowReceipt> {
  const paths = repoPaths();
  let context = cliControlContext(),
    installation: control.ControlInstallation | undefined;
  if (!context) {
    mkdirSync(join(paths.infraDir, "data"), { recursive: true });
    if (!existsSync("/run/secrets/openmapx-control-verifiers"))
      await control.provisionControlInstallation(paths.infraDir);
    const registry = new services.ServiceRegistry({ rootDir: paths.root });
    await registry.load();
    const targets = registry
      .list()
      .map((s) => s.manifest.id)
      .sort();
    installation = control.openControlInstallation({
      infraDir: paths.infraDir,
      role: "host-cli",
      serviceIds: targets,
    });
    const operation = {
        kind: "data.update" as const,
        ...(options.region ? { regionId: options.region } : {}),
        countryCodes: options.countries,
        failFast: options.failFast,
      },
      admittedAt = Date.now(),
      deadlineAt = admittedAt + ops.opsExecutionBudget(operation.kind).processMs,
      operationFingerprint = ops.opsOperationFingerprint(operation);
    const execution = {
      executor: "host-cli" as const,
      principal: "host-cli" as const,
      executionId: randomUUID(),
      operationKey: ops.createControlRootOperationKey({
        notAfter: deadlineAt,
        nonce: randomBytes(16),
      }),
      operationFingerprint,
      deadlineAt,
      fingerprint: ops.executionFingerprint({
        kind: operation.kind,
        operationFingerprint,
        deadlineAt,
      }),
    };
    try {
      const plan = control.planDataUpdate({
        infraDir: paths.infraDir,
        parent: execution,
        operation,
        serviceIds: targets,
        defaultRegion: process.env.OPENMAPX_REGION,
      });
      const authority = control.retainAdmittedControlExecution(installation, {
        execution,
        operation,
        kind: operation.kind,
        admittedAt,
        requestedDeadlineAt: deadlineAt,
        serviceIds: targets,
        reservations: [...plan.dataChildren, ...plan.finalizationChildren],
      });
      control.retainDataUpdatePlan(authority, plan);
      return await withHostDataControlContext(installation, authority, () =>
        runCliDataUpdate(options),
      );
    } finally {
      control.closeControlInstallation(installation);
    }
  }
  const { authority } = context,
    plan = control.readDataUpdatePlan(authority),
    managed = context.dataUpdatePlan;
  const stage = managed
    ? authority.execution.operationKey === plan.dataReservation.execution.operationKey
      ? "data"
      : "finalize"
    : undefined;
  const store = await services.openAdminDataWorkflow({
    dataRoot: join(paths.infraDir, "data"),
    operationKey: authority.execution.operationKey,
    fingerprint: authority.execution.fingerprint,
    authority,
  });
  if (store.read()) throw Error("Retained Full Update permits observation only");
  let lease: control.TargetLeaseAuthority | undefined = context.lease;
  try {
    const receipt = await runDataUpdate(
      {
        region: plan.region,
        countries: plan.countries,
        failFast: plan.operation.kind === "data.update" && plan.operation.failFast === true,
        execution: authority.execution,
        signal: cliAcquisitionOptions().signal,
        stage,
        ...(context.dataWorkflowInitial ? { initialReceipt: context.dataWorkflowInitial } : {}),
      },
      {
        checkpoint: (receipt) => store.checkpoint(receipt),
        checkpointAttempt: async (attempt) => control.retainCliDataAttempt(authority, attempt),
        runDataStep: (phase, input) => {
          let last = "";
          return runOwnedDataStep(input, options.transport, phase, async (status) => {
            const message = `Full Update ${phase}: ${status.status}${status.progress === null ? "" : ` (${Math.round(status.progress * 100)}%)`}`;
            if (message !== last) {
              log.info(message);
              last = message;
            }
          });
        },
        async build(input) {
          control.assertDataUpdateSources(authority);
          if (!lease)
            lease = await control.acquireArtifactTargetLease({
              dataRoot: join(paths.infraDir, "data"),
              serviceIds: control.controlRegisteredServiceIds(context.installation),
              owner: authority,
              signal: cliAcquisitionOptions().signal,
            });
          try {
            return (
              await buildServices({
                mode: "all",
                region: input.region,
                continueOnError: input.continueOnError,
              })
            ).serviceBatch;
          } catch (error) {
            if (error instanceof ServiceBuildExecutionError) return error.result.serviceBatch;
            throw error;
          }
        },
        async prepare({ coordinatorMode }) {
          if (!lease) throw Error("Full Update finalization lease required");
          control.assertDataUpdateSources(authority);
          control.retainGenerationHardlinksOwnerPlan(authority, {
            version: 1,
            parent: authority.execution,
            revisionId: plan.finalRevisionId,
            coordinatorMode,
            plan: plan.hardlinks,
            reservation: plan.finalizationChildren[0] ?? null,
          });
          return services.withConfigurationGenerationWriter(
            paths.infraDir,
            (writer) =>
              services.withVerifiedLifecycleOwnership(
                { writer, lease: lease!, authority },
                async (ownership) => {
                  control.assertDataUpdateSources(authority);
                  if (plan.hardlinks.plan.length) {
                    const registry = new services.ServiceRegistry({ rootDir: paths.root });
                    await registry.load();
                    const selected = services.readAppliedServiceIds(
                      paths.infraDir,
                      registry.list(),
                    );
                    if (!selected?.has("data-manager"))
                      throw Error("Configuration coordinator must be enabled");
                    await ensureCliCoordinatorReady({
                      ownership,
                      transport: options.transport,
                      mode: coordinatorMode,
                    });
                  }
                  const rendered = await renderComposeWithWriter(
                    {
                      domain: plan.domain,
                      expectedCurrentRevisionId: plan.revisionId,
                      revisionId: plan.finalRevisionId,
                    },
                    writer,
                  );
                  if (
                    ops.canonicalJson(readGeneratedHardlinkPlan().plan) !==
                    ops.canonicalJson(plan.hardlinks.plan)
                  )
                    throw Error("Full Update hardlink plan changed");
                  const hardlinks = await control.executeOwnedGenerationHardlinks({
                    authority,
                    lease: lease!,
                    infraDir: paths.infraDir,
                    transport: options.transport,
                    signal: cliAcquisitionOptions().signal,
                  });
                  return { revisionId: rendered.revisionId, coordinatorMode, hardlinks };
                },
              ),
            cliAcquisitionOptions().signal,
          );
        },
      },
    );
    if (!managed) {
      control.retainControlEffectReceipt(authority, {
        outcome: "committed",
        publication: "committed",
        receipt: { kind: "ops-result", result: { completed: true, dataWorkflow: receipt } },
      });
      if (lease) {
        await control.settleArtifactTargetLeaseChild(
          lease,
          control.verifyControlEffectSettlement(context.installation, authority.execution),
        );
        await releaseOwned(lease);
      }
    }
    return receipt;
  } catch (error) {
    if (error instanceof DataUpdateFailure) throw error;
    throw new DataUpdateFailure(
      store.read() ?? {
        version: 1,
        phase: "osm",
        children: [],
        completedBuildIds: [],
        failedBuildIds: [],
        skippedBuildIds: [],
      },
      error,
    );
  } finally {
    if (lease && !context.lease) control.closeArtifactTargetLeaseHandle(lease);
  }
}

async function releaseOwned(lease: control.TargetLeaseAuthority) {
  if (lease.mode !== "owner") throw Error("Original host Full Update root required");
  await control.releaseArtifactTargetLease(lease);
}
