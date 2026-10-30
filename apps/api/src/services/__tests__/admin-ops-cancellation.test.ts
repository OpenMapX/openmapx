import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner.js";

// The module reaches `integration-routes` and therefore Better Auth, which
// asserts on this at import time.
process.env.BETTER_AUTH_SECRET ||= "admin-ops-cancellation-test-stub-secret";

// Controlled boundaries only: the operations agent, the service registry and a
// Drizzle-shaped persistence double. The admin-ops lifecycle helpers, the
// administrative job broker, the ops-client wait/recovery helpers and the job
// runner's cancellation entry point are all the real modules.
const agent = vi.hoisted(() => {
  type State = "running" | "termination_pending" | "succeeded" | "failed";
  type CancelBehavior = "hold" | "already-succeeded" | "already-failed";
  const value = {
    state: "running" as State,
    cancelBehavior: "hold" as CancelBehavior,
    terminationRequestedAt: undefined as string | undefined,
    admissions: [] as Array<{
      operation: { kind: string; serviceId?: string };
      operationKey: string;
      operationId: string;
    }>,
    cancelCalls: [] as string[],
    events: [] as Array<{ cursor: number; type: "log"; stream: "stdout"; message: string }>,
  };
  return value;
});
const database = vi.hoisted(() => ({
  row: { result: null as Record<string, unknown> | null },
  updates: [] as Array<Record<string, unknown>>,
}));
const registryGet = vi.hoisted(() => vi.fn());

function isTerminal(): boolean {
  return agent.state === "succeeded" || agent.state === "failed";
}

function agentStatus() {
  const admission = agent.admissions[0];
  if (!admission) throw new Error("status requested before admission");
  return {
    version: 1,
    kind: admission.operation.kind,
    operationId: admission.operationId,
    operationKey: admission.operationKey,
    resourceId: admission.operation.serviceId,
    state: agent.state,
    submittedAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:01.000Z",
    ...(agent.state === "succeeded" ? { result: { changed: true } } : {}),
    ...(agent.state === "failed"
      ? {
          errorClass: "runtime",
          ...(agent.terminationRequestedAt === undefined
            ? {}
            : { terminationRequestedAt: agent.terminationRequestedAt }),
        }
      : {}),
  };
}

// One stable client: the docker helper caches the first client it is given.
const agentClient = vi.hoisted(() => ({
  execute: vi.fn(
    async (operation: { kind: string; serviceId?: string }, options: { operationKey: string }) => {
      const operationId = `job1_${operation.kind.replace(/\W/g, "_")}_0123456789`;
      agent.admissions.push({ operation, operationKey: options.operationKey, operationId });
      return {
        execution: "async",
        kind: operation.kind,
        operationId,
        operationKey: options.operationKey,
        state: "queued",
      };
    },
  ),
  status: vi.fn(async () => agentStatus()),
  events: vi.fn(async (operationId: string) => ({
    version: 1,
    operationId,
    nextCursor: agent.events.length,
    terminal: isTerminal(),
    truncated: false,
    events: agent.events,
  })),
  cancel: vi.fn(async (operationId: string) => {
    agent.cancelCalls.push(operationId);
    if (agent.cancelBehavior === "hold") {
      agent.state = "termination_pending";
      agent.terminationRequestedAt = "2026-10-25T00:00:02.000Z";
    } else if (agent.cancelBehavior === "already-succeeded") {
      agent.state = "succeeded";
    } else {
      agent.state = "failed";
    }
    return agentStatus();
  }),
  lookup: vi.fn(async () => {
    throw new Error("lookup is not expected in these scenarios");
  }),
}));

vi.mock("../ops-client.js", async (importActual) => ({
  ...(await importActual<typeof import("../ops-client.js")>()),
  createApiOpsClient: () => agentClient,
}));
vi.mock("../service-registry.js", () => ({
  getServiceRegistry: () => ({ get: registryGet }),
}));
vi.mock("../../db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn((value: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          // The queued-job compare-and-set matches nothing: the job is already
          // running, so that update is not recorded as applied.
          returning: vi.fn().mockResolvedValue([]),
          // biome-ignore lint/suspicious/noThenProperty: the Drizzle query builder is thenable.
          then: (resolve: (value: unknown[]) => unknown) => {
            database.updates.push(value);
            return Promise.resolve([]).then(resolve);
          },
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ status: "running", result: database.row.result }]),
        })),
      })),
    })),
  },
}));

const JOB_ID = "1d2b29cd-23de-4b19-8c32-86c196833b79";

let serviceStop: typeof import("../admin-ops.js").serviceStop;
let serviceRestart: typeof import("../admin-ops.js").serviceRestart;
let createDurableOpsKey: typeof import("../ops-client.js").createDurableOpsKey;
let jobRunner: typeof import("../job-runner.js").jobRunner;

const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  vi.useFakeTimers();
  agent.state = "running";
  agent.cancelBehavior = "hold";
  agent.terminationRequestedAt = undefined;
  agent.admissions.length = 0;
  agent.cancelCalls.length = 0;
  agent.events = [];
  database.row.result = null;
  database.updates.length = 0;
  vi.clearAllMocks();
  registryGet.mockReturnValue({ manifest: { id: "redis" }, enabled: true, isBuiltIn: true });
  ({ serviceStop, serviceRestart } = await import("../admin-ops.js"));
  ({ createDurableOpsKey } = await import("../ops-client.js"));
  ({ jobRunner } = await import("../job-runner.js"));
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.useRealTimers();
  }
});

interface RunningJob {
  controller: AbortController;
  log: ReturnType<typeof vi.fn>;
  outcome: { state: "pending" | "resolved" | "rejected"; error?: unknown };
}

function startJob(action: (service: string, ctx: JobContext) => Promise<void>): RunningJob {
  const controller = new AbortController();
  const log = vi.fn().mockResolvedValue(undefined);
  const ctx: JobContext = {
    jobId: JOB_ID,
    payload: {},
    signal: controller.signal,
    log,
    setProgress: vi.fn().mockResolvedValue(undefined),
    checkpoint: async (result) => {
      // A JSON round trip models the persisted row, as the runner's own
      // checkpoint stores the result and mirrors it onto the context.
      database.row.result = JSON.parse(JSON.stringify(result));
      ctx.checkpointResult = result;
    },
    checkpointResult: null,
  };
  const active = (jobRunner as unknown as { active: Map<string, AbortController> }).active;
  active.set(JOB_ID, controller);

  const outcome: RunningJob["outcome"] = { state: "pending" };
  const work = action("redis", ctx).then(
    () => {
      outcome.state = "resolved";
    },
    (error) => {
      outcome.state = "rejected";
      outcome.error = error;
    },
  );
  cleanups.push(async () => {
    // Release the agent, abort local work and drain every timer-driven loop so
    // nothing outlives the test even when an assertion above failed.
    if (!isTerminal()) agent.state = "failed";
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await work;
    active.delete(JOB_ID);
  });
  return { controller, log, outcome };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40 && !predicate(); attempt += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
}

function observe(promise: Promise<boolean>) {
  const state: { settled: boolean; value?: boolean; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

function projectedOperations(): Record<string, Record<string, unknown>> | undefined {
  const projection = database.row.result?.opsProjection as
    | { operations: Record<string, Record<string, unknown>> }
    | undefined;
  return projection?.operations;
}

const ACTIONS = [
  { name: "stop", kind: "service.stop", run: () => serviceStop, failure: "stop exited" },
  {
    name: "restart",
    kind: "service.restart",
    run: () => serviceRestart,
    failure: "restart exited",
  },
] as const;

describe.each(ACTIONS)("single-service $name cancellation", (scenario) => {
  const expectedKey = () =>
    createDurableOpsKey(`admin-job.service.${scenario.name}`, `${JOB_ID}:redis`);

  it("persists the admitted operation before waiting, with the legacy deterministic key", async () => {
    const job = startJob(scenario.run());
    await until(() => projectedOperations() !== undefined);

    expect(agent.admissions).toHaveLength(1);
    expect(agent.admissions[0]?.operation).toEqual({ kind: scenario.kind, serviceId: "redis" });
    expect(agent.admissions[0]?.operationKey).toBe(expectedKey());
    expect(projectedOperations()).toEqual({
      [expectedKey()]: expect.objectContaining({
        kind: scenario.kind,
        operationKey: expectedKey(),
        operationId: agent.admissions[0]?.operationId,
        terminal: false,
      }),
    });
    expect(job.outcome.state).toBe("pending");
  });

  it("reports cancellation only after the exact agent operation is contained", async () => {
    const job = startJob(scenario.run());
    await until(() => projectedOperations() !== undefined);
    const operationId = agent.admissions[0]?.operationId;
    expect(operationId).toBeDefined();
    expect(projectedOperations()?.[expectedKey()]).toMatchObject({ operationId, terminal: false });

    const cancellation = observe(jobRunner.cancel(JOB_ID));
    await until(() => agent.cancelCalls.length > 0);
    // Cancellation reached exactly the admitted operation and is only requested.
    expect(agent.cancelCalls).toEqual([operationId]);
    await vi.advanceTimersByTimeAsync(300);
    expect(agent.state).toBe("termination_pending");
    expect(cancellation.settled).toBe(false);
    expect(job.controller.signal.aborted).toBe(false);
    expect(database.updates).toContainEqual({ status: "cancel_pending" });
    expect(database.updates).not.toContainEqual(expect.objectContaining({ status: "canceled" }));

    // The agent's authoritative termination is the containment evidence.
    agent.state = "failed";
    await vi.advanceTimersByTimeAsync(600);

    expect(cancellation).toMatchObject({ settled: true, value: true });
    expect(agent.cancelCalls).toEqual([operationId]);
    expect(job.controller.signal.aborted).toBe(true);
    expect(database.updates).toContainEqual(
      expect.objectContaining({ status: "canceled", finishedAt: expect.any(Date) }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(job.outcome.state).toBe("rejected");
    expect(job.outcome.error).toMatchObject({ message: expect.stringContaining(scenario.failure) });
    expect(job.log).not.toHaveBeenCalledWith(expect.stringMatching(/ (stopped|restarted)\.$/));
  });

  it("stays pending while the agent has not terminated and never aborts the local work", async () => {
    const job = startJob(scenario.run());
    await until(() => projectedOperations() !== undefined);

    const cancellation = observe(jobRunner.cancel(JOB_ID));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(cancellation).toMatchObject({ settled: true, value: false });
    expect(agent.cancelCalls).toEqual([agent.admissions[0]?.operationId]);
    expect(job.controller.signal.aborted).toBe(false);
    expect(job.outcome.state).toBe("pending");
    expect(database.updates.at(-1)).toEqual({ status: "cancel_pending" });
    expect(database.updates).not.toContainEqual(expect.objectContaining({ status: "canceled" }));
  });

  it("does not turn an operation that already succeeded into a cancellation", async () => {
    agent.cancelBehavior = "already-succeeded";
    const job = startJob(scenario.run());
    await until(() => projectedOperations() !== undefined);

    const cancellation = observe(jobRunner.cancel(JOB_ID));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(cancellation).toMatchObject({ settled: true, value: false });
    expect(job.controller.signal.aborted).toBe(false);
    expect(database.updates).not.toContainEqual(expect.objectContaining({ status: "canceled" }));
    expect(database.updates.at(-1)).toEqual({ status: "running" });
    expect(job.outcome.state).toBe("resolved");
  });

  it("does not claim containment for a failure with no termination marker", async () => {
    agent.cancelBehavior = "already-failed";
    const job = startJob(scenario.run());
    await until(() => projectedOperations() !== undefined);

    const cancellation = observe(jobRunner.cancel(JOB_ID));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(cancellation).toMatchObject({ settled: true, value: false });
    expect(job.controller.signal.aborted).toBe(false);
    expect(database.updates).not.toContainEqual(expect.objectContaining({ status: "canceled" }));
    expect(database.updates.at(-1)).toEqual({ status: "running" });
    expect(job.outcome.state).toBe("rejected");
  });
});

describe("single-service operation projection", () => {
  it("does not cancel the agent operation when mirroring its log into the job fails", async () => {
    agent.events = [{ cursor: 1, type: "log", stream: "stdout", message: "stopping" }];
    const job = startJob(serviceStop);
    job.log.mockImplementation(async (_line: string, _stream?: string, sourceEventId?: string) => {
      if (sourceEventId) throw new Error("database unavailable");
    });
    await until(() => projectedOperations() !== undefined);
    await vi.advanceTimersByTimeAsync(500);
    agent.state = "succeeded";
    await vi.advanceTimersByTimeAsync(1_000);

    expect(agent.cancelCalls).toEqual([]);
    expect(job.outcome.state).toBe("resolved");
    expect(Object.values(projectedOperations() ?? {})).toEqual([
      expect.objectContaining({ kind: "service.stop", terminal: true }),
    ]);
  });
});
