/** The agent's configuration maintenance: one record per maintenance id in its
 * private state, changed only through the core transition table. Every effect
 * runs after the record that names it attempted is written; a restart never
 * starts an attempted step again. */
import {
  type ControlInstallation,
  readPrivateRecord,
  writePrivateRecord,
} from "@openmapx/core/build-artifacts";
import {
  type HandoffProgress,
  handoffProgressSchema,
  type MaintenanceEffect,
  type MaintenanceEvent,
  type MaintenanceFenceOutcome,
  type MaintenanceRecord,
  type MaintenanceStepOutcome,
  MaintenanceTransitionRefused,
  maintenanceRecordSchema,
  transitionMaintenance,
} from "@openmapx/core/ops";
import { z } from "zod";
import { installationState } from "../../../packages/core/src/build-artifacts/control-authority";
import {
  coordinatorPullWitnessSchema,
  stagedCoordinatorObservationSchema,
} from "../../../packages/core/src/build-artifacts/coordinator-pull-records";
import { fixedConfigurationMaintenancePlanSchema } from "../../../packages/core/src/build-artifacts/fixed-configuration-maintenance";
import { ownedServiceSnapshotSchema } from "../../../packages/core/src/ops/owned-service-records";
import type { DataConfigurationFenceReceipt } from "../../../packages/core/src/services/data-manager/contracts/configuration-maintenance";

const NAMESPACE = "maintenance";
const MAX_RECORDS = 64;

/** The record plus what the agent planned at admission and runs its steps with. */
const maintenanceFileSchema = z.strictObject({
  version: z.literal(1),
  record: maintenanceRecordSchema,
  plan: z.lazy(() => fixedConfigurationMaintenancePlanSchema),
  originalContainers: z.array(ownedServiceSnapshotSchema).max(256),
  coordinatorPull: coordinatorPullWitnessSchema.optional(),
  stagedCoordinatorProvenance: stagedCoordinatorObservationSchema.optional(),
});
export type MaintenanceFile = z.infer<typeof maintenanceFileSchema>;

/** What one step reported. `result` is the generation step's apply result. */
interface MaintenanceStepResult {
  outcome: MaintenanceStepOutcome;
  appliedRevisionId?: string;
  result?: unknown;
}

/** The host effects a maintenance runs. Each step runs as a child of the
 * maintenance's lease, recorded before its effect. */
export interface MaintenanceAdapters {
  /** Records the data-manager fence child in the lease, then asks data-manager to prepare. */
  prepareFence(file: MaintenanceFile, signal: AbortSignal): Promise<DataConfigurationFenceReceipt>;
  /** Whether the fence child was recorded in the lease, so data-manager may hold a fence. */
  fenceDelegated(file: MaintenanceFile): boolean;
  settleFence(
    file: MaintenanceFile,
    outcome: MaintenanceFenceOutcome,
    signal: AbortSignal,
  ): Promise<DataConfigurationFenceReceipt>;
  runStep(
    file: MaintenanceFile,
    ordinal: number,
    signal: AbortSignal,
    emitLog: (stream: "stdout" | "stderr", message: string) => void,
  ): Promise<MaintenanceStepResult>;
  /** Starts the helper container; returns its id when Docker answered. */
  launchHelper(file: MaintenanceFile, signal: AbortSignal): Promise<{ containerId: string | null }>;
  findHelper(
    handoffId: string,
  ): Promise<{ id: string; running: boolean; exitCode: number | null } | null>;
  removeHelper(containerId: string): Promise<void>;
  cancelLease(file: MaintenanceFile): Promise<void>;
  releaseLease(file: MaintenanceFile): Promise<void>;
  now(): Date;
}

/** The data-manager refused the fence without writing it; its child settled without effect. */
export class MaintenanceFenceRefused extends Error {
  constructor() {
    super("Data-manager refused the configuration fence");
    this.name = "MaintenanceFenceRefused";
  }
}

export interface MaintenanceApplyOutcome {
  outcome: "committed" | "contained" | "running" | "unknown";
  record: MaintenanceRecord;
  generation: unknown;
}

const fileName = (maintenanceId: string) => `${z.uuid().parse(maintenanceId)}.json`;
const progressName = (maintenanceId: string) => `${z.uuid().parse(maintenanceId)}.handoff.json`;

export function readMaintenance(
  installation: ControlInstallation,
  maintenanceId: string,
): MaintenanceFile {
  const file = maintenanceFileSchema.parse(
    readPrivateRecord(installationState(installation), NAMESPACE, fileName(maintenanceId)),
  );
  if (file.record.maintenanceId !== maintenanceId)
    throw Error("Maintenance record identity changed");
  return file;
}

function listMaintenance(installation: ControlInstallation): MaintenanceFile[] {
  const state = installationState(installation);
  const directory = state.privateRoot.directory(NAMESPACE, true, true);
  let names: string[];
  try {
    names = directory.list().filter((name) => /^[0-9a-f-]{36}\.json$/.test(name));
  } finally {
    directory.close();
  }
  if (names.length > MAX_RECORDS) throw Error("Too many configuration maintenance records");
  return names.map((name) => readMaintenance(installation, name.slice(0, -5)));
}

function writeMaintenance(
  installation: ControlInstallation,
  file: MaintenanceFile,
  exclusive = false,
) {
  writePrivateRecord(
    installationState(installation),
    NAMESPACE,
    fileName(file.record.maintenanceId),
    maintenanceFileSchema.parse(file),
    exclusive,
  );
}

/** Written by the helper only; undefined when the helper never wrote it. */
export function readHandoffProgress(
  installation: ControlInstallation,
  maintenanceId: string,
): HandoffProgress | undefined {
  try {
    const progress = handoffProgressSchema.parse(
      readPrivateRecord(installationState(installation), NAMESPACE, progressName(maintenanceId)),
    );
    if (progress.maintenanceId !== maintenanceId) throw Error("Handoff progress identity changed");
    return progress;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeHandoffProgress(installation: ControlInstallation, progress: HandoffProgress) {
  const value = handoffProgressSchema.parse(progress);
  writePrivateRecord(
    installationState(installation),
    NAMESPACE,
    progressName(value.maintenanceId),
    value,
  );
}

/** The new record of an admitted preparation, before any child is recorded. */
export function createMaintenance(
  installation: ControlInstallation,
  input: Omit<MaintenanceFile, "version" | "record"> & {
    apiJobId: string;
    leaseId: string;
    now: Date;
  },
): MaintenanceFile {
  const { plan } = input;
  const { kind: _kind, ...binding } = plan.operation;
  const file = maintenanceFileSchema.parse({
    version: 1,
    plan,
    originalContainers: input.originalContainers,
    ...(input.coordinatorPull ? { coordinatorPull: input.coordinatorPull } : {}),
    ...(input.stagedCoordinatorProvenance
      ? { stagedCoordinatorProvenance: input.stagedCoordinatorProvenance }
      : {}),
    record: {
      version: 1,
      maintenanceId: plan.operation.maintenanceId,
      prepare: plan.prepare,
      apiJobId: input.apiJobId,
      leaseId: input.leaseId,
      binding,
      serviceIds: plan.serviceIds,
      steps: plan.steps.map((step) => ({
        phase: step.phase,
        ordinal: step.ordinal,
        operation: step.operation,
        operationKey: step.operationKey,
        serviceIds: step.serviceIds,
        prerequisites: step.prerequisites,
        state: "pending",
      })),
      fence: null,
      handoff: null,
      state: "preparing",
      generation: "not_started",
      appliedRevisionId: null,
      followUp: "not_started",
      fenceOutcome: null,
      cancelRequestedAt: null,
      sequence: 0,
      updatedAt: input.now.toISOString(),
      settledAt: null,
    },
  });
  writeMaintenance(installation, file, true);
  return file;
}

/** The helper's outcome once its container exited; "running" while it runs. */
export async function readHandoffOutcome(
  installation: ControlInstallation,
  adapters: Pick<MaintenanceAdapters, "findHelper">,
  record: MaintenanceRecord,
): Promise<MaintenanceStepOutcome | "running"> {
  if (!record.handoff) throw Error("Configuration handoff was not started");
  const container = await adapters.findHelper(record.handoff.handoffId);
  // A running helper still writes its progress: nothing is read, pruned or settled.
  if (container?.running) return "running";
  const progress = readHandoffProgress(installation, record.maintenanceId);
  if (!container && !progress) return "failed_without_effect";
  if (
    progress &&
    (progress.handoffId !== record.handoff.handoffId ||
      progress.maintenanceId !== record.maintenanceId)
  )
    return "unknown";
  if (
    container?.exitCode === 0 &&
    progress?.phase === "applied" &&
    progress.targets.every((target) => target.phase === "verified")
  )
    return "committed";
  if (
    progress &&
    (progress.phase === "rolled_back" || progress.phase === "cancelled") &&
    progress.targets.every((target) => ["pending", "verified", "restored"].includes(target.phase))
  )
    return "contained";
  return "unknown";
}

const locks = new Map<string, Promise<unknown>>();
/** Serialises read, transition and write per maintenance id within the agent. */
async function withRecord<T>(maintenanceId: string, work: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(maintenanceId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => undefined);
  locks.set(maintenanceId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(maintenanceId) === tail) locks.delete(maintenanceId);
  }
}

export class ConfigurationMaintenance {
  constructor(
    private readonly installation: ControlInstallation,
    private readonly adapters: MaintenanceAdapters,
  ) {}

  read(maintenanceId: string): MaintenanceFile {
    return readMaintenance(this.installation, maintenanceId);
  }

  /** Applies one event and writes the new record; nothing is written when it is refused. */
  private async change(
    maintenanceId: string,
    event: MaintenanceEvent,
  ): Promise<{ file: MaintenanceFile; effects: MaintenanceEffect[] }> {
    return withRecord(maintenanceId, () => {
      const file = this.read(maintenanceId);
      const next = transitionMaintenance(file.record, event, this.adapters.now());
      const updated = next.changed ? { ...file, record: next.record } : file;
      if (next.changed) writeMaintenance(this.installation, updated);
      return { file: updated, effects: next.effects };
    });
  }

  /** Runs the effects in order; each follows the write that recorded it. */
  private async run(
    maintenanceId: string,
    effects: MaintenanceEffect[],
    signal: AbortSignal,
    emitLog: (stream: "stdout" | "stderr", message: string) => void = () => {},
    outcome: { value?: MaintenanceApplyOutcome["outcome"]; generation?: unknown } = {},
  ): Promise<typeof outcome> {
    const queue = [...effects];
    while (queue.length) {
      const effect = queue.shift()!;
      const file = this.read(maintenanceId);
      switch (effect.type) {
        case "start_step":
          queue.unshift(
            ...(await this.change(maintenanceId, { type: "step_start", ordinal: effect.ordinal }))
              .effects,
          );
          break;
        case "dispatch_step": {
          const step = file.record.steps[effect.ordinal]!;
          if (step.phase === "maintenance-handoff") {
            let launched: { containerId: string | null };
            try {
              launched = await this.adapters.launchHelper(file, signal);
            } catch {
              // The attempt is recorded; the restarted agent resolves it from the container.
              launched = { containerId: null };
            }
            queue.unshift(
              ...(
                await this.change(maintenanceId, {
                  type: "handoff_launched",
                  containerId: launched.containerId,
                })
              ).effects,
            );
            break;
          }
          let result: MaintenanceStepResult;
          try {
            result = await this.adapters.runStep(file, effect.ordinal, signal, emitLog);
          } catch {
            result = { outcome: "unknown" };
          }
          if (step.phase === "configuration-commit") outcome.generation = result.result;
          queue.unshift(
            ...(
              await this.change(maintenanceId, {
                type: "step_terminal",
                ordinal: effect.ordinal,
                outcome: result.outcome,
                ...(result.appliedRevisionId
                  ? { appliedRevisionId: result.appliedRevisionId }
                  : {}),
              })
            ).effects,
          );
          if (result.outcome === "unknown") outcome.value = "unknown";
          break;
        }
        case "apply_succeeded":
          outcome.value = effect.handoff === "running" ? "running" : "committed";
          break;
        case "apply_failed":
          outcome.value = effect.outcome === "unknown" ? "unknown" : "contained";
          break;
        case "settle_fence": {
          const fence = await this.adapters.settleFence(file, effect.outcome, signal);
          queue.unshift(
            ...(await this.change(maintenanceId, { type: "fence_settled", fence })).effects,
          );
          break;
        }
        case "release_lease":
          await this.adapters.releaseLease(file);
          break;
        case "cancel_lease":
          await this.adapters.cancelLease(file);
          break;
        case "watch_helper":
          await this.observeHelper(maintenanceId);
          break;
        case "reopen_admissions":
        case "prepare_fence":
          break;
      }
    }
    return outcome;
  }

  /** Runs the fence preparation of a record admitted as preparing. */
  async prepare(maintenanceId: string, signal: AbortSignal): Promise<MaintenanceRecord> {
    const file = this.read(maintenanceId);
    if (file.record.state !== "preparing") throw new MaintenanceTransitionRefused("conflict");
    let event: MaintenanceEvent;
    try {
      event = { type: "fence_prepared", fence: await this.adapters.prepareFence(file, signal) };
    } catch (error) {
      event =
        error instanceof MaintenanceFenceRefused
          ? { type: "fence_not_prepared" }
          : { type: "fence_unknown" };
    }
    const next = await this.change(maintenanceId, event);
    await this.run(maintenanceId, next.effects, signal);
    return this.read(maintenanceId).record;
  }

  /** Runs every step of a prepared maintenance, or continues an applying one. */
  async applySteps(
    maintenanceId: string,
    apiJobId: string,
    signal: AbortSignal,
    emitLog?: (stream: "stdout" | "stderr", message: string) => void,
  ): Promise<MaintenanceApplyOutcome> {
    const next = await this.change(maintenanceId, { type: "apply", apiJobId });
    const result = await this.run(maintenanceId, next.effects, signal, emitLog);
    const record = this.read(maintenanceId).record;
    return {
      outcome:
        result.value ??
        (record.state === "recovery_required"
          ? "unknown"
          : record.handoff && !record.steps.at(-1)?.outcome
            ? "running"
            : record.followUp === "complete"
              ? "committed"
              : "contained"),
      record,
      generation: result.generation ?? null,
    };
  }

  /** `settle{complete}` or `settle{abandon}`; repeated, it repeats the fence settlement. */
  async settle(
    maintenanceId: string,
    outcome: "complete" | "abandon",
    signal: AbortSignal,
  ): Promise<MaintenanceRecord> {
    const current = this.read(maintenanceId).record;
    if (current.state === "settled") return current;
    if (current.handoff && current.state === "applying") await this.observeHelper(maintenanceId);
    const next = await this.change(maintenanceId, {
      type:
        outcome === "abandon" && this.read(maintenanceId).record.state !== "settling"
          ? "abandon"
          : "settle_complete",
    });
    await this.run(maintenanceId, next.effects, signal);
    return this.read(maintenanceId).record;
  }

  async cancel(maintenanceId: string, signal: AbortSignal): Promise<MaintenanceRecord> {
    const next = await this.change(maintenanceId, { type: "cancel" });
    await this.run(maintenanceId, next.effects, signal);
    return this.read(maintenanceId).record;
  }

  /** The record as the API sees it, after recording a helper that exited. */
  async inspect(maintenanceId: string): Promise<MaintenanceRecord> {
    const current = this.read(maintenanceId).record;
    if (current.state === "applying" && current.handoff) await this.observeHelper(maintenanceId);
    return this.read(maintenanceId).record;
  }

  /** Records the helper's outcome once its container exited, then removes the container. */
  async observeHelper(maintenanceId: string): Promise<MaintenanceStepOutcome | "running"> {
    const record = this.read(maintenanceId).record;
    const step = record.steps.find((value) => value.phase === "maintenance-handoff");
    if (!step || step.state !== "attempted" || !record.handoff) return step?.outcome ?? "running";
    const outcome = await readHandoffOutcome(this.installation, this.adapters, record);
    if (outcome === "running") return outcome;
    await this.change(maintenanceId, { type: "helper_exited", outcome });
    const container = await this.adapters.findHelper(record.handoff.handoffId);
    if (container && !container.running) await this.adapters.removeHelper(container.id);
    return outcome;
  }

  /** Startup: a preparation without a delegated fence settles; an attempted step
   * other than the handoff needs recovery; a handoff is observed. */
  async recover(signal: AbortSignal): Promise<void> {
    for (const file of listMaintenance(this.installation)) {
      if (file.record.state === "settled") continue;
      const next = await this.change(file.record.maintenanceId, {
        type: "startup",
        fenceDelegated: this.adapters.fenceDelegated(file),
      });
      await this.run(file.record.maintenanceId, next.effects, signal).catch(() => undefined);
    }
  }

  /** A launched helper that has not exited closes admissions other than reads. */
  handoffPending(): boolean {
    return listMaintenance(this.installation).some(
      (file) =>
        file.record.state === "applying" &&
        file.record.handoff !== null &&
        file.record.steps.some(
          (step) => step.phase === "maintenance-handoff" && step.state === "attempted",
        ),
    );
  }
}
