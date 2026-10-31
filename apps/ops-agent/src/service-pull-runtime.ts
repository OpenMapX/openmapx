/** Existing normal pull: only fixed trusted image sources, with no generation
 * publication, container lifecycle, mutable overlay repair or target lease. */
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertControlExecutionForward,
  assertCoordinatorPullLeaseCompatibility,
  beginControlEffect,
  type ControlInstallation,
  coordinatorPullBaselineSchema,
  executionAuthorityState,
  retainConfigurationPreEffectRefusal,
  verifyConfigurationReleaseSourceWitness,
  verifyConfigurationSourceWitness,
  verifyCoordinatorPullAdmissionSource,
} from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  coordinatorLifecycleMetadataSchema,
  coordinatorPullSubmissionDigest,
  type ExecutionRef,
  type OpsOperation,
  type PreparedConfigurationRecord,
  type RetainedParentExecution,
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
import {
  type CoordinatorPullOwnershipObservation,
  confirmCoordinatorPullOwnership,
  type OwnedServiceResolver,
} from "./owned-services";
import { safeProcessDiagnostic } from "./process-output";
import type { OpsExecutionContext, OpsRuntime } from "./runtime";
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
const sources = new WeakMap<OpsRuntime, ServicePullSource>();
/** The generic action wrapper cannot infer this internal workflow from a UUID.
 * Require its actual MAC candidate and original signed normal admission. */
export async function assertAdmittedCoordinatorPullRuntime(
  runtime: OpsRuntime,
  operation: Extract<OpsOperation, { kind: "service.pull" }>,
  context: OpsExecutionContext,
): Promise<void> {
  const source = sources.get(runtime);
  if (
    !source?.candidateSource ||
    !context.controlAuthority ||
    operation.serviceId !== "data-manager" ||
    !operation.candidateId
  )
    throw Error("Actual internal coordinator Update pull required");
  const candidate = await readConfigurationCandidate(source.candidateSource, operation.candidateId),
    state = executionAuthorityState(context.controlAuthority),
    actual = verifyCoordinatorPullAdmissionSource(
      state.installation.installation,
      candidate.record,
    );
  if (
    coordinatorCandidateMetadata(candidate.record).action !== "update" ||
    canonicalJson(actual.operation) !== canonicalJson(operation) ||
    canonicalJson(actual.execution) !== canonicalJson(context.execution) ||
    canonicalJson(state.execution) !== canonicalJson(context.execution)
  )
    throw Error("Original internal coordinator Update pull changed");
}
/** Actual MAC source join, under the first original server admission lock. */
export async function prepareCoordinatorPullBaseline(
  runtime: OpsRuntime,
  installation: ControlInstallation,
  input: {
    operation: Extract<OpsOperation, { kind: "service.pull" }>;
    execution: ExecutionRef;
    parent?: RetainedParentExecution;
    requestedDeadlineAt?: number;
  },
  observation: CoordinatorPullOwnershipObservation,
) {
  const source = sources.get(runtime),
    parent = input.parent;
  if (
    !source?.candidateSource ||
    !input.operation.candidateId ||
    !parent ||
    parent.issuer !== "api"
  )
    throw Error("Original coordinator source required");
  const candidate = await readConfigurationCandidate(
      source.candidateSource,
      input.operation.candidateId,
    ),
    registry = await source.loadAuthority(),
    rendered = renderCoordinatorCandidate(candidate, registry, source.infraDir),
    fixed = rendered.fixed;
  if (fixed.action !== "update") throw Error("Original update submission required");
  const submission = fixed.pull,
    attempt = submission.attempt;
  if (
    canonicalJson(submission.operation) !== canonicalJson(input.operation) ||
    submission.operationKey !== input.execution.operationKey ||
    submission.operationFingerprint !== input.execution.operationFingerprint ||
    submission.requestedDeadlineAt !== input.requestedDeadlineAt ||
    observation.operationFingerprint !== submission.operationFingerprint ||
    observation.candidateId !== candidate.record.candidateId ||
    registry.revisionId !== observation.configurationAuthorityRevision ||
    candidate.record.apiJobId !== parent.apiJobId ||
    parent.apiJobId !== attempt.apiJobId ||
    parent.apiOwnerVersion !== attempt.apiOwnerVersion ||
    parent.attemptId !== attempt.attemptId ||
    parent.operationKey !== attempt.parentOperationKey ||
    parent.fingerprint !== attempt.parentFingerprint ||
    parent.deadlineAt !== attempt.parentDeadlineAt ||
    candidate.record.parentOperationKey !== parent.operationKey ||
    candidate.record.parentFingerprint !== parent.fingerprint ||
    candidate.record.parentDeadlineAt !== parent.deadlineAt ||
    services.currentConfigurationGeneration(source.infraDir) !==
      input.operation.expectedConfigurationRevisionId ||
    rendered.imageReference !== observation.configImageReference
  )
    throw Error("Original coordinator claim/source changed");
  verifyConfigurationSourceWitness({
    installation,
    infraDir: source.infraDir,
    sourceRevision: candidate.record.expectedSourceRevision,
    expectedCurrentRevisionId: input.operation.expectedConfigurationRevisionId,
    authorityRevision: observation.configurationAuthorityRevision,
  });
  return coordinatorPullBaselineSchema.parse({
    version: 1,
    candidateId: candidate.record.candidateId,
    sourceRevision: candidate.record.expectedSourceRevision,
    configurationRevisionId: input.operation.expectedConfigurationRevisionId,
    configurationAuthorityRevision: observation.configurationAuthorityRevision,
    policyRevision: observation.policyRevision,
    submissionDigest: coordinatorPullSubmissionDigest(submission),
    observedAt: observation.observedAt,
    configImageReference: observation.configImageReference,
    composeSourcesDigest: observation.composeSourcesDigest,
    container: observation.container,
  });
}
export function installServicePullRuntime(runtime: OpsRuntime, options: ServicePullSource) {
  sources.set(runtime, options);
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
          const directory = services.releaseStatePaths(options.infraDir).store;
          await mkdir(directory, { mode: 0o700, recursive: true });
          const lock = await services.acquireReleaseStoreLock(directory);
          try {
            const registry = await options.loadAuthority();
            let imageReference: string, releaseSelectionDigest: string | null;
            if (operation.candidateId) {
              if (!options.candidateSource) throw Error("Original pull candidate unavailable");
              const candidate = await readConfigurationCandidate(
                  options.candidateSource,
                  operation.candidateId,
                ),
                source = renderCoordinatorCandidate(candidate, registry, options.infraDir),
                fixed = source.fixed,
                actual = verifyCoordinatorPullAdmissionSource(
                  admitted.installation.installation,
                  candidate.record,
                ),
                parent = actual.parent;
              if (
                fixed.action !== "update" ||
                !parent ||
                parent.issuer !== "api" ||
                canonicalJson(fixed.pull.operation) !== canonicalJson(operation) ||
                fixed.pull.operationKey !== context.execution.operationKey ||
                fixed.pull.operationFingerprint !== context.execution.operationFingerprint ||
                candidate.record.apiJobId !== parent.apiJobId ||
                fixed.pull.attempt.apiJobId !== parent.apiJobId ||
                fixed.pull.attempt.apiOwnerVersion !== parent.apiOwnerVersion ||
                fixed.pull.attempt.attemptId !== parent.attemptId ||
                fixed.pull.attempt.parentOperationKey !== parent.operationKey ||
                fixed.pull.attempt.parentFingerprint !== parent.fingerprint ||
                fixed.pull.attempt.parentDeadlineAt !== parent.deadlineAt ||
                fixed.pull.requestedDeadlineAt !== actual.requestedDeadlineAt
              )
                throw Error("Original coordinator pull submission changed");
              verifyConfigurationReleaseSourceWitness({
                installation: admitted.installation.installation,
                infraDir: options.infraDir,
                sourceRevision: candidate.record.expectedSourceRevision,
                expectedCurrentRevisionId: operation.expectedConfigurationRevisionId,
                authorityRevision: registry.revisionId,
              });
              ({ imageReference, releaseSelectionDigest } = source);
              if (
                actual.coordinatorPullBaseline.configurationAuthorityRevision !==
                  registry.revisionId ||
                actual.coordinatorPullBaseline.policyRevision !==
                  context.claim.capability.revisionId ||
                actual.coordinatorPullBaseline.configImageReference !== imageReference
              )
                throw Error("Original pull baseline source changed");
              await confirmCoordinatorPullOwnership(
                options.ownedServices,
                operation,
                context.execution.operationFingerprint,
                actual.coordinatorPullBaseline,
                context.signal,
              );
              if (
                (await options.ownedServices.inspectOwnedServices(context.signal)).find(
                  (s) => s.serviceId === "data-manager",
                )?.state !== "running"
              )
                throw Error("Ready old coordinator required before image pull");
              await assertConfigurationCoordinatorReady(context.signal);
              // Same actual current native Compose/release sources plus the full
              // readonly prospective render/registered manifest sources. Aliases
              // are a refusal condition; no sibling OLD-image exception exists.
              const args = services.stackComposeArgs({
                infraDir: options.infraDir,
                composePath: services.configurationGenerationComposeFile(
                  options.infraDir,
                  operation.expectedConfigurationRevisionId,
                ),
                composeReleasePath: services.releaseStatePaths(options.infraDir).overlay,
              });
              const config = JSON.parse(
                (
                  await (options.execFile ?? runContainedProcess)(
                    "docker",
                    [...args, "config", "--format", "json"],
                    { signal: context.signal, timeout: 15000, maxBuffer: 1024 * 1024 },
                  )
                ).stdout,
              ) as { services?: Record<string, { image?: string }> };
              if (
                !config.services ||
                typeof config.services !== "object" ||
                Array.isArray(config.services) ||
                Object.keys(config.services).length > 256
              )
                throw Error("Current coordinator image inventory unavailable");
              const identity = services.coordinatorPullReferenceIdentity(imageReference),
                enabled = new Set(
                  source.rendered.resolved.enabled.map((value) => value.manifest.id),
                );
              for (const service of registry.services) {
                if (service.manifest.id === "data-manager") continue;
                const selected = services.readServiceReleaseImageSelection(
                    options.infraDir,
                    service.manifest.id,
                  ),
                  prospective =
                    selected.imageReference ??
                    (enabled.has(service.manifest.id)
                      ? services.configurationImageReference(
                          source.rendered.rendered.composeYaml,
                          service.manifest.id,
                        )
                      : services.serviceContainerImageReference(service.manifest.container));
                const current =
                  config.services[service.manifest.id]?.image ??
                  selected.imageReference ??
                  services.serviceContainerImageReference(service.manifest.container);
                if (
                  [current, prospective].some(
                    (value) => services.coordinatorPullReferenceIdentity(value) === identity,
                  )
                )
                  throw Error("Coordinator image reference shared by another registered service");
              }
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
              if (value <= 0 || context.signal.aborted)
                throw new OpsExecutionFailure("timeout", {});
              return value;
            };
            if (operation.serviceId === "data-manager") {
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
          } finally {
            lock.release();
          }
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
