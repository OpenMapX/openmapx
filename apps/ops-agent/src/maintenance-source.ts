/** Planning a configuration maintenance from the API's retained candidate and the
 * host, and the checks its steps run against the maintenance's own record. */
import { createHash } from "node:crypto";
import {
  buildFixedConfigurationMaintenancePlan,
  type ControlInstallation,
  type FixedConfigurationMaintenancePlan,
  verifyConfigurationSourceWitness,
  verifyMaintenanceCoordinatorPrerequisite,
} from "@openmapx/core/build-artifacts";
import {
  type ConfigurationMaintenancePrepare,
  canonicalJson,
  type ExecutionRef,
  type OpsOperation,
  opsOperationFingerprint,
  protectedConfigurationServiceIdSchema,
  type RetainedParentExecution,
  servicePullResultSchema,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import type { MaintenanceFile } from "../../../packages/core/src/build-artifacts/maintenance-file";
import { installationState } from "../../../packages/core/src/build-artifacts/private-records";
import {
  type ConfigurationCandidateSource,
  readConfigurationCandidate,
} from "./configuration-candidate-source";
import { assertConfigurationCoordinatorReady } from "./configuration-hardlinks-runtime";
import { preflightConfigurationRelease } from "./configuration-release-preflight";
import type { DockerRuntimeOptions } from "./docker-runtime";
import type { OpsJobJournal } from "./journal";
import { readMaintenance } from "./maintenance";
import type { OwnedServiceResolver } from "./owned-services";
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
/** A managed CLI command the agent runs for one of these operations holds the
 * whole registered target closure under its own lease. */
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
}

/** What a maintenance's commit step puts in its generation: the release it
 * pins, if any, and the coordinator image it pulled or applies, if any. */
export function readMaintenancePlan(installation: ControlInstallation, maintenanceId: string) {
  const { release, coordinatorImage } = readMaintenance(installation, maintenanceId).plan;
  return { release, coordinatorImage };
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
function maintenanceStepOf(
  context: Pick<OpsExecutionContext, "controlAuthority" | "artifactLease">,
  operation: { maintenanceId?: string | undefined },
) {
  if (!context.controlAuthority || !context.artifactLease || !operation.maintenanceId)
    throw Error("Maintenance step child required");
  const child = context.controlAuthority,
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

/** The commit step of the running maintenance, before its generation exists. */
export function assertMaintenanceGenerationStep(
  context: OpsExecutionContext,
  operation: Extract<OpsOperation, { kind: "stack.render" | "vault.apply" }>,
) {
  const { file, step } = maintenanceStepOf(context, operation);
  if (step.phase !== "configuration-commit" || file.record.generation !== "not_started")
    throw Error("Maintenance generation step changed");
}
/** A recreate step of the running maintenance. */
export function assertOwnedMaintenanceRecreateRuntime(
  operation: OpsOperation,
  context: Pick<OpsExecutionContext, "controlAuthority" | "artifactLease">,
) {
  if (operation.kind !== "service.recreate" && operation.kind !== "service.recreateIsolated")
    throw Error("Maintenance recreate step required");
  if (maintenanceStepOf(context, operation).step.phase !== "maintenance-recreate")
    throw Error("Maintenance recreate step changed");
}

/** What a preparation plans before its lease: the fixed plan and the host as found. */
export type MaintenancePlanning = Readonly<Pick<MaintenanceFile, "plan" | "originalContainers">>;
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
  // Another change committed since the candidate's sources were read (or they
  // expired): the candidate is stale, which the API reports as a conflict.
  try {
    verifyConfigurationSourceWitness({
      installation: input.installation,
      infraDir: source.infraDir,
      sourceRevision: input.operation.expectedSourceRevision,
      expectedCurrentRevisionId: input.operation.expectedCurrentRevisionId,
      authorityRevision: authority.revisionId,
    });
  } catch {
    throw new OpsExecutionFailure("conflict", {});
  }
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
    await verifyMaintenanceCoordinatorPrerequisite(input.installation, candidate.record);
  }
  let coordinatorImage: FixedConfigurationMaintenancePlan["coordinatorImage"];
  if (coordinator) {
    const fixed = coordinatorCandidateMetadata(candidate.record);
    // A used helper remains an exact settled original. An already-ready old
    // coordinator needs no Compose up and is observed again above.
    const helper = candidate.record.coordinatorPrerequisite;
    if (helper) {
      if (await installationState(input.installation).rows.read(helper.root.operationKey))
        await verifyMaintenanceCoordinatorPrerequisite(input.installation, candidate.record);
    }
    if (fixed.action === "update") {
      // The image this update pulled, as the agent's own journal recorded the
      // result of the pull that names this candidate; the commit step records
      // it in the generation.
      const matches = input.journal
        .records()
        .filter(
          (job) =>
            job.role === "api" &&
            job.operation.kind === "service.pull" &&
            job.operation.serviceId === "data-manager" &&
            job.operation.candidateId === candidate.record.candidateId,
        );
      const job = matches.length === 1 ? matches[0] : undefined;
      if (job?.state !== "succeeded")
        throw Error("Actual successful current coordinator pull required");
      const pulled = servicePullResultSchema.parse(job.result);
      if (
        pulled.revisionId !== input.operation.expectedCurrentRevisionId ||
        pulled.imageReference !== coordinator.imageReference ||
        pulled.releaseSelectionDigest !== coordinator.releaseSelectionDigest
      )
        throw Error("Original pulled coordinator image source changed");
      coordinatorImage = {
        action: "update",
        noDeps: fixed.noDeps,
        imageReference: pulled.imageReference,
        imageId: pulled.imageId,
        releaseSelectionDigest: pulled.releaseSelectionDigest,
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
      };
    }
  }
  if (!coordinator && recreateServiceIds.includes("data-manager")) {
    verifyConfigurationSourceWitness({
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
    };
  }
  // The containers as the maintenance finds them; each recreate replaces one.
  const originalContainers = await source.ownedServices.inspectOwnedServices(input.signal);
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
    if (!platform || canonicalJson(targets) !== canonicalJson(platform.affectedServiceIds))
      throw Error("Exact enabled checked release targets required");
  }
  const protectedIds = !platform
    ? []
    : release
      ? platform.affectedServiceIds
      : platform.affectedServiceIds.filter(
          (id) => protectedConfigurationServiceIdSchema.safeParse(id).success,
        );
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
  return { plan: frozen, originalContainers: structuredClone(originalContainers) };
}
