/** The configuration helper's Docker effects: it replaces each handoff target
 * with the generation the maintenance committed and checks the result. Only
 * Docker process I/O is replaceable in tests. */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ControlInstallation } from "@openmapx/core/build-artifacts";
import { type ConfigurationReleaseDownloads, canonicalJson } from "@openmapx/core/ops";
import { repoPaths, services } from "@openmapx/core/server";
import { maintenanceDockerContainerSchema } from "../../../packages/core/src/build-artifacts/configuration-maintenance-docker-records";
import {
  awaitAppliedContainerHealth,
  inspectMaintenanceDockerRuntime,
} from "./configuration-maintenance-docker-inspection";
import { inspectConfigurationReleaseImages } from "./configuration-release-images";
import { type DockerRuntimeOptions, runContainedProcess } from "./docker-runtime";
import type { HandoffHelperHost } from "./handoff-helper";
import { type MaintenanceFile, readMaintenance } from "./maintenance";
import { createOwnedServiceResolver } from "./owned-services";
import { createTrustedConfigurationAuthorityLoader } from "./trusted-configuration-authority";

/** The maintenance committed the generation that pins this release before the helper ran. */
function assertAppliedRelease(infraDir: string, manifestDigest: string): void {
  if (services.readAppliedRelease(infraDir)?.manifestDigest !== manifestDigest)
    throw Error("The applied generation does not pin the release this update froze");
}

/** Observes one pinned release image that is already on the host. Nothing is
 * downloaded: a missing image, or one that differs from its pin, fails before
 * any service is replaced. */
export async function observeConfigurationHandoffReleaseImage(input: {
  downloads: ConfigurationReleaseDownloads;
  image: ConfigurationReleaseDownloads["images"][number]["image"];
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  signal: AbortSignal;
}) {
  const [observed] = await inspectConfigurationReleaseImages(input);
  if (!observed) throw Error("Pinned release image is not available locally");
  return { imageId: observed.imageId };
}

/** The handoff step's operation in the plan. */
function handoffOperation(file: MaintenanceFile) {
  const step = file.plan.steps.find((value) => value.phase === "maintenance-handoff");
  if (step?.operation.kind !== "configurationHandoff.prepare")
    throw Error("Maintenance has no handoff step");
  return step.operation;
}

export async function createConfigurationHandoffHost(input: {
  installation: ControlInstallation;
  rootDir: string;
  execFile?: DockerRuntimeOptions["execFile"];
}): Promise<HandoffHelperHost> {
  const execFile = input.execFile ?? runContainedProcess,
    stack = repoPaths(input.rootDir);
  if (stack.infraDir !== join(input.rootDir, "infra/docker"))
    throw Error("Configuration helper checkout required");
  const capture = await services.captureReleaseServiceAuthority(input.rootDir),
    loadAuthority = createTrustedConfigurationAuthorityLoader({
      rootDir: input.rootDir,
      builtInServices: capture.services,
      builtInAuthorityDigest: capture.digest,
    }),
    owned = createOwnedServiceResolver({ stack, execFile, loadAuthority });
  /** The maintenance still applies the generation this helper replaces services
   * with, and has not recorded the handoff's outcome. */
  const current = (file: MaintenanceFile) => {
    const now = readMaintenance(input.installation, file.record.maintenanceId);
    if (
      now.record.state !== "applying" ||
      now.record.generation !== "committed" ||
      now.record.handoff?.handoffId !== file.record.handoff?.handoffId ||
      now.record.steps.at(-1)?.state !== "attempted"
    )
      throw Error("Configuration maintenance is no longer applying");
    return now;
  };
  const verifiedImages = new Map<string, string>();
  const inspectTarget = async (file: MaintenanceFile, id: string, signal: AbortSignal) => {
    if (!file.plan.release)
      return (await owned.inspectOwnedServices(signal)).find((value) => value.serviceId === id);
    // A release update keeps the exact old container of each target, whatever
    // the changed overlay would select.
    const original = file.originalContainers.find((value) => value.serviceId === id);
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
  return {
    async verifyRelease(file, signal) {
      const release = file.plan.release;
      if (!release) return;
      for (const image of release.downloads.images) {
        current(file);
        assertAppliedRelease(stack.infraDir, release.manifestDigest);
        // The images were downloaded before maintenance began. Maintenance only
        // observes them, so a registry outage cannot strand the instance here.
        const observed = await observeConfigurationHandoffReleaseImage({
          downloads: release.downloads,
          image: image.image,
          execFile,
          signal,
        });
        verifiedImages.set(image.reference, observed.imageId);
      }
    },
    async replace(file, id, beforeEffect, signal) {
      const operation = handoffOperation(file),
        deadlineAt = file.plan.prepare.deadlineAt;
      if ((await loadAuthority()).revisionId !== file.plan.sourceAuthorityRevision)
        throw Error("Configuration helper authority changed");
      const target = await inspectTarget(file, id, signal),
        original = file.originalContainers.find((value) => value.serviceId === id);
      if (
        !target ||
        !original ||
        target.containerId !== original.containerId ||
        (!file.plan.release && target.state !== "running") ||
        target.provenance.imageId !== operation.expectedImageIdentities[id]
      )
        throw Error("Configuration helper target changed");
      const args = await services.withConfigurationGenerationWriter(
        stack.infraDir,
        async () => {
          current(file);
          if (
            (await loadAuthority()).revisionId !== file.plan.sourceAuthorityRevision ||
            services.currentConfigurationGeneration(stack.infraDir) !==
              operation.expectedCurrentRevisionId
          )
            throw Error("Configuration helper generation changed");
          const fresh = await inspectTarget(file, id, signal);
          if (!fresh || canonicalJson(fresh) !== canonicalJson(target))
            throw Error("Configuration helper target raced");
          const release = file.plan.release;
          if (release) {
            const reference = release.serviceImages[id as keyof typeof release.serviceImages];
            const download = release.downloads.images.find(
              (value) => value.reference === reference,
            );
            const verified = reference ? verifiedImages.get(reference) : undefined;
            if (!download || !verified) throw Error("Verified release image required");
            const [observed] = await inspectConfigurationReleaseImages({
              downloads: release.downloads,
              image: download.image,
              execFile,
              signal,
            });
            if (observed?.imageId !== verified) throw Error("Pulled release image changed");
          }
          // The progress records the attempt before Compose replaces the container.
          beforeEffect();
          return [
            ...services.stackComposeArgs(stack),
            "up",
            "-d",
            "--force-recreate",
            "--no-deps",
            id,
          ];
        },
        signal,
      );
      await execFile("docker", args, {
        signal,
        timeout: Math.max(1, deadlineAt - Date.now()),
        maxBuffer: 1024 * 1024,
      });
      // A recreated service with a healthcheck reports `starting` at first;
      // the readiness check below refuses it until it is healthy.
      const applied = (await owned.inspectOwnedServices(signal)).find(
        (value) => value.serviceId === id,
      );
      if (applied)
        await awaitAppliedContainerHealth({
          containerId: applied.containerId,
          execFile,
          signal,
          deadlineAt,
        });
      const containers = await owned.inspectOwnedServices(signal);
      await inspectMaintenanceDockerRuntime({
        stack,
        execFile,
        owner: current(file),
        containers,
        signal,
        handoffTargetId: id,
      });
      const observed = containers.find((value) => value.serviceId === id);
      if (!observed) throw Error("Applied helper container unavailable");
      return observed.containerId;
    },
    async verifyAll(file, signal) {
      await inspectMaintenanceDockerRuntime({
        stack,
        execFile,
        owner: current(file),
        containers: await owned.inspectOwnedServices(signal),
        signal,
      });
    },
  };
}
