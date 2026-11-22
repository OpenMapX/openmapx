import { describe, expect, it } from "vitest";
import {
  type MaintenanceEvent,
  type MaintenanceRecord,
  MaintenanceTransitionRefused,
  maintenanceStepsResolved,
  transitionMaintenance,
} from "./configuration-maintenance-record";

const maintenanceId = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const apiJobId = "44444444-4444-4444-8444-444444444444";
const handoffId = "55555555-5555-4555-8555-555555555555";
const revisionId = `cfg1_${"e".repeat(43)}`;
const deadlineAt = 1_000_000;
const now = new Date(500_000);
const later = new Date(deadlineAt + 1);

function fence(state: "prepared" | "settled") {
  return {
    maintenanceId,
    candidateId,
    ownerPrepare: prepare,
    planDigest: "1".repeat(64),
    revisionId,
    hardlinkPlanDigest: null,
    fenceId: "66666666-6666-4666-8666-666666666666",
    sequence: state === "prepared" ? 0 : 1,
    state,
  };
}
const prepare = {
  executor: "ops-agent" as const,
  principal: "api" as const,
  executionId: "job1_originalPrepare0001",
  operationKey: "opk1_originalPrepare0001",
  operationFingerprint: "a".repeat(64),
  fingerprint: "b".repeat(64),
  deadlineAt,
};
const generation = {
  kind: "vault.apply" as const,
  serviceId: "data-manager",
  revisionId,
  payloadDigest: "d".repeat(64),
  maintenanceId,
  candidateId,
  expectedCurrentRevisionId: `cfg1_${"d".repeat(43)}`,
  expectedSourceRevision: "33333333-3333-4333-8333-333333333333",
  coordinatorMode: "ensure-running" as const,
};

function record(options: { handoff?: boolean } = {}): MaintenanceRecord {
  const serviceIds = ["data-manager", "motis"];
  const steps: MaintenanceRecord["steps"] = [
    {
      phase: "configuration-commit",
      ordinal: 0,
      operation: generation,
      operationKey: "opk1_originalStep00000001",
      serviceIds,
      prerequisites: [],
      state: "pending",
    },
    {
      phase: "maintenance-recreate",
      ordinal: 1,
      operation: {
        kind: "service.recreate",
        serviceId: "motis",
        expectedConfigurationRevisionId: revisionId,
        maintenanceId,
        planDigest: "1".repeat(64),
      },
      operationKey: "opk1_originalStep00000002",
      serviceIds,
      prerequisites: [0],
      state: "pending",
    },
  ];
  if (options.handoff)
    steps.push({
      phase: "maintenance-handoff",
      ordinal: 2,
      operation: {
        kind: "configurationHandoff.prepare",
        maintenanceId,
        candidateId,
        handoffId,
        previewFingerprint: "7".repeat(64),
        serviceIds: ["api"],
        expectedImageIdentities: { api: `sha256:${"8".repeat(64)}` },
        mode: { kind: "configuration" },
        expectedCurrentRevisionId: revisionId,
        planDigest: "1".repeat(64),
      },
      operationKey: "opk1_originalStep00000003",
      serviceIds: ["api"],
      prerequisites: [1],
      state: "pending",
    });
  return {
    version: 1,
    maintenanceId,
    prepare,
    apiJobId,
    leaseId: "77777777-7777-4777-8777-777777777777",
    binding: {
      maintenanceId,
      candidateId,
      applyOperationKey: "opk1_originalStep00000001",
      applyOperationFingerprint: "c".repeat(64),
      expectedCurrentRevisionId: generation.expectedCurrentRevisionId,
      revisionId,
      expectedSourceRevision: generation.expectedSourceRevision,
      coordinatorMode: "ensure-running",
      followUp: options.handoff ? "platform-apply" : "service-apply",
    },
    serviceIds: options.handoff ? ["api", "data-manager", "motis"] : serviceIds,
    steps,
    fence: null,
    handoff: null,
    state: "preparing",
    generation: "not_started",
    appliedRevisionId: null,
    followUp: "not_started",
    fenceOutcome: null,
    cancelRequestedAt: null,
    sequence: 0,
    updatedAt: now.toISOString(),
    settledAt: null,
  };
}

/** Runs events in order and returns the last transition. */
function run(start: MaintenanceRecord, ...events: MaintenanceEvent[]) {
  let current = { record: start, effects: [] as unknown[], changed: false };
  for (const event of events) current = transitionMaintenance(current.record, event, now);
  return current;
}
const prepared = (options?: { handoff?: boolean }) =>
  run(record(options), { type: "fence_prepared", fence: fence("prepared") }).record;
const refusal = (start: MaintenanceRecord, event: MaintenanceEvent, at = now) => {
  try {
    transitionMaintenance(start, event, at);
  } catch (error) {
    expect(error).toBeInstanceOf(MaintenanceTransitionRefused);
    return (error as MaintenanceTransitionRefused).reason;
  }
  throw Error("Transition was not refused");
};

describe("configuration maintenance transitions", () => {
  it("prepares, applies every step, settles and then releases", () => {
    let t = run(record(), { type: "fence_prepared", fence: fence("prepared") });
    expect(t.record.state).toBe("prepared");
    expect(t.effects).toEqual([]);
    t = run(t.record, { type: "apply", apiJobId });
    expect(t.record.state).toBe("applying");
    expect(t.effects).toEqual([{ type: "start_step", ordinal: 0 }]);
    t = run(t.record, { type: "step_start", ordinal: 0 });
    expect(t.record.steps[0]?.state).toBe("attempted");
    expect(t.effects).toEqual([{ type: "dispatch_step", ordinal: 0 }]);
    t = run(t.record, {
      type: "step_terminal",
      ordinal: 0,
      outcome: "committed",
      appliedRevisionId: revisionId,
    });
    expect(t.record).toMatchObject({ generation: "committed", appliedRevisionId: revisionId });
    expect(t.effects).toEqual([{ type: "start_step", ordinal: 1 }]);
    t = run(
      t.record,
      { type: "step_start", ordinal: 1 },
      { type: "step_terminal", ordinal: 1, outcome: "committed" },
    );
    expect(t.record.followUp).toBe("complete");
    expect(t.effects).toEqual([{ type: "apply_succeeded", handoff: null }]);
    t = run(t.record, { type: "settle_complete" });
    expect(t.record).toMatchObject({ state: "settling", fenceOutcome: "applied" });
    expect(t.effects).toEqual([{ type: "settle_fence", outcome: "applied" }]);
    t = run(t.record, { type: "fence_settled", fence: fence("settled") });
    expect(t.record.state).toBe("settled");
    expect(t.record.settledAt).toBe(now.toISOString());
    expect(t.effects).toEqual([{ type: "release_lease" }]);
  });

  it("settles a failed fence preparation and releases, or holds an unknown one", () => {
    const failed = run(record(), { type: "fence_not_prepared" });
    expect(failed.record.state).toBe("settled");
    expect(failed.effects).toEqual([{ type: "release_lease" }]);
    const unknown = run(record(), { type: "fence_unknown" });
    expect(unknown.record.state).toBe("recovery_required");
    expect(unknown.effects).toEqual([]);
  });

  it("decides a restarted preparation by whether the fence child was delegated", () => {
    expect(run(record(), { type: "startup", fenceDelegated: false }).record.state).toBe("settled");
    const delegated = run(record(), { type: "startup", fenceDelegated: true });
    expect(delegated.record.state).toBe("recovery_required");
    expect(delegated.effects).toEqual([]);
  });

  it("gives recovery_required on startup with a non-handoff step attempted", () => {
    const attempted = run(
      prepared(),
      { type: "apply", apiJobId },
      { type: "step_start", ordinal: 0 },
    );
    const restarted = run(attempted.record, { type: "startup", fenceDelegated: true });
    expect(restarted.record.state).toBe("recovery_required");
    expect(refusal(restarted.record, { type: "settle_complete" })).toBe("recovery_required");
  });

  it("watches the helper on startup with the handoff attempted and changes nothing", () => {
    const launched = run(
      prepared({ handoff: true }),
      { type: "apply", apiJobId },
      { type: "step_start", ordinal: 0 },
      { type: "step_terminal", ordinal: 0, outcome: "committed", appliedRevisionId: revisionId },
      { type: "step_start", ordinal: 1 },
      { type: "step_terminal", ordinal: 1, outcome: "committed" },
      { type: "step_start", ordinal: 2 },
    );
    expect(launched.record.handoff).toEqual({ handoffId, containerId: null });
    const restarted = run(launched.record, { type: "startup", fenceDelegated: true });
    expect(restarted.changed).toBe(false);
    expect(restarted.record.state).toBe("applying");
    expect(restarted.effects).toEqual([{ type: "watch_helper" }]);
  });

  it("succeeds apply with the handoff running and settles only once the helper exited", () => {
    let t = run(
      prepared({ handoff: true }),
      { type: "apply", apiJobId },
      { type: "step_start", ordinal: 0 },
      { type: "step_terminal", ordinal: 0, outcome: "committed", appliedRevisionId: revisionId },
      { type: "step_start", ordinal: 1 },
      { type: "step_terminal", ordinal: 1, outcome: "committed" },
    );
    expect(t.effects).toEqual([{ type: "start_step", ordinal: 2 }]);
    t = run(
      t.record,
      { type: "step_start", ordinal: 2 },
      { type: "handoff_launched", containerId: "c1" },
    );
    expect(t.effects).toEqual([{ type: "apply_succeeded", handoff: "running" }]);
    expect(refusal(t.record, { type: "settle_complete" })).toBe("busy");
    expect(refusal(t.record, { type: "step_terminal", ordinal: 2, outcome: "committed" })).toBe(
      "conflict",
    );
    const done = run(t.record, { type: "helper_exited", outcome: "committed" });
    expect(done.record.followUp).toBe("complete");
    expect(done.effects).toEqual([{ type: "reopen_admissions" }]);
    expect(run(done.record, { type: "settle_complete" }).effects).toEqual([
      { type: "settle_fence", outcome: "applied" },
    ]);
    const contained = run(t.record, { type: "helper_exited", outcome: "contained" });
    expect(contained.record).toMatchObject({ state: "applying", followUp: "contained" });
    const unknown = run(t.record, { type: "helper_exited", outcome: "unknown" });
    expect(unknown.record.state).toBe("recovery_required");
    expect(unknown.effects).toEqual([{ type: "reopen_admissions" }]);
  });

  it("fails apply on a contained generation and leaves later steps pending", () => {
    const t = run(
      prepared(),
      { type: "apply", apiJobId },
      { type: "step_start", ordinal: 0 },
      { type: "step_terminal", ordinal: 0, outcome: "failed_without_effect" },
    );
    expect(t.record).toMatchObject({ generation: "not_committed", followUp: "contained" });
    expect(t.record.steps[1]?.state).toBe("pending");
    expect(t.effects).toEqual([{ type: "apply_failed", outcome: "failed_without_effect" }]);
    expect(refusal(t.record, { type: "step_start", ordinal: 1 })).toBe("conflict");
    expect(run(t.record, { type: "settle_complete" }).effects).toEqual([
      { type: "settle_fence", outcome: "contained" },
    ]);
  });

  it("holds an unknown step for recovery and resolves it as the operator says", () => {
    const t = run(
      prepared(),
      { type: "apply", apiJobId },
      { type: "step_start", ordinal: 0 },
      { type: "step_terminal", ordinal: 0, outcome: "unknown" },
    );
    expect(t.record).toMatchObject({ state: "recovery_required", generation: "unknown" });
    expect(t.effects).toEqual([]);
    const committed = run(t.record, { type: "resolve", as: "committed" });
    expect(committed.record).toMatchObject({
      state: "settling",
      generation: "committed",
      appliedRevisionId: revisionId,
    });
    expect(committed.effects).toEqual([{ type: "settle_fence", outcome: "applied" }]);
    const failed = run(t.record, { type: "resolve", as: "failed" });
    expect(failed.effects).toEqual([{ type: "settle_fence", outcome: "contained" }]);
  });

  it("abandons a prepared maintenance with no step attempted, by settle, cancel or deadline", () => {
    for (const event of [{ type: "abandon" }, { type: "cancel" }] as const) {
      const t = run(prepared(), event);
      expect(t.record).toMatchObject({ state: "settling", fenceOutcome: "unused" });
      expect(t.effects).toEqual([{ type: "settle_fence", outcome: "unused" }]);
    }
    const passed = transitionMaintenance(prepared(), { type: "deadline_passed" }, later);
    expect(passed.record).toMatchObject({ state: "settling", fenceOutcome: "unused" });
    expect(passed.effects).toEqual([{ type: "settle_fence", outcome: "unused" }]);
    // Before the deadline the check changes nothing.
    expect(run(prepared(), { type: "deadline_passed" }).changed).toBe(false);
    // An apply that stopped before its first step ends at the deadline too.
    const unstarted = transitionMaintenance(prepared(), { type: "apply", apiJobId }, now).record;
    expect(transitionMaintenance(unstarted, { type: "deadline_passed" }, later).record.state).toBe(
      "settling",
    );
    const attempted = run(
      prepared(),
      { type: "apply", apiJobId },
      { type: "step_start", ordinal: 0 },
    );
    expect(refusal(attempted.record, { type: "abandon" })).toBe("conflict");
    // A step attempted is never abandoned by the deadline: its outcome decides.
    expect(
      transitionMaintenance(attempted.record, { type: "deadline_passed" }, later).changed,
    ).toBe(false);
  });

  it("refuses apply after the deadline, for another job or after a cancel", () => {
    expect(refusal(prepared(), { type: "apply", apiJobId }, later)).toBe("expired");
    expect(
      refusal(prepared(), { type: "apply", apiJobId: "99999999-9999-4999-8999-999999999999" }),
    ).toBe("conflict");
    expect(refusal(record(), { type: "apply", apiJobId })).toBe("busy");
    const again = run(prepared(), { type: "apply", apiJobId }, { type: "apply", apiJobId });
    expect(again.changed).toBe(false);
  });

  it("starts no new step after a cancel and fails apply once the in-flight step ends", () => {
    let t = run(
      prepared(),
      { type: "apply", apiJobId },
      { type: "step_start", ordinal: 0 },
      { type: "cancel" },
    );
    expect(t.record.cancelRequestedAt).toBe(now.toISOString());
    expect(t.effects).toEqual([{ type: "cancel_lease" }]);
    t = run(t.record, {
      type: "step_terminal",
      ordinal: 0,
      outcome: "committed",
      appliedRevisionId: revisionId,
    });
    expect(t.effects).toEqual([{ type: "apply_failed", outcome: "contained" }]);
    expect(refusal(t.record, { type: "step_start", ordinal: 1 })).toBe("conflict");
    expect(run(t.record, { type: "settle_complete" }).effects).toEqual([
      { type: "settle_fence", outcome: "applied" },
    ]);
  });

  it("refuses settle while a step is attempted and repeats the fence settle while settling", () => {
    const attempted = run(
      prepared(),
      { type: "apply", apiJobId },
      { type: "step_start", ordinal: 0 },
    );
    expect(refusal(attempted.record, { type: "settle_complete" })).toBe("busy");
    expect(maintenanceStepsResolved(attempted.record)).toBe(false);
    const settling = run(prepared(), { type: "abandon" });
    const repeated = run(settling.record, { type: "settle_complete" });
    expect(repeated.changed).toBe(false);
    expect(repeated.effects).toEqual([{ type: "settle_fence", outcome: "unused" }]);
    const settled = run(settling.record, { type: "fence_settled", fence: fence("settled") });
    expect(run(settled.record, { type: "settle_complete" }).changed).toBe(false);
  });

  it("refuses every unlisted pair without changing the record", () => {
    const events: MaintenanceEvent[] = [
      { type: "fence_prepared", fence: fence("prepared") },
      { type: "fence_not_prepared" },
      { type: "fence_unknown" },
      { type: "apply", apiJobId },
      { type: "abandon" },
      { type: "step_start", ordinal: 0 },
      { type: "step_terminal", ordinal: 0, outcome: "committed", appliedRevisionId: revisionId },
      { type: "handoff_launched", containerId: "c1" },
      { type: "helper_exited", outcome: "committed" },
      { type: "cancel" },
      { type: "settle_complete" },
      { type: "fence_settled", fence: fence("settled") },
      { type: "resolve", as: "committed" },
    ];
    const settled = run(
      prepared(),
      { type: "abandon" },
      { type: "fence_settled", fence: fence("settled") },
    ).record;
    const states: Record<string, MaintenanceRecord> = {
      preparing: record(),
      prepared: prepared(),
      settled,
    };
    const listed: Record<string, string[]> = {
      preparing: ["fence_prepared", "fence_not_prepared", "fence_unknown"],
      prepared: ["fence_prepared", "apply", "abandon", "cancel"],
      settled: ["abandon", "cancel", "settle_complete", "fence_settled"],
    };
    for (const [name, start] of Object.entries(states)) {
      const before = JSON.stringify(start);
      for (const event of events) {
        let result: ReturnType<typeof transitionMaintenance> | undefined;
        try {
          result = transitionMaintenance(start, event, now);
        } catch (error) {
          expect(error).toBeInstanceOf(MaintenanceTransitionRefused);
        }
        if (result?.changed) expect(listed[name]).toContain(event.type);
        expect(JSON.stringify(start)).toBe(before);
      }
    }
    // A repeated preparation answer in prepared is a conflict, not a change.
    expect(refusal(prepared(), { type: "fence_prepared", fence: fence("prepared") })).toBe(
      "conflict",
    );
  });

  it("never releases while a step or the helper is unfinished", () => {
    const launched = run(
      prepared({ handoff: true }),
      { type: "apply", apiJobId },
      { type: "step_start", ordinal: 0 },
      { type: "step_terminal", ordinal: 0, outcome: "committed", appliedRevisionId: revisionId },
      { type: "step_start", ordinal: 1 },
      { type: "step_terminal", ordinal: 1, outcome: "committed" },
      { type: "step_start", ordinal: 2 },
      { type: "handoff_launched", containerId: "c1" },
    ).record;
    for (const event of [
      { type: "settle_complete" },
      { type: "abandon" },
      { type: "fence_settled", fence: fence("settled") },
    ] as MaintenanceEvent[])
      expect(() => transitionMaintenance(launched, event, now)).toThrow(
        MaintenanceTransitionRefused,
      );
  });
});
