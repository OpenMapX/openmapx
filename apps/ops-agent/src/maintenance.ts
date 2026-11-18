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
  transitionMaintenance,
} from "@openmapx/core/ops";
import { z } from "zod";
import {
  maintenanceFileName as fileName,
  type MaintenanceFile,
  maintenanceFileSchema,
  MAINTENANCE_NAMESPACE as NAMESPACE,
  parseMaintenanceFile,
} from "../../../packages/core/src/build-artifacts/maintenance-file";
import { installationState } from "../../../packages/core/src/build-artifacts/private-records";
import type { DataConfigurationFenceReceipt } from "../../../packages/core/src/services/data-manager/contracts/configuration-maintenance";
import type { PersistedOpsJob } from "./journal";

export type { MaintenanceFile };

const MAX_RECORDS = 64;

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
  /** The helper container; `created` when Docker created it and never started it. */
  findHelper(handoffId: string): Promise<{
    id: string;
    running: boolean;
    created: boolean;
    exitCode: number | null;
  } | null>;
  removeHelper(containerId: string): Promise<void>;
  /** Whether the helper adopted its lease child, which it does before its first effect. */
  helperAdopted(record: MaintenanceRecord): boolean;
  /** Settles the handoff's lease children from the helper's known outcome. */
  settleHandoff(file: MaintenanceFile, outcome: MaintenanceStepOutcome): Promise<void>;
  cancelLease(file: MaintenanceFile): Promise<void>;
  /** Whether the maintenance's lease is still in the store. */
  leaseHeld(file: MaintenanceFile): boolean;
  /** Releases the lease once every child settled; does nothing when it is gone. */
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

/** Data-manager refused the fence settlement for good: it has no such fence or
 * settled it otherwise. Sending it again cannot succeed. */
export class MaintenanceSettlementRefused extends Error {
  constructor(cause: unknown) {
    super("Data-manager refused the configuration fence settlement", { cause });
    this.name = "MaintenanceSettlementRefused";
  }
}

export interface MaintenanceApplyOutcome {
  outcome: "committed" | "contained" | "running" | "unknown";
  record: MaintenanceRecord;
  generation: unknown;
}

const progressName = (maintenanceId: string) => `${z.uuid().parse(maintenanceId)}.handoff.json`;

export function readMaintenance(
  installation: ControlInstallation,
  maintenanceId: string,
): MaintenanceFile {
  return parseMaintenanceFile(
    readPrivateRecord(installationState(installation), NAMESPACE, fileName(maintenanceId)),
    maintenanceId,
  );
}

/** Maintenances whose helper was launched and has not exited: other
 * admissions are closed meanwhile, except reads and their own requests. */
export function pendingHandoffs(installation: ControlInstallation): ReadonlySet<string> {
  return new Set(
    listMaintenance(installation)
      .filter(
        (file) =>
          file.record.state === "applying" &&
          file.record.handoff !== null &&
          file.record.steps.some(
            (step) => step.phase === "maintenance-handoff" && step.state === "attempted",
          ),
      )
      .map((file) => file.record.maintenanceId),
  );
}

function recordNames(installation: ControlInstallation): string[] {
  const state = installationState(installation);
  let directory: ReturnType<typeof state.privateRoot.directory>;
  try {
    directory = state.privateRoot.directory(NAMESPACE, false, true);
  } catch (error) {
    // No maintenance was ever admitted.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    return directory.list().filter((name) => /^[0-9a-f-]{36}\.json$/.test(name));
  } finally {
    directory.close();
  }
}

function listMaintenance(installation: ControlInstallation): MaintenanceFile[] {
  return recordNames(installation).map((name) => readMaintenance(installation, name.slice(0, -5)));
}

/** Whether a new preparation would exceed the records the agent keeps. A record
 * goes with its preparation's control records once both are past retention. */
export function maintenanceCapacityReached(installation: ControlInstallation): boolean {
  return recordNames(installation).length >= MAX_RECORDS;
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
  adapters: Pick<MaintenanceAdapters, "findHelper" | "removeHelper" | "helperAdopted">,
  record: MaintenanceRecord,
): Promise<MaintenanceStepOutcome | "running"> {
  if (!record.handoff) throw Error("Configuration handoff was not started");
  let container = await adapters.findHelper(record.handoff.handoffId);
  // A running helper still writes its progress: nothing is read, pruned or settled.
  if (container?.running) return "running";
  const adopted = adapters.helperAdopted(record);
  // An interrupted launch can leave a container Docker created and never
  // started; once removed it never runs, so the launch counts as not made.
  if (container?.created && !adopted) {
    await adapters.removeHelper(container.id);
    container = null;
  }
  const progress = readHandoffProgress(installation, record.maintenanceId);
  // A helper adopts its lease child before anything else: without that, a
  // container or progress, it never started.
  if (!container && !progress && !adopted) return "failed_without_effect";
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
  // A cancelled helper stopped between targets; a failed one that replaced
  // nothing left every target as it was.
  if (
    progress &&
    ((progress.phase === "cancelled" &&
      progress.targets.every((target) => target.phase !== "recreate_attempted")) ||
      (progress.phase === "failed" &&
        progress.targets.every((target) => target.phase === "pending")))
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
  /** Maintenances whose helper launch runs in this process: not observed meanwhile. */
  private readonly launching = new Set<string>();
  private readonly observing = new Map<string, Promise<MaintenanceStepOutcome | "running">>();
  private ticking: Promise<void> | undefined;

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
          try {
            queue.unshift(
              ...(await this.change(maintenanceId, { type: "step_start", ordinal: effect.ordinal }))
                .effects,
            );
          } catch (error) {
            // A cancel recorded since the last step ended: no step starts.
            if (!(error instanceof MaintenanceTransitionRefused)) throw error;
          }
          break;
        case "dispatch_step": {
          const step = file.record.steps[effect.ordinal]!;
          if (step.phase === "maintenance-handoff") {
            this.launching.add(maintenanceId);
            try {
              let launched: { containerId: string | null };
              try {
                launched = await this.adapters.launchHelper(file, signal);
              } catch {
                // The attempt is recorded; its outcome is read from the container.
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
            } finally {
              this.launching.delete(maintenanceId);
            }
            break;
          }
          let result: MaintenanceStepResult;
          try {
            result = await this.adapters.runStep(file, effect.ordinal, signal, emitLog);
          } catch {
            result = { outcome: "unknown" };
          }
          if (step.phase === "configuration-commit") outcome.generation = result.result;
          let terminal: Awaited<ReturnType<typeof this.change>>;
          try {
            terminal = await this.change(maintenanceId, {
              type: "step_terminal",
              ordinal: effect.ordinal,
              outcome: result.outcome,
              ...(result.appliedRevisionId ? { appliedRevisionId: result.appliedRevisionId } : {}),
            });
          } catch (error) {
            // The step ran, but its result does not fit the record (another
            // revision committed): its outcome is unknown.
            if (!(error instanceof MaintenanceTransitionRefused)) throw error;
            result = { outcome: "unknown" };
            terminal = await this.change(maintenanceId, {
              type: "step_terminal",
              ordinal: effect.ordinal,
              outcome: "unknown",
            });
          }
          queue.unshift(...terminal.effects);
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
          let fence: DataConfigurationFenceReceipt;
          try {
            fence = await this.adapters.settleFence(file, effect.outcome, signal);
          } catch (error) {
            console.warn("Configuration fence settlement failed", maintenanceId, error);
            // A settlement refused for good is not sent again: the maintenance
            // waits for `openmapx control resolve`.
            if (error instanceof MaintenanceSettlementRefused)
              await this.change(maintenanceId, { type: "settlement_refused" });
            // Otherwise the record stays settling with its outcome fixed; the
            // agent's own check sends the same idempotent settlement again.
            break;
          }
          queue.unshift(
            ...(await this.change(maintenanceId, { type: "fence_settled", fence })).effects,
          );
          break;
        }
        case "release_lease":
          await this.finish(file);
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

  /** Releases the lease of a settled record. A failure leaves the lease for the
   * agent's own check, which releases it later: the record already settled. */
  private async finish(file: MaintenanceFile): Promise<void> {
    try {
      await this.adapters.releaseLease(file);
    } catch (error) {
      console.warn("Configuration maintenance release failed", file.record.maintenanceId, error);
    }
  }

  /** `settle{complete}` or `settle{abandon}`; repeated, it repeats the fence
   * settlement, or the release of a settled record's lease. The result may be
   * settling while data-manager does not answer; the agent finishes it itself.
   * Abandoning once a step started cancels the maintenance instead: the step in
   * flight ends, no further step starts, and `complete` settles it afterwards. */
  async settle(
    maintenanceId: string,
    outcome: "complete" | "abandon",
    signal: AbortSignal,
  ): Promise<MaintenanceRecord> {
    const file = this.read(maintenanceId);
    const current = file.record;
    if (current.state === "settled") {
      await this.finish(file);
      return current;
    }
    if (current.handoff && current.state === "applying") await this.observeHelper(maintenanceId);
    const observed = this.read(maintenanceId).record;
    if (
      outcome === "abandon" &&
      observed.state === "applying" &&
      observed.steps.some((step) => step.state !== "pending")
    )
      return this.cancel(maintenanceId, signal);
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

  /** Records the helper's outcome once its container exited, then removes the
   * container. One observation per maintenance runs at a time. */
  async observeHelper(maintenanceId: string): Promise<MaintenanceStepOutcome | "running"> {
    if (this.launching.has(maintenanceId)) return "running";
    const running = this.observing.get(maintenanceId);
    if (running) return running;
    const observation = this.observeOnce(maintenanceId).finally(() =>
      this.observing.delete(maintenanceId),
    );
    this.observing.set(maintenanceId, observation);
    return observation;
  }

  private async observeOnce(maintenanceId: string): Promise<MaintenanceStepOutcome | "running"> {
    const file = this.read(maintenanceId);
    const { record } = file;
    const step = record.steps.find((value) => value.phase === "maintenance-handoff");
    if (!step || step.state !== "attempted" || !record.handoff) return step?.outcome ?? "running";
    const outcome = await readHandoffOutcome(this.installation, this.adapters, record);
    if (outcome === "running") return outcome;
    // The lease children settle before the record names the outcome: a restart
    // in between reads the same outcome again and settles what is left.
    await this.adapters.settleHandoff(file, outcome);
    await this.change(maintenanceId, { type: "helper_exited", outcome });
    try {
      const container = await this.adapters.findHelper(record.handoff.handoffId);
      if (container && !container.running) await this.adapters.removeHelper(container.id);
    } catch (error) {
      console.warn("Configuration helper container removal failed", maintenanceId, error);
    }
    return outcome;
  }

  /** Startup: a preparation without a delegated fence settles; an attempted step
   * other than the handoff needs recovery; a handoff is observed. Then the
   * agent's own check runs, including every settled record's release. */
  async recover(signal: AbortSignal): Promise<void> {
    for (const file of listMaintenance(this.installation)) {
      if (file.record.state === "settled") continue;
      const next = await this.change(file.record.maintenanceId, {
        type: "startup",
        fenceDelegated: this.adapters.fenceDelegated(file),
      });
      await this.run(file.record.maintenanceId, next.effects, signal).catch(() => undefined);
    }
    await this.tick(signal, true);
  }

  /** The agent's own check, on a timer and after startup, of what no request
   * drives any more: a helper that exited, a settlement data-manager did not
   * answer, a lease a settled record still holds, and a maintenance with no
   * step attempted whose deadline passed. One check runs at a time. */
  tick(signal: AbortSignal, everySettled = false): Promise<void> {
    this.ticking ??= this.check(signal, everySettled).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async check(signal: AbortSignal, everySettled: boolean): Promise<void> {
    let files: MaintenanceFile[];
    try {
      files = listMaintenance(this.installation);
    } catch (error) {
      // A record the agent cannot read stops this check, not the agent.
      console.warn("Configuration maintenance records are unreadable", error);
      return;
    }
    for (const file of files) {
      const { record } = file;
      const maintenanceId = record.maintenanceId;
      try {
        if (record.state === "applying" && record.handoff) await this.observeHelper(maintenanceId);
        else if (
          record.state === "settling" ||
          (record.state === "settled" && (everySettled || this.adapters.leaseHeld(file)))
        )
          await this.settle(maintenanceId, "complete", signal);
        else if (record.state === "prepared" || record.state === "applying") {
          const next = await this.change(maintenanceId, { type: "deadline_passed" });
          await this.run(maintenanceId, next.effects, signal);
        }
      } catch (error) {
        console.warn("Configuration maintenance check failed", maintenanceId, error);
      }
    }
  }

  handoffPending(): ReadonlySet<string> {
    return pendingHandoffs(this.installation);
  }

  /** The result of a settle the agent's stop interrupted, once its record
   * settled: the settle has no effect of its own beyond the record's
   * transitions. A settle that failed by itself keeps its failure. */
  interruptedSettleResult(
    job: Pick<PersistedOpsJob, "operation" | "state" | "interrupted">,
  ): MaintenanceRecord | undefined {
    if (
      job.operation.kind !== "configurationMaintenance.settle" ||
      job.state !== "failed" ||
      !job.interrupted
    )
      return undefined;
    try {
      const { record } = this.read(job.operation.maintenanceId);
      return record.state === "settled" ? record : undefined;
    } catch {
      return undefined;
    }
  }
}
