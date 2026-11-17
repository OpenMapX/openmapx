/** The configuration helper's protocol: it adopts its lease child, writes its
 * progress before each effect, stops before the next target once its child is
 * cancel_pending and settles its own child. Docker effects come from the host. */
import { createHash } from "node:crypto";
import type {
  ControlInstallation,
  LeaseChild,
  LeaseRecord,
  LocalLeaseBackend,
} from "@openmapx/core/build-artifacts";
import type { HandoffProgress } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { type MaintenanceFile, readMaintenance, writeHandoffProgress } from "./maintenance";

export interface HandoffHelperHost {
  /** Checks that `serviceId` still runs its original container, then runs `beforeEffect`
   * and replaces and verifies it. Returns the new container id. */
  replace(
    file: MaintenanceFile,
    serviceId: string,
    beforeEffect: () => void,
    signal: AbortSignal,
  ): Promise<string>;
  /** Release mode: the pinned images are on the host and the generation pins the release. */
  verifyRelease?(file: MaintenanceFile, signal: AbortSignal): Promise<void>;
  /** The whole runtime after the last target. */
  verifyAll(file: MaintenanceFile, signal: AbortSignal): Promise<void>;
}

export class HandoffCancelled extends Error {
  constructor() {
    super("Configuration handoff cancelled");
    this.name = "HandoffCancelled";
  }
}

const digest = (value: unknown) =>
  createHash("sha256")
    .update(`openmapx-configuration-helper-v1\0${JSON.stringify(value)}`)
    .digest("hex");

function childOf(lease: LeaseRecord | undefined, key: string): LeaseChild {
  const child = lease?.children.find((value) => value.key === key);
  if (!lease || !child || child.recipient !== "configuration-helper")
    throw Error("Configuration helper lease child required");
  return child;
}

export async function runConfigurationHandoff(input: {
  installation: ControlInstallation;
  leases: LocalLeaseBackend;
  host: HandoffHelperHost;
  maintenanceId: string;
  handoffId: string;
  leaseId: string;
  leaseChild: string;
  signal: AbortSignal;
  now?: () => Date;
}): Promise<"applied" | "cancelled"> {
  const now = input.now ?? (() => new Date());
  const file = readMaintenance(input.installation, input.maintenanceId);
  const { record } = file;
  const step = record.steps.find((value) => value.phase === "maintenance-handoff");
  const handoff = file.plan.handoff;
  if (
    !handoff ||
    !step ||
    step.state !== "attempted" ||
    record.state !== "applying" ||
    record.generation !== "committed" ||
    record.handoff?.handoffId !== input.handoffId ||
    handoff.handoffId !== input.handoffId ||
    record.leaseId !== input.leaseId
  )
    throw Error("Original active configuration handoff required");
  const initial = childOf(input.leases.readSync(input.leaseId), input.leaseChild);
  // A child adopted before is a helper that ran already: its outcome is read, never repeated.
  if (initial.adopted) throw Error("Configuration helper already started");
  await input.leases.adopt({
    leaseId: input.leaseId,
    key: input.leaseChild,
    execution: initial.execution,
  });
  let progress: HandoffProgress = {
    version: 1,
    maintenanceId: input.maintenanceId,
    handoffId: input.handoffId,
    phase: "draining",
    targets: handoff.serviceIds.map((serviceId) => {
      const old = file.originalContainers.find((value) => value.serviceId === serviceId);
      if (!old || old.provenance.imageId !== handoff.expectedImageIdentities[serviceId])
        throw Error("Original handoff container/image required");
      return {
        serviceId,
        phase: "pending" as const,
        oldContainerId: old.containerId,
        newContainerId: null,
        expectedImageId: old.provenance.imageId,
      };
    }),
    updatedAt: now().toISOString(),
  };
  const save = (next: Partial<HandoffProgress>) => {
    progress = { ...progress, ...next, updatedAt: now().toISOString() };
    writeHandoffProgress(input.installation, progress);
  };
  const target = (serviceId: string, change: Partial<HandoffProgress["targets"][number]>) =>
    progress.targets.map((value) =>
      value.serviceId === serviceId ? { ...value, ...change } : value,
    );
  const settle = (outcome: "committed" | "contained") =>
    input.leases.settle({
      leaseId: input.leaseId,
      key: input.leaseChild,
      settlement: {
        identity: initial.execution,
        outcome,
        publication: "committed",
        terminalReceiptDigest: digest({ handoffId: input.handoffId, progress }),
      },
    });
  /** A cancel stops before the next target; the targets done so far stay done. */
  const forward = () => {
    const current = childOf(input.leases.readSync(input.leaseId), input.leaseChild);
    if (current.state === "cancel_pending") throw new HandoffCancelled();
    if (current.state !== "held" || Date.now() >= current.execution.deadlineAt)
      throw Error("Configuration helper lease no longer permits effects");
  };
  try {
    save({});
    if (input.host.verifyRelease) {
      forward();
      await input.host.verifyRelease(file, input.signal);
    }
    save({ phase: "applying" });
    for (const serviceId of services.selfUpdateServiceOrder(handoff.serviceIds)) {
      input.signal.throwIfAborted();
      forward();
      const replaced = await input.host.replace(
        file,
        serviceId,
        () => {
          forward();
          save({ targets: target(serviceId, { phase: "recreate_attempted" }) });
        },
        input.signal,
      );
      save({
        phase: "verifying",
        targets: target(serviceId, { phase: "verified", newContainerId: replaced }),
      });
    }
    await input.host.verifyAll(file, input.signal);
    save({ phase: "applied" });
    await settle("committed");
    return "applied";
  } catch (error) {
    if (error instanceof HandoffCancelled) {
      save({ phase: "cancelled" });
      await settle("contained");
      return "cancelled";
    }
    // The child stays unsettled: an unknown outcome never releases the lease.
    try {
      save({ phase: "failed" });
    } catch {
      /* The exit code alone then reports the failure. */
    }
    throw error;
  }
}
