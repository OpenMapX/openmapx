/** Planning a configuration maintenance from the API's retained candidate and the
 * host, and the checks its steps run against the maintenance's own record. */
import { createHash } from "node:crypto";
import {
  buildFixedConfigurationMaintenancePlan,
  type ControlInstallation,
  executionAuthorityState,
  type FixedConfigurationMaintenancePlan,
  observeCoordinatorPullForMaintenance,
  observedCoordinatorPullBaseline,
  ownedCoordinatorPullBaseline,
  ownedStagedCoordinatorBaseline,
  readPrivateRecord,
  restoreAdmittedControlExecution,
  type VerifiedCoordinatorPullBaseline,
  verifiedStagedCoordinatorOwnershipState,
  verifyConfigurationReleaseSourceWitness,
  verifyConfigurationSourceWitness,
  verifyMaintenanceCoordinatorPrerequisite,
} from "@openmapx/core/build-artifacts";
import {
  type ConfigurationMaintenancePrepare,
  canonicalJson,
  coordinatorPullSubmissionDigest,
  type ExecutionRef,
  type OpsOperation,
  opsOperationFingerprint,
  parseOpsJobStatus,
  protectedConfigurationServiceIdSchema,
  type RetainedParentExecution,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { installationState } from "../../../packages/core/src/build-artifacts/control-authority";
import {
  type CoordinatorPullWitness,
  coordinatorPullWitnessPayloadSchema,
  stagedCoordinatorObservationSchema,
} from "../../../packages/core/src/build-artifacts/coordinator-pull-records";
import type { MaintenanceFile } from "../../../packages/core/src/build-artifacts/maintenance-file";
import {
  type ConfigurationCandidateSource,
  readConfigurationCandidate,
} from "./configuration-candidate-source";
import { assertConfigurationCoordinatorReady } from "./configuration-hardlinks-runtime";
import { preflightConfigurationRelease } from "./configuration-release-preflight";
import type { DockerRuntimeOptions } from "./docker-runtime";
import type { OpsJobJournal } from "./journal";
import { readMaintenance } from "./maintenance";
import {
  inspectLiteralStagedConfigurationDependency,
  inspectOriginalCoordinatorServices,
  inspectStagedCoordinatorMaintenanceSource,
  inspectStagedCoordinatorOwnerServices,
  type OwnedServiceResolver,
} from "./owned-services";
import { type OpsExecutionContext, OpsExecutionFailure, type OpsRuntime } from "./runtime";
import { coordinatorCandidateMetadata, renderCoordinatorCandidate } from "./service-pull-runtime";
import type { TrustedConfigurationAuthoritySnapshot } from "./trusted-config-runtime";

/** What the production runtime gives the maintenance planner and its step checks. */
export interface Source {
  rootDir?: string;
  infraDir: string;
  candidateSource?: ConfigurationCandidateSource;
  stack: services.StackPaths;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  loadAuthority(): Promise<TrustedConfigurationAuthoritySnapshot>;
  ownedServices: OwnedServiceResolver;
}
const sources = new WeakMap<OpsRuntime, Source>();
export function registerConfigurationMaintenanceSource(runtime: OpsRuntime, source: Source): void {
  if (sources.has(runtime)) throw Error("Configuration maintenance source already installed");
  sources.set(runtime, source);
}
export function maintenanceSource(runtime: OpsRuntime): Source {
  const source = sources.get(runtime);
  if (!source?.candidateSource) throw Error("Configuration maintenance source unavailable");
  return source;
}
/** The normal root remains held while this writer-side preflight runs. Release
 * the writer before invoking the fixed CLI, which acquires its own writer. */
export async function assertManagedCliConfigurationPreflight(
  runtime: OpsRuntime,
  operation: OpsOperation,
  context: OpsExecutionContext,
): Promise<void> {
  if (
    !(
      operation.kind === "service.update" ||
      operation.kind === "stack.start" ||
      (operation.kind === "service.start" && operation.serviceId !== "data-manager")
    )
  )
    return;
  const source = sources.get(runtime),
    lease = context.ownedTargetLease;
  if (!source || !context.controlAuthority || !lease || context.artifactLease)
    throw Error("Original full managed configuration target owner required");
  const targets = (await source.loadAuthority()).services
    .map((service) => service.manifest.id)
    .sort();
  if (canonicalJson(targets) !== canonicalJson(lease.serviceIds))
    throw Error("Managed configuration target closure changed");
  try {
    await services.withConfigurationGenerationWriter(
      source.infraDir,
      () => assertStagedCoordinatorConfigurationWrite(runtime, operation, context, context.signal),
      context.signal,
    );
  } catch (error) {
    if (
      error instanceof services.ConfigurationGenerationError &&
      error.result.outcome === "not_committed" &&
      !error.result.cleanupFailed &&
      error.cause instanceof OpsExecutionFailure &&
      error.cause.errorClass === "configuration_prerequisite"
    )
      throw error.cause;
    throw error;
  }
}
/** Read only from this runtime's existing fixed source and literal resolver.
 * Planned eligibility never substitutes for actual nominal publication. */
export async function assertStagedCoordinatorReleaseWrite(
  runtime: OpsRuntime,
  signal: AbortSignal,
): Promise<void> {
  const source = sources.get(runtime);
  if (
    !source ||
    (await inspectLiteralStagedConfigurationDependency(source.ownedServices, signal)) !== "none"
  )
    throw new OpsExecutionFailure("configuration_prerequisite", {});
}

export async function assertStagedCoordinatorConfigurationWrite(
  runtime: OpsRuntime,
  operation: OpsOperation,
  context: OpsExecutionContext,
  signal: AbortSignal,
): Promise<void> {
  const source = sources.get(runtime);
  if (!source) throw new OpsExecutionFailure("configuration_prerequisite", {});
  const dependency = await inspectLiteralStagedConfigurationDependency(
    source.ownedServices,
    signal,
  );
  if (dependency === "none") return;
  if (dependency === "required") {
    try {
      if (operation.kind === "configuration.hardlinks.preview") {
        await assertPlannedCoordinatorConfigurationWrite(runtime, operation);
        return;
      }
      if (
        (operation.kind === "stack.render" || operation.kind === "vault.apply") &&
        operation.maintenanceId
      ) {
        await assertOwnedCoordinatorConfigurationWrite(runtime, context, operation, signal);
        return;
      }
    } catch {
      /* Changed or foreign producer keeps the prerequisite closed. */
    }
  }
  throw new OpsExecutionFailure("configuration_prerequisite", {});
}

/** The release a maintenance pins in the generation it commits; undefined when
 * it keeps the applied release. */
export function readMaintenanceRelease(installation: ControlInstallation, maintenanceId: string) {
  return readMaintenance(installation, maintenanceId).plan.release;
}
/** The release a maintenance froze once its data fence is prepared, so a check
 * uses the snapshot and local images instead of the registry. */
export function readPreparedMaintenanceRelease(
  installation: ControlInstallation,
  maintenanceId: string,
) {
  try {
    const file = readMaintenance(installation, maintenanceId);
    return file.record.fence ? file.plan.release : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The maintenance a borrowed step child belongs to, with the step it runs. The
 * step must be the one the record attempted, so only the running maintenance's
 * own step passes. */
export function maintenanceStepOf(
  context: Pick<OpsExecutionContext, "controlAuthority" | "artifactLease">,
  operation: { maintenanceId?: string | undefined },
) {
  if (!context.controlAuthority || !context.artifactLease || !operation.maintenanceId)
    throw Error("Maintenance step child required");
  const child = executionAuthorityState(context.controlAuthority),
    file = readMaintenance(child.installation.installation, operation.maintenanceId),
    step = file.record.steps.find((value) => value.operationKey === child.execution.operationKey),
    planned = file.plan.steps.find((value) => value.operationKey === child.execution.operationKey);
  if (
    !step ||
    !planned ||
    step.state !== "attempted" ||
    file.record.state !== "applying" ||
    planned.operationFingerprint !== child.execution.operationFingerprint ||
    canonicalJson(planned.operation) !== canonicalJson(operation)
  )
    throw Error("Maintenance step changed");
  return { file, step, installation: child.installation.installation };
}

/** The original containers a generation step keeps, when the coordinator is
 * replaced in the same maintenance. */
export async function inspectOwnedMaintenanceGenerationRuntime(
  runtime: OpsRuntime,
  context: OpsExecutionContext,
  operation: Extract<OpsOperation, { kind: "stack.render" | "vault.apply" }>,
  signal: AbortSignal,
) {
  const { file, step, installation } = maintenanceStepOf(context, operation);
  if (step.phase !== "configuration-commit" || file.record.generation !== "not_started")
    throw Error("Maintenance generation step changed");
  if (!file.coordinatorPull && !file.stagedCoordinatorProvenance) return undefined;
  const source = sources.get(runtime);
  if (!source) throw Error("Configuration maintenance source unavailable");
  const services = await inspectOriginalOwnerServices(source, installation, file, signal),
    ordinary = await source.ownedServices.inspectInventory?.(signal);
  if (!ordinary || ordinary.unverifiedServiceIds.some((id) => id !== "data-manager"))
    throw Error("Original generation inventory unavailable");
  return {
    services,
    observedContainerIds: ordinary.observedContainerIds,
    unverifiedServiceIds: [],
  };
}
/** A recreate step of the running maintenance: the containers as the
 * maintenance found them, so a replaced coordinator stays its own. */
export async function assertOwnedMaintenanceRecreateRuntime(
  runtime: OpsRuntime,
  operation: OpsOperation,
  context: Pick<OpsExecutionContext, "controlAuthority" | "artifactLease" | "signal">,
) {
  if (operation.kind !== "service.recreate" && operation.kind !== "service.recreateIsolated")
    throw Error("Maintenance recreate step required");
  const { file, step, installation } = maintenanceStepOf(context, operation);
  if (step.phase !== "maintenance-recreate") throw Error("Maintenance recreate step changed");
  const source = sources.get(runtime);
  if (!source) throw Error("Configuration maintenance source unavailable");
  return inspectOriginalOwnerServices(source, installation, file, context.signal);
}
/** Read-only eligibility from the actual MAC packet and closed existing
 * producer. It grants no generation child, decision or publication authority. */
export async function assertPlannedCoordinatorConfigurationWrite(
  runtime: OpsRuntime,
  operation: Extract<OpsOperation, { kind: "configuration.hardlinks.preview" }>,
) {
  const source = sources.get(runtime);
  if (!source?.candidateSource) throw Error("Actual planned coordinator source required");
  const candidate = await readConfigurationCandidate(source.candidateSource, operation.candidateId),
    original = candidate.operation,
    record = candidate.record;
  if (
    !["stack.render", "vault.apply"].includes(original.kind) ||
    !("revisionId" in original) ||
    !("expectedCurrentRevisionId" in original) ||
    !("expectedSourceRevision" in original) ||
    !("coordinatorMode" in original) ||
    original.revisionId !== operation.revisionId ||
    original.expectedCurrentRevisionId !== operation.expectedCurrentRevisionId ||
    original.expectedSourceRevision !== operation.expectedSourceRevision ||
    original.coordinatorMode !== operation.coordinatorMode ||
    record.candidateId !== operation.candidateId ||
    !record.maintenanceId ||
    !record.prepareOperationKey ||
    (canonicalJson(record.affectedServiceIds) !== '["data-manager"]' &&
      !(
        record.privateIntegrationReload?.stagedMigration &&
        record.affectedServiceIds.includes("data-manager")
      ))
  )
    throw Error("Planned coordinator identity changed");
  if (record.privateCoordinatorLifecycle) {
    renderCoordinatorCandidate(candidate, await source.loadAuthority(), source.infraDir);
    return;
  }
  const overlay = record.privateOverlay as { purpose?: unknown; changes?: unknown } | null;
  if (record.privateIntegrationReload?.stagedMigration) {
    if (
      original.kind !== "stack.render" ||
      !overlay ||
      overlay.purpose !== "migration" ||
      !Array.isArray(overlay.changes) ||
      overlay.changes.length > 512 ||
      !["integration-reload", "platform-apply"].includes(record.apiFollowUp ?? "") ||
      overlay.changes.some(
        (change) =>
          !change ||
          typeof change !== "object" ||
          ![
            "service-config",
            "integration-config",
            "service-secret",
            "integration-secret",
            "integration-binding",
            "platform",
            "selection",
          ].includes(change.kind),
      )
    )
      throw Error("Fixed staged migration producer required");
    const managed = overlay.changes.find(
      (change) =>
        change.kind === "service-secret" &&
        change.serviceId === "data-manager" &&
        change.key === "TRANSITOUS_API_KEYS",
    );
    if (
      managed &&
      (record.privateIntegrationReload.stagedMigration.kind !== "credentials" ||
        managed.action !== "set" ||
        candidate.payload.serviceSecrets.find((entry) => entry.serviceId === "data-manager")?.values
          .TRANSITOUS_API_KEYS !== managed.value ||
        !candidate.payload.transitCredentialsRevision)
    )
      throw Error("Original managed migration map required");
    return;
  }

  if (
    original.kind !== "vault.apply" ||
    original.serviceId !== "data-manager" ||
    record.apiFollowUp !== "service-apply" ||
    !overlay ||
    typeof overlay !== "object" ||
    Array.isArray(overlay) ||
    !["service-secret", "transit-credentials"].includes(String(overlay.purpose)) ||
    !Array.isArray(overlay.changes) ||
    !overlay.changes.length ||
    !overlay.changes.every(
      (change) =>
        change &&
        typeof change === "object" &&
        !Array.isArray(change) &&
        change.kind === "service-secret" &&
        change.serviceId === "data-manager",
    )
  )
    throw Error("Fixed planned DM recreation producer required");
  if (overlay.purpose === "transit-credentials") {
    const change = overlay.changes[0] as Record<string, unknown> | undefined;
    if (
      original.coordinatorMode !== "require-running" ||
      overlay.changes.length !== 1 ||
      change?.key !== "TRANSITOUS_API_KEYS" ||
      change.action !== "set" ||
      typeof change.value !== "string" ||
      candidate.payload.serviceSecrets.find((entry) => entry.serviceId === "data-manager")?.values
        .TRANSITOUS_API_KEYS !== change.value ||
      !candidate.payload.transitCredentialsRevision
    )
      throw Error("Fixed managed transit credential producer required");
  } else if (
    overlay.changes.some(
      (change) => (change as Record<string, unknown>).key === "TRANSITOUS_API_KEYS",
    )
  ) {
    throw Error("Managed transit credential producer required");
  }
}
/** Actual publication is stricter than the read-only planned eligibility. */
export async function assertOwnedCoordinatorConfigurationWrite(
  runtime: OpsRuntime,
  context: OpsExecutionContext,
  operation: Extract<OpsOperation, { kind: "stack.render" | "vault.apply" }>,
  signal: AbortSignal,
) {
  await inspectOwnedMaintenanceGenerationRuntime(runtime, context, operation, signal);
  const owner = maintenanceStepOf(context, operation).file;
  if (
    !owner.plan.coordinatorImage ||
    !owner.plan.steps.some(
      (step) =>
        step.phase === "maintenance-recreate" &&
        "serviceId" in step.operation &&
        step.operation.serviceId === "data-manager",
    )
  )
    throw Error("Original frozen DM recreation required");
}

/** What a preparation plans before its lease: the fixed plan and the host as found. */
export type MaintenancePlanning = Readonly<
  Pick<
    MaintenanceFile,
    "plan" | "originalContainers" | "coordinatorPull" | "stagedCoordinatorProvenance"
  >
>;
/** Plans a configuration maintenance from the API's retained candidate and the host. */
export async function planConfigurationMaintenance(
  runtime: OpsRuntime,
  input: {
    installation: ControlInstallation;
    execution: ExecutionRef;
    operation: ConfigurationMaintenancePrepare;
    apiParent: RetainedParentExecution;
    journal: Pick<OpsJobJournal, "records">;
    signal: AbortSignal;
  },
): Promise<MaintenancePlanning> {
  const source = sources.get(runtime);
  if (
    !source?.candidateSource ||
    input.installation.role !== "ops-agent" ||
    input.apiParent.issuer !== "api"
  )
    throw Error("Original API configuration maintenance source required");
  input.signal.throwIfAborted();
  const candidate = await readConfigurationCandidate(
      source.candidateSource,
      input.operation.candidateId,
    ),
    original = candidate.operation;
  if (
    candidate.record.apiJobId !== input.apiParent.apiJobId ||
    candidate.record.parentOperationKey !== input.apiParent.operationKey ||
    candidate.record.parentFingerprint !== input.apiParent.fingerprint ||
    candidate.record.parentDeadlineAt !== input.apiParent.deadlineAt ||
    candidate.record.maintenanceId !== input.operation.maintenanceId ||
    candidate.record.prepareOperationKey !== input.execution.operationKey ||
    candidate.record.operationKey !== input.operation.applyOperationKey ||
    opsOperationFingerprint(original) !== input.operation.applyOperationFingerprint ||
    !("revisionId" in original) ||
    !("expectedCurrentRevisionId" in original) ||
    !("expectedSourceRevision" in original) ||
    !("coordinatorMode" in original) ||
    original.revisionId !== input.operation.revisionId ||
    original.expectedCurrentRevisionId !== input.operation.expectedCurrentRevisionId ||
    original.expectedSourceRevision !== input.operation.expectedSourceRevision ||
    original.coordinatorMode !== input.operation.coordinatorMode ||
    ![
      "stack.render",
      "serviceSelection.apply",
      "serviceConfig.apply",
      "integrationConfig.apply",
      "vault.apply",
    ].includes(original.kind)
  )
    throw Error("Original candidate/parent maintenance binding conflict");
  const platform = candidate.record.privatePlatformIntent;
  if (
    platform &&
    (candidate.record.apiFollowUp !== "platform-apply" ||
      original.kind !== "stack.render" ||
      platform.sourceRevision !== input.operation.expectedSourceRevision ||
      platform.expectedCurrentRevisionId !== input.operation.expectedCurrentRevisionId ||
      canonicalJson(platform.configuration) !== canonicalJson(candidate.payload.platform) ||
      canonicalJson(platform.affectedServiceIds) !==
        canonicalJson(candidate.record.affectedServiceIds))
  )
    throw Error("Original platform candidate binding conflict");
  const release = platform?.release
    ? await preflightConfigurationRelease({
        infraDir: source.infraDir,
        selection: platform.release,
        execFile: source.execFile,
        signal: input.signal,
      })
    : undefined;
  const recreateServiceIds = release
    ? []
    : platform
      ? candidate.record.affectedServiceIds.filter(
          (id) => !protectedConfigurationServiceIdSchema.safeParse(id).success,
        )
      : candidate.record.apiFollowUp === "service-apply" ||
          candidate.record.privateCoordinatorLifecycle ||
          candidate.record.privateIntegrationReload?.stagedMigration
        ? candidate.record.affectedServiceIds
        : [];
  if (
    (platform ? "platform-apply" : recreateServiceIds.length ? "service-apply" : "render-only") !==
    input.operation.followUp
  )
    throw Error("Configuration maintenance continuation unavailable");
  const authority = await source.loadAuthority();
  const coordinator = candidate.record.privateCoordinatorLifecycle
    ? renderCoordinatorCandidate(candidate, authority, source.infraDir)
    : undefined;
  if (coordinator)
    verifyConfigurationReleaseSourceWitness({
      installation: input.installation,
      infraDir: source.infraDir,
      sourceRevision: input.operation.expectedSourceRevision,
      expectedCurrentRevisionId: input.operation.expectedCurrentRevisionId,
      authorityRevision: authority.revisionId,
    });
  verifyConfigurationSourceWitness({
    installation: input.installation,
    infraDir: source.infraDir,
    sourceRevision: input.operation.expectedSourceRevision,
    expectedCurrentRevisionId: input.operation.expectedCurrentRevisionId,
    authorityRevision: authority.revisionId,
  });
  const desired = services.readDesiredSelection(source.infraDir);
  const rendered = services.renderConfiguration({
    infraDir: source.infraDir,
    services: authority.services,
    integrationSchemas: authority.integrationSchemas,
    input: {
      ...candidate.payload,
      selectedRoots: candidate.payload.selectedRoots ?? desired.roots,
    },
    allowMissingSelected: !candidate.payload.selectedRoots && desired.source === "default",
    ...(release
      ? { release: services.parseReleaseManifest(release.canonicalManifest, release.imagePrefix) }
      : {}),
  });
  const prospective = new Set(rendered.resolved.enabled.map((service) => service.manifest.id));
  if (!prospective.has("data-manager") || recreateServiceIds.some((id) => !prospective.has(id)))
    throw Error("Configuration maintenance coordinator/target prerequisite unavailable");
  const current = services.readAppliedServiceIds(source.infraDir, authority.services);
  if (!current) throw Error("Current configuration generation required for maintenance");
  const serviceIds = [
    ...new Set([
      ...current,
      ...prospective,
      ...candidate.record.affectedServiceIds,
      "data-manager",
    ]),
  ].sort();
  const plan = rendered.rendered.hardlinkPlan;
  if (plan.length && input.operation.coordinatorMode === "ensure-running" && !coordinator) {
    if (
      !input.operation.expectedCurrentRevisionId ||
      candidate.record.coordinatorPrerequisite?.operation.expectedConfigurationRevisionId !==
        input.operation.expectedCurrentRevisionId
    )
      throw Error("Original settled old-revision coordinator prerequisite required");
    verifyMaintenanceCoordinatorPrerequisite(input.installation, candidate.record);
  }
  let coordinatorPull: CoordinatorPullWitness | undefined,
    coordinatorBaseline: VerifiedCoordinatorPullBaseline | undefined,
    coordinatorImage: FixedConfigurationMaintenancePlan["coordinatorImage"];
  if (coordinator) {
    const fixed = coordinatorCandidateMetadata(candidate.record);
    // A used helper remains an exact settled original. An already-ready old
    // coordinator needs no Compose up and is observed again above.
    const helper = candidate.record.coordinatorPrerequisite;
    if (helper) {
      let present = false;
      try {
        readPrivateRecord(
          installationState(input.installation),
          "executions",
          `${helper.root.operationKey}.json`,
          65536,
        );
        present = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (present) verifyMaintenanceCoordinatorPrerequisite(input.installation, candidate.record);
    }
    if (fixed.action === "update") {
      const matches = input.journal
        .records()
        .filter((job) => job.role === "api" && job.operationKey === fixed.pull.operationKey);
      if (!matches || matches.length !== 1)
        throw Error("Unique original coordinator pull source unavailable");
      const job = matches[0]!;
      if (
        job.operation.kind !== "service.pull" ||
        job.state !== "succeeded" ||
        canonicalJson(job.operation) !== canonicalJson(fixed.pull.operation)
      )
        throw Error("Actual successful current coordinator pull required");
      const status = parseOpsJobStatus({
        version: 2,
        admittedAt: job.admittedAt,
        deadlineAt: job.deadlineAt,
        fingerprint: job.fingerprint,
        operationId: job.operationId,
        operationKey: job.operationKey,
        kind: job.operation.kind,
        resourceId: job.resourceId,
        state: job.state,
        submittedAt: job.submittedAt,
        updatedAt: job.updatedAt,
        result: job.result,
        ...(job.terminationRequestedAt
          ? { terminationRequestedAt: job.terminationRequestedAt }
          : {}),
      });
      coordinatorPull = observeCoordinatorPullForMaintenance(
        input.installation,
        candidate.record,
        input.execution,
        status,
      );
      coordinatorBaseline = observedCoordinatorPullBaseline(coordinatorPull);

      const proof = coordinatorPull && coordinatorPullWitnessPayloadSchema.parse(coordinatorPull);
      if (
        !proof ||
        proof.imageReference !== coordinator.imageReference ||
        proof.releaseSelectionDigest !== coordinator.releaseSelectionDigest ||
        proof.submissionDigest !== coordinatorPullSubmissionDigest(fixed.pull)
      )
        throw Error("Original pulled coordinator image source changed");
      coordinatorImage = {
        action: "update",
        noDeps: fixed.noDeps,
        imageReference: proof.imageReference,
        imageId: proof.imageId,
        releaseSelectionDigest: proof.releaseSelectionDigest,
        pullSubmissionDigest: proof.submissionDigest,
      };
    } else {
      const observed = await source.execFile(
        "docker",
        ["image", "inspect", "--format", "{{.Id}}", coordinator.imageReference],
        { signal: input.signal, timeout: 15000, maxBuffer: 4096 },
      );
      coordinatorImage = {
        action: "apply",
        noDeps: false,
        imageReference: coordinator.imageReference,
        imageId: observed.stdout.trim(),
        releaseSelectionDigest: coordinator.releaseSelectionDigest,
        pullSubmissionDigest: null,
      };
    }
  }
  if (!coordinator && recreateServiceIds.includes("data-manager")) {
    verifyConfigurationReleaseSourceWitness({
      installation: input.installation,
      infraDir: source.infraDir,
      sourceRevision: input.operation.expectedSourceRevision,
      expectedCurrentRevisionId: input.operation.expectedCurrentRevisionId,
      authorityRevision: authority.revisionId,
    });
    const selected = services.readServiceReleaseImageSelection(source.infraDir, "data-manager"),
      imageReference =
        selected.imageReference ??
        services.configurationImageReference(rendered.rendered.composeYaml, "data-manager");
    const actual = await source.execFile(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", imageReference],
      { signal: input.signal, timeout: 15000, maxBuffer: 4096 },
    );
    coordinatorImage = {
      action: "apply",
      noDeps: false,
      imageReference,
      imageId: actual.stdout.trim(),
      releaseSelectionDigest: selected.releaseSelectionDigest,
      pullSubmissionDigest: null,
    };
  }
  const staged =
    !coordinatorBaseline && recreateServiceIds.includes("data-manager")
      ? await inspectStagedCoordinatorMaintenanceSource(source.ownedServices, input.signal)
      : undefined;
  const originalContainers = coordinatorBaseline
    ? await inspectOriginalCoordinatorServices(
        source.ownedServices,
        coordinatorBaseline,
        input.signal,
      )
    : (staged?.services ?? (await source.ownedServices.inspectOwnedServices(input.signal)));
  if (
    originalContainers.find((service) => service.serviceId === "data-manager")?.state !== "running"
  )
    throw Error("Settled ready coordinator prerequisite required before maintenance");
  await assertConfigurationCoordinatorReady(input.signal);
  const previewDigest = createHash("sha256")
    .update("openmapx-configuration-hardlinks-preview-v1\0")
    .update(
      canonicalJson({
        candidateId: input.operation.candidateId,
        revisionId: input.operation.revisionId,
        expectedSourceRevision: input.operation.expectedSourceRevision,
        coordinatorMode: input.operation.coordinatorMode,
        plan,
      }),
    )
    .digest("hex");
  if (release) {
    const targets = rendered.resolved.enabled
      .map((entry) => entry.manifest.id)
      .filter((id) => Object.hasOwn(release.serviceImages, id))
      .sort();
    if (canonicalJson(targets) !== canonicalJson(platform!.affectedServiceIds))
      throw Error("Exact enabled checked release targets required");
  }
  const protectedIds = release
    ? platform!.affectedServiceIds
    : platform
      ? platform.affectedServiceIds.filter(
          (id) => protectedConfigurationServiceIdSchema.safeParse(id).success,
        )
      : [];
  const handoff =
    platform && protectedIds.length
      ? {
          handoffId: platform.handoffId,
          previewFingerprint: platform.previewFingerprint,
          serviceIds: protectedIds,
          expectedImageIdentities: Object.fromEntries(
            protectedIds.map((id) => {
              const old = originalContainers.find((value) => value.serviceId === id);
              if (
                !old ||
                (release && !["running", "stopped", "created"].includes(old.state)) ||
                (!release && old.state !== "running") ||
                (release && ["data-manager", "ops-agent"].includes(id) && old.state !== "running")
              )
                throw Error("Original handoff target unavailable");
              return [id, old.provenance.imageId];
            }),
          ),
          mode: release
            ? {
                kind: "release" as const,
                releaseId: release.releaseId,
                manifestDigest: release.manifestDigest,
              }
            : { kind: "configuration" as const },
        }
      : undefined;
  const frozen = buildFixedConfigurationMaintenancePlan({
    prepare: input.execution,
    operation: input.operation,
    apiParent: input.apiParent,
    apply: original as Parameters<typeof buildFixedConfigurationMaintenancePlan>[0]["apply"],
    candidateRecordDigest: createHash("sha256")
      .update(canonicalJson(candidate.record))
      .digest("hex"),
    sourceAuthorityRevision: authority.revisionId,
    previewDigest,
    hardlinkPlan: { plan, prune: true },
    serviceIds,
    recreateServiceIds,
    ...(handoff ? { handoff } : {}),
    ...(release ? { release } : {}),
    ...(coordinatorImage ? { coordinatorImage } : {}),
  });
  if (
    (await source.loadAuthority()).revisionId !== authority.revisionId ||
    services.currentConfigurationGeneration(source.infraDir) !==
      input.operation.expectedCurrentRevisionId
  )
    throw Error("Configuration maintenance preflight drifted");
  const stagedSource = staged?.proof && verifiedStagedCoordinatorOwnershipState(staged.proof);
  if (
    stagedSource &&
    (coordinatorPull ||
      stagedSource.source.baseline.configurationRevisionId !==
        input.operation.expectedCurrentRevisionId)
  )
    throw Error("Original staged maintenance source changed");
  const stagedCoordinatorProvenance = stagedSource
    ? stagedCoordinatorObservationSchema.parse({
        version: 1,
        ownerPrepare: input.execution,
        candidateId: input.operation.candidateId,
        planDigest: frozen.planDigest,
        source: stagedSource.source,
        capturedAt: Date.now(),
      })
    : undefined;
  return {
    plan: frozen,
    originalContainers: structuredClone(originalContainers),
    ...(coordinatorPull ? { coordinatorPull } : {}),
    ...(stagedCoordinatorProvenance ? { stagedCoordinatorProvenance } : {}),
  };
}

async function inspectOriginalOwnerServices(
  source: Source,
  installation: ControlInstallation,
  file: MaintenanceFile,
  signal: AbortSignal,
) {
  const root = restoreAdmittedControlExecution(installation, file.plan.prepare);
  return file.plan.coordinatorImage?.action === "update"
    ? inspectOriginalCoordinatorServices(
        source.ownedServices,
        ownedCoordinatorPullBaseline(root),
        signal,
      )
    : file.stagedCoordinatorProvenance
      ? inspectStagedCoordinatorOwnerServices(
          source.ownedServices,
          ownedStagedCoordinatorBaseline(root),
          signal,
        )
      : source.ownedServices.inspectOwnedServices(signal);
}
