import {
  assertArtifactTargetLeaseForward,
  beginControlEffect,
  retainConfigurationPreEffectRefusal,
} from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import { type DockerRuntimeOptions, runContainedProcess } from "./docker-runtime";
import type { OwnedServiceResolver } from "./owned-services";
import { OpsExecutionFailure, OpsHostUpdateRequiredError, type OpsRuntime } from "./runtime";
import { decideServiceAction, type ServiceAuthority } from "./service-action-policy";

export function installCoreServiceRuntime(
  runtime: OpsRuntime,
  options: {
    infraDir: string;
    ownedServices: OwnedServiceResolver;
    loadAuthority(): Promise<ServiceAuthority>;
    execFile?: DockerRuntimeOptions["execFile"];
  },
): void {
  const execFile = options.execFile ?? runContainedProcess;
  runtime["coreService.restart"] = async (operation, context) => {
    if (!context.controlAuthority || !context.ownedTargetLease)
      throw new OpsHostUpdateRequiredError();
    try {
      return await services.withConfigurationGenerationWriter(
        options.infraDir,
        async () => {
          context.signal.throwIfAborted();
          assertArtifactTargetLeaseForward(context.ownedTargetLease!);
          if (
            services.currentConfigurationGeneration(options.infraDir) !==
            operation.expectedConfigurationRevisionId
          )
            throw new OpsExecutionFailure("conflict", {});
          const authority = await options.loadAuthority();
          const target = (await options.ownedServices.inspectOwnedServices(context.signal)).find(
            (s) => s.serviceId === operation.serviceId,
          );
          const service = authority.services.find((s) => s.serviceId === operation.serviceId);
          const decision = decideServiceAction(
            { ...authority, services: service ? [service] : [] },
            target,
            "restart",
          );
          const encoded = context.claim.capability.values.ownedService;
          if (
            !target ||
            !decision.available ||
            decision.workflow !== "core-restart" ||
            typeof encoded !== "string"
          )
            throw new OpsExecutionFailure("authorization", {});
          const claimed = JSON.parse(encoded);
          if (
            claimed.serviceId !== target.serviceId ||
            claimed.containerId !== target.containerId ||
            JSON.stringify(claimed.provenance) !== JSON.stringify(target.provenance)
          )
            throw new OpsExecutionFailure("conflict", {});
          beginControlEffect(context.controlAuthority!);
          await execFile("docker", ["restart", "--time", "30", target.containerId], {
            signal: context.signal,
            timeout: Math.max(1, context.execution.deadlineAt - Date.now()),
            maxBuffer: 1024 * 1024,
          });
          const after = (await options.ownedServices.inspectOwnedServices(context.signal)).find(
            (s) => s.serviceId === operation.serviceId,
          );
          if (
            !after ||
            after.containerId !== target.containerId ||
            JSON.stringify(after.provenance) !== JSON.stringify(target.provenance) ||
            after.state !== "running"
          )
            throw new OpsExecutionFailure("recovery_required", {});
          return { changed: true as const, serviceId: operation.serviceId };
        },
        context.signal,
      );
    } catch (error) {
      // The existing source verifies actual null effect-started, original owner
      // and frozen/unissued children; it refuses after Docker was dispatched.
      try {
        retainConfigurationPreEffectRefusal(context.controlAuthority);
      } catch {
        /* Unknown effects keep the original fence. */
      }
      if (
        error instanceof services.ConfigurationGenerationError &&
        error.result.outcome === "not_committed" &&
        !error.result.cleanupFailed &&
        error.cause instanceof OpsExecutionFailure
      )
        throw error.cause;
      throw error;
    }
  };
}
