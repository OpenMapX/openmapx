/** Fixed same-image helper effects. Only Docker process I/O is replaceable in
 * tests; ownership, source checks, ordering and verification are installed. */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  assertArtifactTargetLeaseForward,
  beginControlEffect,
  controlDigest,
  controlRolePublicKey,
  readPrivateRecord,
  retainControlEffectReceipt,
  settleArtifactTargetLeaseChild,
  signControl,
  verifyControl,
  verifyControlEffectSettlement,
  verifyFamilyOwnedRecord,
  writePrivateRecord,
} from "@openmapx/core/build-artifacts";
import { canonicalJson } from "@openmapx/core/ops";
import { atomicWrite } from "@openmapx/core/release-files";
import { repoPaths, services } from "@openmapx/core/server";
import {
  type ConfigurationHandoffWorkerRecord,
  configurationHandoffProgressSchema,
  configurationHandoffWorkerRecordSchema,
  configurationHandoffRecordDomains as domains,
  configurationHandoffRecordName as name,
} from "../../../packages/core/src/build-artifacts/configuration-handoff-records";
import { maintenanceDockerContainerSchema } from "../../../packages/core/src/build-artifacts/configuration-maintenance-docker-records";
import { configurationMaintenanceOwnerRecordSchema } from "../../../packages/core/src/build-artifacts/configuration-maintenance-owner-records";
import {
  readConfigurationHandoffReleaseOverlay,
  readConfigurationHandoffReleaseState,
} from "../../../packages/core/src/build-artifacts/configuration-source-witness";
import { installationState } from "../../../packages/core/src/build-artifacts/control-authority";
import { configurationHandoffServiceOrder } from "./configuration-handoff";
import {
  assertConfigurationHandoffHostSources,
  type ConfigurationHandoffChild,
  configurationHandoffChildState,
  waitForConfigurationHandoffPreparation,
} from "./configuration-handoff-control";
import { inspectMaintenanceDockerRuntime } from "./configuration-maintenance-docker-inspection";
import { readCheckedConfigurationRelease } from "./configuration-release";
import { inspectConfigurationReleaseImages } from "./configuration-release-images";
import { type DockerRuntimeOptions, runContainedProcess } from "./docker-runtime";
import { createOwnedServiceResolver } from "./owned-services";
import { createTrustedConfigurationAuthorityLoader } from "./trusted-configuration-authority";

const running = new WeakSet<ConfigurationHandoffChild>();
function ownerFor(child: ConfigurationHandoffChild) {
  const state = configurationHandoffChildState(child),
    local = installationState(state.installation),
    intent = state.intent,
    file = `${intent.operation.maintenanceId}.json`,
    raw = readPrivateRecord(local, "configuration-maintenance", file),
    owner = verifyControl(
      controlRolePublicKey(state.installation, "ops-agent"),
      "openmapx-configuration-maintenance-owner-v2",
      raw,
      configurationMaintenanceOwnerRecordSchema,
    ),
    step = owner.plan.steps.find((value) => value.phase === "maintenance-handoff"),
    source = step && owner.apiControls.steps.find((value) => value.ordinal === step.ordinal);
  verifyFamilyOwnedRecord(
    local,
    intent.origin,
    { scope: "private", namespace: "configuration-maintenance", container: "", name: file },
    canonicalJson(raw),
  );
  if (
    canonicalJson(owner.origin) !== canonicalJson(intent.origin) ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(intent.ownerPrepare) ||
    owner.rootCertificateDigest !== intent.ownerCertificateDigest ||
    !step ||
    canonicalJson(step.operation) !== canonicalJson(intent.operation) ||
    !source?.grant ||
    canonicalJson(source.execution) !== canonicalJson(intent.preparer) ||
    source.grant.leaseId !== intent.leaseId ||
    owner.issuance !== "open" ||
    owner.noGuard ||
    owner.final ||
    owner.inspection ||
    !owner.guardSource ||
    (intent.release !== undefined) !== (owner.plan.release !== undefined) ||
    (intent.release && canonicalJson(intent.release) !== canonicalJson(owner.plan.release)) ||
    owner.receipt.dmFence?.state !== "prepared" ||
    owner.receipt.state !== "applying" ||
    owner.receipt.decision?.decision !== "continue" ||
    !owner.apiControls.decide?.receiptDelivery ||
    owner.receipt.generation !== "committed" ||
    owner.receipt.appliedRevisionId !== intent.operation.expectedCurrentRevisionId ||
    (intent.operation.mode.kind === "release" && !intent.release)
  )
    throw Error("Original active configuration handoff owner required");
  return owner;
}

/** This result describes observed helper runtime only. The parent/root remain
 * held until the independent effect/physical/final/SQL/ACK chain settles. */
export async function runConfigurationHandoffApplication(input: {
  child: ConfigurationHandoffChild;
  rootDir: string;
  execFile?: DockerRuntimeOptions["execFile"];
  signal?: AbortSignal;
}) {
  const { child } = input;
  const state = configurationHandoffChildState(child);
  if (running.has(child)) throw Error("Original helper already running");
  running.add(child);
  const local = installationState(state.installation),
    intent = state.intent,
    signal = AbortSignal.any([
      input.signal ?? new AbortController().signal,
      AbortSignal.timeout(Math.max(1, intent.helper.deadlineAt - Date.now())),
    ]),
    execFile = input.execFile ?? runContainedProcess,
    stack = repoPaths(input.rootDir),
    file = name(intent.operation.handoffId, "completion");
  let worker: ConfigurationHandoffWorkerRecord | undefined;
  const save = (next: ConfigurationHandoffWorkerRecord, exclusive = false) => {
    const value = configurationHandoffWorkerRecordSchema.parse(next);
    writePrivateRecord(
      local,
      "observations",
      file,
      signControl(local.privateKey, domains.completion, value),
      exclusive,
      intent.origin,
    );
    worker = value;
  };
  try {
    await waitForConfigurationHandoffPreparation(child, signal);
    assertConfigurationHandoffHostSources(child);
    if (stack.infraDir !== join(input.rootDir, "infra/docker"))
      throw Error("Original helper checkout required");
    const capture = await services.captureReleaseServiceAuthority(input.rootDir),
      loadAuthority = createTrustedConfigurationAuthorityLoader({
        rootDir: input.rootDir,
        builtInServices: capture.services,
        builtInAuthorityDigest: capture.digest,
      }),
      owned = createOwnedServiceResolver({ stack, execFile, loadAuthority }),
      parentName = name(intent.operation.handoffId, "progress"),
      parentRaw = readPrivateRecord(local, "observations", parentName),
      parent = verifyControl(
        controlRolePublicKey(state.installation, "ops-agent"),
        domains.progress,
        parentRaw,
        configurationHandoffProgressSchema,
      );
    verifyFamilyOwnedRecord(
      local,
      intent.origin,
      { scope: "private", namespace: "observations", container: "", name: parentName },
      canonicalJson(parentRaw),
    );
    if (
      parent.intentDigest !== controlDigest(intent) ||
      parent.phase !== "launched" ||
      parent.launch.state !== "confirmed"
    )
      throw Error("Original confirmed launch required");
    // Existing worker publication is observation-only, never another dispatch.
    try {
      readPrivateRecord(local, "observations", file);
      throw Error("Original attempted helper requires observation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    beginControlEffect(state.authority);
    save(
      {
        ...parent,
        execution: intent.helper,
        preparationDigest: controlDigest(parent),
        observations: [],
        ...(intent.release
          ? {
              release: {
                images: intent.release.downloads.images.map((image) => ({
                  image: image.image,
                  reference: image.reference,
                  phase: "pending" as const,
                  imageId: null,
                })),
                publication: "not_attempted" as const,
                overlay: null,
                statePublication: "not_attempted" as const,
                state: null,
              },
            }
          : {}),
        sequence: 0,
        phase: "draining",
        updatedAt: Date.now(),
      },
      true,
    );
    if (intent.release) {
      const release = intent.release;
      for (const image of release.downloads.images) {
        await services.withConfigurationGenerationWriter(
          stack.infraDir,
          async () => {
            const lock = await services.acquireReleaseStoreLock(
              join(stack.infraDir, ".ops-agent-releases"),
            );
            try {
              assertArtifactTargetLeaseForward(state.lease);
              assertConfigurationHandoffHostSources(child);
              ownerFor(child);
              readCheckedConfigurationRelease(stack.infraDir, {
                releaseId: release.releaseId,
                manifestDigest: release.manifestDigest,
              });
              const current = worker!;
              if (
                current.release!.images.find((value) => value.image === image.image)?.phase !==
                "pending"
              )
                throw Error("Original attempted release pull requires observation");
              save({
                ...current,
                sequence: current.sequence + 1,
                release: {
                  ...current.release!,
                  images: current.release!.images.map((value) =>
                    value.image === image.image ? { ...value, phase: "attempted" } : value,
                  ),
                },
                updatedAt: Date.now(),
              });
            } finally {
              lock.release();
            }
          },
          signal,
        );
        // No writer lock spans external pull/recreation. The original target
        // closure and deadline survive this fixed awaited process.
        assertArtifactTargetLeaseForward(state.lease);
        assertConfigurationHandoffHostSources(child);
        await execFile(
          "docker",
          ["image", "pull", "--platform", release.downloads.platform, image.reference],
          {
            signal,
            timeout: Math.max(1, intent.helper.deadlineAt - Date.now()),
            maxBuffer: 1024 * 1024,
          },
        );
        const [observed] = await inspectConfigurationReleaseImages({
          downloads: release.downloads,
          image: image.image,
          execFile,
          signal,
        });
        if (!observed) throw Error("Original completed release pull unavailable");
        const current = worker!;
        save({
          ...current,
          sequence: current.sequence + 1,
          release: {
            ...current.release!,
            images: current.release!.images.map((value) =>
              value.image === image.image
                ? { ...value, phase: "verified", imageId: observed.imageId }
                : value,
            ),
          },
          updatedAt: Date.now(),
        });
      }
      await services.withConfigurationGenerationWriter(
        stack.infraDir,
        async () => {
          const lock = await services.acquireReleaseStoreLock(
            join(stack.infraDir, ".ops-agent-releases"),
          );
          try {
            assertArtifactTargetLeaseForward(state.lease);
            assertConfigurationHandoffHostSources(child);
            ownerFor(child);
            const checked = readCheckedConfigurationRelease(stack.infraDir, {
                releaseId: release.releaseId,
                manifestDigest: release.manifestDigest,
              }),
              current = worker!;
            if (
              current.release!.images.some((image) => image.phase !== "verified") ||
              canonicalJson(readConfigurationHandoffReleaseOverlay(stack.infraDir)) !==
                canonicalJson(intent.previousReleaseOverlay)
            )
              throw Error("Original release publication source changed");
            save({
              ...current,
              sequence: current.sequence + 1,
              phase: "applying",
              release: { ...current.release!, publication: "attempted" },
              updatedAt: Date.now(),
            });
            services.writeReleaseComposeArtifacts(checked.manifest, stack.composeReleasePath);
            const published = readConfigurationHandoffReleaseOverlay(stack.infraDir);
            if (
              !published ||
              Buffer.from(published.bytes, "base64").toString("utf8") !==
                services.renderReleaseCompose(checked.manifest)
            )
              throw Error("Original release overlay publication incomplete");
            save({
              ...worker!,
              sequence: worker!.sequence + 1,
              release: { ...worker!.release!, publication: "published", overlay: published },
              updatedAt: Date.now(),
            });
          } finally {
            lock.release();
          }
        },
        signal,
      );
      assertConfigurationHandoffHostSources(child);
    }
    const inspectTarget = async (id: string, owner: ReturnType<typeof ownerFor>) => {
      if (!intent.release)
        return (await owned.inspectOwnedServices(signal)).find((value) => value.serviceId === id);
      // A changed overlay must not weaken the general owned-service resolver.
      // Only this original owner may retain its exact old immutable container.
      const original = owner.originalContainers.find((value) => value.serviceId === id);
      if (!original) throw Error("Original release container required");
      const result = await execFile(
        "docker",
        ["container", "inspect", "--format", "{{json .}}", original.containerId],
        { signal, timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      if (Buffer.byteLength(result.stdout) > 1024 * 1024)
        throw Error("Original container observation capacity");
      const observed = maintenanceDockerContainerSchema.parse(JSON.parse(result.stdout)),
        labels = observed.Config.Labels;
      if (
        observed.Id !== original.containerId ||
        observed.Image !== original.provenance.imageId ||
        labels["com.docker.compose.project"] !== original.provenance.project ||
        labels["com.docker.compose.service"] !== id ||
        realpathSync(labels["com.docker.compose.project.working_dir"]!) !==
          original.provenance.composeWorkingDirectory ||
        canonicalJson(
          labels["com.docker.compose.project.config_files"]
            ?.split(",")
            .map((path) => realpathSync(path.trim())),
        ) !== canonicalJson(original.provenance.composeConfigFiles) ||
        (original.state === "running"
          ? !observed.State.Running || observed.State.Status !== "running"
          : observed.State.Running ||
            (original.state === "created"
              ? observed.State.Status !== "created"
              : !["exited", "dead"].includes(observed.State.Status)))
      )
        throw Error("Original release container changed");
      return original;
    };
    for (const id of configurationHandoffServiceOrder(intent.operation.serviceIds)) {
      signal.throwIfAborted();
      const owner = ownerFor(child),
        authority = await loadAuthority();
      if (authority.revisionId !== owner.plan.sourceAuthorityRevision)
        throw Error("Original helper authority changed");
      const target = await inspectTarget(id, owner),
        original = owner.originalContainers.find((value) => value.serviceId === id);
      if (
        !target ||
        !original ||
        target.containerId !== original.containerId ||
        (!intent.release && target.state !== "running") ||
        target.provenance.imageId !== intent.operation.expectedImageIdentities[id]
      )
        throw Error("Original helper target changed");
      const args = await services.withConfigurationGenerationWriter(
        stack.infraDir,
        async () => {
          const release = await services.acquireReleaseStoreLock(
            join(stack.infraDir, ".ops-agent-releases"),
          );
          try {
            assertArtifactTargetLeaseForward(state.lease);
            assertConfigurationHandoffHostSources(child);
            ownerFor(child);
            if (
              (await loadAuthority()).revisionId !== owner.plan.sourceAuthorityRevision ||
              services.currentConfigurationGeneration(stack.infraDir) !==
                intent.operation.expectedCurrentRevisionId
            )
              throw Error("Original helper generation changed");
            const fresh = await inspectTarget(id, ownerFor(child));
            if (!fresh || canonicalJson(fresh) !== canonicalJson(target))
              throw Error("Original helper target raced");
            if (intent.release) {
              const reference =
                  intent.release.serviceImages[id as keyof typeof intent.release.serviceImages],
                pulled = worker!.release!.images.find((value) => value.reference === reference);
              if (!pulled || pulled.phase !== "verified")
                throw Error("Original verified release image required");
              const [observed] = await inspectConfigurationReleaseImages({
                downloads: intent.release.downloads,
                image: pulled.image,
                execFile,
                signal,
              });
              if (observed?.imageId !== pulled.imageId)
                throw Error("Original pulled release image changed");
            }
            const current = worker!;
            save({
              ...current,
              sequence: current.sequence + 1,
              phase: "applying",
              targets: current.targets.map((value) =>
                value.serviceId === id ? { ...value, phase: "recreate_attempted" } : value,
              ),
              updatedAt: Date.now(),
            });
            return [
              ...services.stackComposeArgs(stack),
              "up",
              "-d",
              "--force-recreate",
              "--no-deps",
              id,
            ];
          } finally {
            release.release();
          }
        },
        signal,
      );
      // No configuration/release writer survives container replacement.
      assertArtifactTargetLeaseForward(state.lease);
      assertConfigurationHandoffHostSources(child);
      await execFile("docker", args, {
        signal,
        timeout: Math.max(1, intent.helper.deadlineAt - Date.now()),
        maxBuffer: 1024 * 1024,
      });
      const containers = await owned.inspectOwnedServices(signal),
        inspection = await inspectMaintenanceDockerRuntime({
          stack,
          execFile,
          owner: ownerFor(child),
          containers,
          privateKey: local.privateKey,
          signal,
          handoffTargetId: id,
        }),
        observed = containers.find((value) => value.serviceId === id);
      if (!observed) throw Error("Applied helper container unavailable");
      const current = worker!;
      save({
        ...current,
        sequence: current.sequence + 1,
        phase: "verifying",
        targets: current.targets.map((value) =>
          value.serviceId === id
            ? { ...value, phase: "verified", newContainerId: observed.containerId }
            : value,
        ),
        observations: [
          ...current.observations,
          {
            serviceId: id,
            checksDigest: controlDigest(inspection.checks),
            detailsDigest: controlDigest(inspection.details),
          },
        ],
        updatedAt: Date.now(),
      });
    }
    const owner = ownerFor(child);
    assertConfigurationHandoffHostSources(child);
    await inspectMaintenanceDockerRuntime({
      stack,
      execFile,
      owner,
      containers: await owned.inspectOwnedServices(signal),
      privateKey: local.privateKey,
      signal,
    });
    if (intent.release) {
      await services.withConfigurationGenerationWriter(
        stack.infraDir,
        async () => {
          const lock = await services.acquireReleaseStoreLock(
            join(stack.infraDir, ".ops-agent-releases"),
          );
          try {
            assertArtifactTargetLeaseForward(state.lease);
            assertConfigurationHandoffHostSources(child);
            const owner = ownerFor(child);
            readCheckedConfigurationRelease(stack.infraDir, {
              releaseId: intent.release!.releaseId,
              manifestDigest: intent.release!.manifestDigest,
            });
            if (
              owner.plan.apiParent.issuer !== "api" ||
              canonicalJson(readConfigurationHandoffReleaseState(stack.infraDir)) !==
                canonicalJson(intent.previousReleaseState)
            )
              throw Error("Original release state publication source changed");
            const current = worker!,
              bytes = JSON.stringify({
                releaseId: intent.release!.releaseId,
                digest: intent.release!.manifestDigest,
                updateJobId: owner.plan.apiParent.apiJobId,
              });
            save({
              ...current,
              sequence: current.sequence + 1,
              release: { ...current.release!, statePublication: "attempted" },
              updatedAt: Date.now(),
            });
            atomicWrite(join(stack.infraDir, ".ops-agent-releases", "current.json"), bytes);
            const published = readConfigurationHandoffReleaseState(stack.infraDir);
            if (!published || Buffer.from(published.bytes, "base64").toString("utf8") !== bytes)
              throw Error("Original release state publication incomplete");
            save({
              ...worker!,
              sequence: worker!.sequence + 1,
              release: { ...worker!.release!, statePublication: "published", state: published },
              updatedAt: Date.now(),
            });
          } finally {
            lock.release();
          }
        },
        signal,
      );
    }
    const completedAt = Date.now(),
      current = worker!;
    save({
      ...current,
      sequence: current.sequence + 1,
      phase: "applied",
      updatedAt: completedAt,
      completedAt,
    });
    retainControlEffectReceipt(state.authority, {
      outcome: "committed",
      publication: "committed",
      receipt: { kind: "configuration-helper-completion", completionDigest: controlDigest(worker) },
    });
    await settleArtifactTargetLeaseChild(
      state.lease,
      verifyControlEffectSettlement(state.installation, intent.helper),
    );
    return {
      phase: "applied" as const,
      completedServiceIds: configurationHandoffServiceOrder(intent.operation.serviceIds),
    };
  } catch (error) {
    if (worker && worker.completedAt === null) {
      try {
        save({
          ...worker,
          sequence: worker.sequence + 1,
          phase: "recovery_required",
          updatedAt: Date.now(),
        });
      } catch {
        /* Unknown publication retains the original root. */
      }
    }
    throw error;
  } finally {
    running.delete(child);
  }
}
