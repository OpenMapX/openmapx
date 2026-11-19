/** Image pulls from the images the configuration names, with no generation
 * publication, container lifecycle or target lease. A coordinator update pulls
 * data-manager's image first; its maintenance commits the image the pull
 * reports into the generation, and its recreate is checked against it. */
import { readFileSync } from "node:fs";
import {
  assertControlExecutionForward,
  assertCoordinatorPullLeaseCompatibility,
  beginControlEffect,
  executionAuthorityState,
  retainConfigurationPreEffectRefusal,
  verifyConfigurationReleaseSourceWitness,
} from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  coordinatorLifecycleMetadataSchema,
  type PreparedConfigurationRecord,
  servicePullResultSchema,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import {
  type ConfigurationCandidateSource,
  readConfigurationCandidate,
} from "./configuration-candidate-source";
import { assertConfigurationCoordinatorReady } from "./configuration-hardlinks-runtime";
import {
  type DockerRuntimeOptions,
  runContainedProcess,
  runContainedStreamingProcess,
} from "./docker-runtime";
import type { OwnedServiceResolver } from "./owned-services";
import { safeProcessDiagnostic } from "./process-output";
import type { OpsRuntime } from "./runtime";
import { OpsExecutionFailure } from "./runtime";
import type { TrustedConfigurationAuthoritySnapshot } from "./trusted-config-runtime";

export function coordinatorCandidateMetadata(record: PreparedConfigurationRecord) {
  const fixed = coordinatorLifecycleMetadataSchema.parse(record.privateCoordinatorLifecycle);
  if (
    record.apiFollowUp !== `coordinator-${fixed.action}` ||
    !record.maintenanceId ||
    !record.prepareOperationKey ||
    canonicalJson(record.affectedServiceIds) !== '["data-manager"]'
  )
    throw Error("Fixed coordinator candidate provenance required");
  return fixed;
}
export function renderCoordinatorCandidate(
  candidate: Awaited<ReturnType<typeof readConfigurationCandidate>>,
  authority: TrustedConfigurationAuthoritySnapshot,
  infraDir: string,
) {
  const fixed = coordinatorCandidateMetadata(candidate.record),
    operation = candidate.operation;
  if (
    operation.kind !== "stack.render" ||
    !operation.maintenanceId ||
    operation.candidateId !== candidate.record.candidateId ||
    operation.coordinatorMode !== "ensure-running" ||
    canonicalJson(candidate.record.privateOverlay) !==
      canonicalJson({ purpose: "render", coordinatorMode: "ensure-running", changes: [] })
  )
    throw Error("Fixed unchanged coordinator render required");
  const desired = services.readDesiredSelection(infraDir),
    rendered = services.renderConfiguration({
      infraDir,
      services: authority.services,
      integrationSchemas: authority.integrationSchemas,
      input: {
        ...candidate.payload,
        selectedRoots: candidate.payload.selectedRoots ?? desired.roots,
      },
      allowMissingSelected: !candidate.payload.selectedRoots && desired.source === "default",
    }),
    selected = services.readServiceReleaseImageSelection(infraDir, "data-manager"),
    imageReference =
      selected.imageReference ??
      services.configurationImageReference(rendered.rendered.composeYaml, "data-manager");
  return {
    fixed,
    rendered,
    imageReference,
    releaseSelectionDigest: selected.releaseSelectionDigest,
  };
}
interface ServicePullSource {
  infraDir: string;
  candidateSource?: ConfigurationCandidateSource;
  loadAuthority(): Promise<TrustedConfigurationAuthoritySnapshot>;
  ownedServices: OwnedServiceResolver;
  execFile?: DockerRuntimeOptions["execFile"];
}
export function installServicePullRuntime(runtime: OpsRuntime, options: ServicePullSource) {
  runtime["service.pull"] = async (operation, context) => {
    if (operation.serviceId === "data-manager" && !operation.candidateId)
      throw new OpsExecutionFailure("configuration_prerequisite", {});
    try {
      return await services.withConfigurationGenerationWriter(
        options.infraDir,
        async () => {
          const authority = context.controlAuthority;
          if (!authority || !context.execution || context.artifactLease || context.ownedTargetLease)
            throw Error("Normal pull admission without a target lease required");
          assertControlExecutionForward(authority);
          const admitted = executionAuthorityState(authority);
          if (
            services.currentConfigurationGeneration(options.infraDir) !==
            operation.expectedConfigurationRevisionId
          )
            throw Error("Pull configuration revision changed");
          const registry = await options.loadAuthority();
          let imageReference: string, releaseSelectionDigest: string | null;
          if (operation.candidateId) {
            // The image the coordinator update's candidate renders, pulled only
            // as that update's own first step while the old coordinator runs.
            if (!options.candidateSource) throw Error("Original pull candidate unavailable");
            const candidate = await readConfigurationCandidate(
                options.candidateSource,
                operation.candidateId,
              ),
              source = renderCoordinatorCandidate(candidate, registry, options.infraDir),
              fixed = source.fixed;
            if (
              fixed.action !== "update" ||
              candidate.operation.kind !== "stack.render" ||
              candidate.operation.expectedCurrentRevisionId !==
                operation.expectedConfigurationRevisionId
            )
              throw Error("Coordinator update candidate required");
            verifyConfigurationReleaseSourceWitness({
              installation: admitted.installation.installation,
              infraDir: options.infraDir,
              sourceRevision: candidate.record.expectedSourceRevision,
              expectedCurrentRevisionId: operation.expectedConfigurationRevisionId,
              authorityRevision: registry.revisionId,
            });
            ({ imageReference, releaseSelectionDigest } = source);
            if (
              (await options.ownedServices.inspectOwnedServices(context.signal)).find(
                (s) => s.serviceId === "data-manager",
              )?.state !== "running"
            )
              throw Error("Ready old coordinator required before image pull");
            await assertConfigurationCoordinatorReady(context.signal);
          } else {
            const selected = services.readServiceReleaseImageSelection(
              options.infraDir,
              operation.serviceId,
            );
            imageReference =
              selected.imageReference ??
              services.configurationImageReference(
                readFileSync(
                  services.configurationGenerationComposeFile(
                    options.infraDir,
                    operation.expectedConfigurationRevisionId,
                  ),
                  "utf8",
                ),
                operation.serviceId,
              );
            releaseSelectionDigest = selected.releaseSelectionDigest;
          }
          const remaining = () => {
            const value = context.execution.deadlineAt - Date.now();
            if (value <= 0 || context.signal.aborted) throw new OpsExecutionFailure("timeout", {});
            return value;
          };
          if (operation.serviceId === "data-manager") {
            // A maintenance holding data-manager would recreate it from a
            // generation whose image this pull could move under it.
            try {
              assertCoordinatorPullLeaseCompatibility(authority);
            } catch {
              retainConfigurationPreEffectRefusal(authority);
              throw new OpsExecutionFailure("busy", {});
            }
            beginControlEffect(authority);
          }
          const pullArgs = ["image", "pull", imageReference];
          if (options.execFile)
            await options.execFile("docker", pullArgs, {
              signal: context.signal,
              timeout: Math.min(15 * 60000, remaining()),
              maxBuffer: 1024 * 1024,
            });
          else
            await runContainedStreamingProcess("docker", pullArgs, {
              signal: context.signal,
              timeout: Math.min(15 * 60000, remaining()),
              onLine: context.emitLog,
              redact: safeProcessDiagnostic,
            });
          const imageId = (
            await (options.execFile ?? runContainedProcess)(
              "docker",
              ["image", "inspect", "--format", "{{.Id}}", imageReference],
              { signal: context.signal, timeout: Math.min(15000, remaining()), maxBuffer: 4096 },
            )
          ).stdout.trim();
          context.signal.throwIfAborted();
          assertControlExecutionForward(authority);
          if (
            (await options.loadAuthority()).revisionId !== registry.revisionId ||
            services.currentConfigurationGeneration(options.infraDir) !==
              operation.expectedConfigurationRevisionId
          )
            throw Error("Pull source changed");
          return servicePullResultSchema.parse({
            changed: true,
            revisionId: operation.expectedConfigurationRevisionId,
            imageReference,
            imageId,
            releaseSelectionDigest,
          });
        },
        context.signal,
      );
    } catch (error) {
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
