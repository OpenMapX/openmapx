/** The agent's one record per configuration maintenance and the only function
 * that changes it. The caller persists the returned record before it runs any
 * returned effect, so every effect follows the write that records its attempt. */
import { z } from "zod";
import {
  type DataConfigurationFenceReceipt,
  dataConfigurationFenceReceiptSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import {
  type ConfigurationMaintenanceEffect,
  configurationMaintenanceBindingSchema,
} from "./configuration-maintenance";
import { configurationMaintenanceEffectOperationSchema } from "./configuration-operation-records";
import { executionRefSchema } from "./execution-ref";

const key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/);
const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
const ids = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .max(256)
  .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id));
const time = z.iso.datetime();

export const maintenanceStepOutcomeSchema = z.enum([
  "committed",
  "contained",
  "failed_without_effect",
  "unknown",
]);
export type MaintenanceStepOutcome = z.infer<typeof maintenanceStepOutcomeSchema>;
export const maintenanceStepPhaseSchema = z.enum([
  "configuration-commit",
  "maintenance-hardlinks",
  "maintenance-recreate",
  "maintenance-handoff",
]);
/** The data-manager fence outcome a settlement sends. */
export const maintenanceFenceOutcomeSchema = z.enum(["applied", "unused", "contained"]);
export type MaintenanceFenceOutcome = z.infer<typeof maintenanceFenceOutcomeSchema>;

const effectSchema: z.ZodType<ConfigurationMaintenanceEffect> =
  configurationMaintenanceEffectOperationSchema;
export const maintenanceRecordStepSchema = z.strictObject({
  phase: maintenanceStepPhaseSchema,
  ordinal: z.number().int().min(0).max(31),
  operation: effectSchema,
  operationKey: key,
  serviceIds: ids,
  prerequisites: z.array(z.number().int().min(0).max(31)).max(31),
  state: z.enum(["pending", "attempted", "terminal"]),
  outcome: maintenanceStepOutcomeSchema.optional(),
});
export type MaintenanceRecordStep = z.infer<typeof maintenanceRecordStepSchema>;

export const maintenanceRecordSchema = z
  .strictObject({
    version: z.literal(1),
    maintenanceId: z.uuid(),
    prepare: executionRefSchema,
    apiJobId: z.uuid(),
    leaseId: z.uuid(),
    binding: configurationMaintenanceBindingSchema,
    serviceIds: ids,
    steps: z.array(maintenanceRecordStepSchema).min(1).max(32),
    fence: dataConfigurationFenceReceiptSchema.nullable(),
    handoff: z
      .strictObject({ handoffId: z.uuid(), containerId: z.string().max(128).nullable() })
      .nullable(),
    state: z.enum([
      "preparing",
      "prepared",
      "applying",
      "settling",
      "settled",
      "recovery_required",
    ]),
    generation: z.enum(["not_started", "committed", "not_committed", "unknown"]),
    appliedRevisionId: revision.nullable(),
    followUp: z.enum(["not_started", "complete", "contained", "unknown"]),
    /** Chosen once when the record enters settling, so a repeated settle sends the same outcome. */
    fenceOutcome: maintenanceFenceOutcomeSchema.nullable(),
    cancelRequestedAt: time.nullable(),
    sequence: z.number().int().nonnegative().safe(),
    updatedAt: time,
    settledAt: time.nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.binding.maintenanceId !== value.maintenanceId ||
      value.steps[0]?.phase !== "configuration-commit" ||
      value.steps.filter((step) => step.phase === "configuration-commit").length !== 1 ||
      value.steps.filter((step) => step.phase === "maintenance-handoff").length > 1 ||
      value.steps.some(
        (step, index) =>
          step.ordinal !== index ||
          (step.phase === "maintenance-handoff" && index !== value.steps.length - 1) ||
          new Set(step.prerequisites).size !== step.prerequisites.length ||
          step.prerequisites.some((prior) => prior >= index) ||
          (step.state === "terminal") !== (step.outcome !== undefined) ||
          step.serviceIds.some((id) => !value.serviceIds.includes(id)),
      )
    )
      context.addIssue({ code: "custom", message: "Invalid maintenance record" });
  });
export type MaintenanceRecord = z.infer<typeof maintenanceRecordSchema>;

export type MaintenanceEvent =
  /** The data-manager answered the fence preparation. */
  | { type: "fence_prepared"; fence: DataConfigurationFenceReceipt }
  /** The fence child settled without effect (data-manager refused, nothing written). */
  | { type: "fence_not_prepared" }
  /** Retries are exhausted and the fence child's outcome is unknown. */
  | { type: "fence_unknown" }
  /** The agent restarted; `fenceDelegated` says whether the fence child was delegated. */
  | { type: "startup"; fenceDelegated: boolean }
  | { type: "apply"; apiJobId: string }
  /** `settle{abandon}` or a cancel before any step started. */
  | { type: "abandon" }
  /** The agent's own check: a maintenance with no step attempted ends at its deadline. */
  | { type: "deadline_passed" }
  | { type: "step_start"; ordinal: number }
  | {
      type: "step_terminal";
      ordinal: number;
      outcome: MaintenanceStepOutcome;
      /** The generation step's committed revision. */
      appliedRevisionId?: string;
    }
  | { type: "handoff_launched"; containerId: string | null }
  | { type: "helper_exited"; outcome: MaintenanceStepOutcome }
  | { type: "cancel" }
  | { type: "settle_complete" }
  | { type: "fence_settled"; fence: DataConfigurationFenceReceipt }
  /** `openmapx control resolve` after the operator checked the host. */
  | { type: "resolve"; as: "committed" | "failed" };

export type MaintenanceEffect =
  | { type: "prepare_fence" }
  | { type: "release_lease" }
  /** The caller records `step_start` for this step next. */
  | { type: "start_step"; ordinal: number }
  | { type: "dispatch_step"; ordinal: number }
  | { type: "apply_succeeded"; handoff: "running" | null }
  | { type: "apply_failed"; outcome: MaintenanceStepOutcome }
  | { type: "settle_fence"; outcome: MaintenanceFenceOutcome }
  | { type: "watch_helper" }
  | { type: "cancel_lease" }
  | { type: "reopen_admissions" };

export type MaintenanceRefusal = "busy" | "conflict" | "expired" | "recovery_required";
export class MaintenanceTransitionRefused extends Error {
  constructor(readonly reason: MaintenanceRefusal) {
    super(`Configuration maintenance refused: ${reason}`);
    this.name = "MaintenanceTransitionRefused";
  }
}

export interface MaintenanceTransition {
  record: MaintenanceRecord;
  effects: MaintenanceEffect[];
  /** False when nothing changed: the caller writes nothing. */
  changed: boolean;
}

function refuse(reason: MaintenanceRefusal): never {
  throw new MaintenanceTransitionRefused(reason);
}
const unresolved = (step: MaintenanceRecordStep) => step.state === "attempted";
const handoffStep = (record: MaintenanceRecord) =>
  record.steps.find((step) => step.phase === "maintenance-handoff");

/** The next step whose prerequisites all committed, if every earlier step committed. */
function nextRunnable(record: MaintenanceRecord): MaintenanceRecordStep | undefined {
  const pending = record.steps.find((step) => step.state === "pending");
  if (
    !pending ||
    record.steps.some(
      (step) =>
        step.ordinal < pending.ordinal &&
        (step.state !== "terminal" || step.outcome !== "committed"),
    )
  )
    return undefined;
  return pending.prerequisites.every(
    (index) =>
      record.steps[index]?.state === "terminal" && record.steps[index].outcome === "committed",
  )
    ? pending
    : undefined;
}

function settlementOutcome(record: MaintenanceRecord): MaintenanceFenceOutcome {
  return record.generation === "committed"
    ? "applied"
    : record.generation === "not_started"
      ? "unused"
      : "contained";
}

/** Applies one event. Throws MaintenanceTransitionRefused, without a write, for
 * every pair the table does not list. `now` is an ISO time; `nowMs` the same
 * instant for deadline checks. */
export function transitionMaintenance(
  input: MaintenanceRecord,
  event: MaintenanceEvent,
  now: Date,
): MaintenanceTransition {
  const record = structuredClone(maintenanceRecordSchema.parse(input));
  const iso = now.toISOString();
  const effects: MaintenanceEffect[] = [];
  const unchanged = (): MaintenanceTransition => ({ record: input, effects: [], changed: false });
  const enterSettling = (outcome: MaintenanceFenceOutcome) => {
    record.state = "settling";
    record.fenceOutcome = outcome;
    effects.push({ type: "settle_fence", outcome });
  };
  const settleRelease = () => {
    record.state = "settled";
    record.settledAt = iso;
    effects.push({ type: "release_lease" });
  };
  const step = (ordinal: number) => record.steps[ordinal] ?? refuse("conflict");

  switch (event.type) {
    case "fence_prepared":
      if (record.state !== "preparing") refuse("conflict");
      if (
        event.fence.maintenanceId !== record.maintenanceId ||
        event.fence.candidateId !== record.binding.candidateId ||
        event.fence.state !== "prepared"
      )
        refuse("conflict");
      record.fence = dataConfigurationFenceReceiptSchema.parse(event.fence);
      record.state = "prepared";
      break;
    case "fence_not_prepared":
      if (record.state !== "preparing") refuse("conflict");
      settleRelease();
      break;
    case "fence_unknown":
      if (record.state !== "preparing") refuse("conflict");
      record.state = "recovery_required";
      break;
    case "startup":
      if (record.state === "preparing") {
        if (event.fenceDelegated) record.state = "recovery_required";
        else settleRelease();
        break;
      }
      if (record.state === "applying") {
        const handoff = handoffStep(record);
        if (handoff?.state === "attempted") {
          effects.push({ type: "watch_helper" });
          return { record: input, effects, changed: false };
        }
        if (record.steps.some(unresolved)) {
          record.state = "recovery_required";
          break;
        }
      }
      return unchanged();
    case "apply": {
      if (record.state === "applying" && event.apiJobId === record.apiJobId) return unchanged();
      if (record.state !== "prepared") refuse(record.state === "preparing" ? "busy" : "conflict");
      if (event.apiJobId !== record.apiJobId) refuse("conflict");
      if (record.cancelRequestedAt) refuse("conflict");
      if (now.getTime() >= record.prepare.deadlineAt) refuse("expired");
      record.state = "applying";
      const first = nextRunnable(record);
      if (first) effects.push({ type: "start_step", ordinal: first.ordinal });
      break;
    }
    case "abandon":
      if (record.state === "settling" || record.state === "settled") return unchanged();
      if (record.state !== "prepared" && record.state !== "applying") refuse("busy");
      if (record.steps.some((value) => value.state !== "pending")) refuse("conflict");
      enterSettling("unused");
      break;
    case "deadline_passed":
      if (
        (record.state !== "prepared" && record.state !== "applying") ||
        record.steps.some((value) => value.state !== "pending") ||
        now.getTime() < record.prepare.deadlineAt
      )
        return unchanged();
      enterSettling("unused");
      break;
    case "step_start": {
      const target = step(event.ordinal);
      if (record.state !== "applying" || record.cancelRequestedAt) refuse("conflict");
      if (nextRunnable(record)?.ordinal !== target.ordinal) refuse("conflict");
      target.state = "attempted";
      if (target.phase === "maintenance-handoff") {
        const { handoffId } = target.operation as { handoffId?: string };
        if (!handoffId) refuse("conflict");
        record.handoff = { handoffId, containerId: null };
      }
      effects.push({ type: "dispatch_step", ordinal: target.ordinal });
      break;
    }
    case "step_terminal": {
      const target = step(event.ordinal);
      if (target.state === "terminal" && target.outcome === event.outcome) return unchanged();
      if (record.state !== "applying" || target.state !== "attempted") refuse("conflict");
      if (target.phase === "maintenance-handoff") refuse("conflict");
      if (event.outcome === "unknown") {
        target.state = "terminal";
        target.outcome = "unknown";
        if (target.phase === "configuration-commit") record.generation = "unknown";
        record.followUp = "unknown";
        record.state = "recovery_required";
        break;
      }
      target.state = "terminal";
      target.outcome = event.outcome;
      if (target.phase === "configuration-commit") {
        if (event.outcome === "committed") {
          if (event.appliedRevisionId !== record.binding.revisionId) refuse("conflict");
          record.generation = "committed";
          record.appliedRevisionId = record.binding.revisionId;
        } else record.generation = "not_committed";
      }
      if (event.outcome !== "committed") {
        record.followUp = "contained";
        effects.push({ type: "apply_failed", outcome: event.outcome });
        break;
      }
      const next = record.cancelRequestedAt ? undefined : nextRunnable(record);
      if (next) effects.push({ type: "start_step", ordinal: next.ordinal });
      else if (record.steps.every((value) => value.outcome === "committed")) {
        record.followUp = "complete";
        effects.push({ type: "apply_succeeded", handoff: null });
      } else {
        record.followUp = "contained";
        effects.push({ type: "apply_failed", outcome: "contained" });
      }
      break;
    }
    case "handoff_launched": {
      const handoff = handoffStep(record);
      const launched = record.handoff;
      if (record.state !== "applying" || handoff?.state !== "attempted" || !launched)
        refuse("conflict");
      if (launched.containerId === event.containerId) return unchanged();
      record.handoff = { ...launched, containerId: event.containerId };
      effects.push({ type: "apply_succeeded", handoff: "running" });
      break;
    }
    case "helper_exited": {
      const handoff = handoffStep(record);
      if (handoff?.state === "terminal" && handoff.outcome === event.outcome) return unchanged();
      if (record.state !== "applying" || handoff?.state !== "attempted") refuse("conflict");
      handoff!.state = "terminal";
      handoff!.outcome = event.outcome;
      record.followUp =
        event.outcome === "committed"
          ? "complete"
          : event.outcome === "unknown"
            ? "unknown"
            : "contained";
      if (event.outcome === "unknown") record.state = "recovery_required";
      effects.push({ type: "reopen_admissions" });
      break;
    }
    case "cancel":
      if (record.state === "prepared") {
        enterSettling("unused");
        break;
      }
      if (record.state !== "applying") return unchanged();
      if (record.cancelRequestedAt) return unchanged();
      record.cancelRequestedAt = iso;
      effects.push({ type: "cancel_lease" });
      break;
    case "settle_complete":
      if (record.state === "settled") return unchanged();
      if (record.state === "settling") {
        effects.push({ type: "settle_fence", outcome: record.fenceOutcome! });
        return { record: input, effects, changed: false };
      }
      if (record.state === "recovery_required") refuse("recovery_required");
      if (record.state !== "applying") refuse("busy");
      if (record.steps.some(unresolved)) refuse("busy");
      if (record.followUp === "not_started")
        record.followUp = record.generation === "not_started" ? "not_started" : "contained";
      enterSettling(settlementOutcome(record));
      break;
    case "fence_settled":
      if (record.state === "settled") return unchanged();
      if (record.state !== "settling") refuse("conflict");
      if (
        event.fence.maintenanceId !== record.maintenanceId ||
        event.fence.candidateId !== record.binding.candidateId ||
        event.fence.state !== "settled"
      )
        refuse("conflict");
      if (record.steps.some(unresolved)) refuse("busy");
      record.fence = dataConfigurationFenceReceiptSchema.parse(event.fence);
      settleRelease();
      break;
    case "resolve":
      if (record.state !== "recovery_required") refuse("conflict");
      for (const value of record.steps)
        if (value.state === "attempted" || value.outcome === "unknown") {
          value.state = "terminal";
          value.outcome = event.as === "committed" ? "committed" : "contained";
        }
      if (record.generation === "unknown")
        record.generation = event.as === "committed" ? "committed" : "not_committed";
      if (record.generation === "committed" && !record.appliedRevisionId)
        record.appliedRevisionId = record.binding.revisionId;
      if (record.generation !== "not_started")
        record.followUp = event.as === "committed" ? "complete" : "contained";
      enterSettling(settlementOutcome(record));
      break;
  }
  record.sequence += 1;
  record.updatedAt = iso;
  return { record: maintenanceRecordSchema.parse(record), effects, changed: true };
}

/** Whether the fence and the lease may be released: no step is attempted and unfinished. */
export function maintenanceStepsResolved(record: MaintenanceRecord): boolean {
  return !record.steps.some(unresolved);
}
