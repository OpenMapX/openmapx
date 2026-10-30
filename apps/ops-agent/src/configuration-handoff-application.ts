/** Fixed same-image helper effects. Only Docker process I/O is replaceable in
 * tests; ownership, source checks, ordering and verification are installed. */
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
import { repoPaths, services } from "@openmapx/core/server";
import {
  type ConfigurationHandoffWorkerRecord,
  configurationHandoffProgressSchema,
  configurationHandoffWorkerRecordSchema,
  configurationHandoffRecordDomains as domains,
  configurationHandoffRecordName as name,
} from "../../../packages/core/src/build-artifacts/configuration-handoff-records";
import { configurationMaintenanceOwnerRecordSchema } from "../../../packages/core/src/build-artifacts/configuration-maintenance-owner-records";
import { installationState } from "../../../packages/core/src/build-artifacts/control-authority";
import { configurationHandoffServiceOrder } from "./configuration-handoff";
import {
  assertConfigurationHandoffHostSources,
  type ConfigurationHandoffChild,
  configurationHandoffChildState,
  waitForConfigurationHandoffPreparation,
} from "./configuration-handoff-control";
import { inspectMaintenanceDockerRuntime } from "./configuration-maintenance-docker-inspection";
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
    owner.receipt.dmFence?.state !== "prepared" ||
    owner.receipt.state !== "applying" ||
    owner.receipt.decision?.decision !== "continue" ||
    !owner.apiControls.decide?.receiptDelivery ||
    owner.receipt.generation !== "committed" ||
    owner.receipt.appliedRevisionId !== intent.operation.expectedCurrentRevisionId ||
    intent.operation.mode.kind !== "configuration"
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
        sequence: 0,
        phase: "draining",
        updatedAt: Date.now(),
      },
      true,
    );
    for (const id of configurationHandoffServiceOrder(intent.operation.serviceIds)) {
      signal.throwIfAborted();
      const owner = ownerFor(child),
        authority = await loadAuthority();
      if (authority.revisionId !== owner.plan.sourceAuthorityRevision)
        throw Error("Original helper authority changed");
      const target = (await owned.inspectOwnedServices(signal)).find(
          (value) => value.serviceId === id,
        ),
        original = owner.originalContainers.find((value) => value.serviceId === id);
      if (
        !target ||
        !original ||
        target.containerId !== original.containerId ||
        target.state !== "running" ||
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
            const fresh = (await owned.inspectOwnedServices(signal)).find(
              (value) => value.serviceId === id,
            );
            if (!fresh || canonicalJson(fresh) !== canonicalJson(target))
              throw Error("Original helper target raced");
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
