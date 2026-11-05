import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realSetTimeout } from "node:timers";
import {
  controlTerminalReceiptDigest,
  normalizeExecutionAdmission,
  type OpsOperation,
  opsOperationFingerprint,
  parseOpsJobStatus,
  verifyApiJobParentExecution,
  verifyApiRetentionProof,
} from "@openmapx/core/ops";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner.js";

// Integration-route imports require a synthetic application secret, scoped to this file.
const authSecret = vi.hoisted(() => {
  const previous = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET ??= "admin-ops-cancellation-unit-only-secret";
  return { previous };
});

// UNIT boundary test, not real host authority or PostgreSQL proof. Replaced
// boundaries: operations agent, service registry and Drizzle-shaped persistence. The admin-ops lifecycle helpers, the
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
      admittedAt: number;
      deadlineAt: number;
      fingerprint: string;
    }>,
    cancelCalls: [] as string[],
    acknowledgements: [] as string[],
    events: [] as Array<{ cursor: number; type: "log"; stream: "stdout"; message: string }>,
  };
  return value;
});
const database = vi.hoisted(() => ({
  row: {
    id: "1d2b29cd-23de-4b19-8c32-86c196833b79",
    type: "service.stop",
    status: "running",
    result: null as Record<string, unknown> | null,
  },
  updates: [] as Array<Record<string, unknown>>,
}));
const registryGet = vi.hoisted(() => vi.fn());

function isTerminal(): boolean {
  return agent.state === "succeeded" || agent.state === "failed";
}

function agentStatus() {
  const admission = agent.admissions[0];
  if (!admission) throw new Error("status requested before admission");
  return parseOpsJobStatus({
    version: 2,
    admittedAt: admission.admittedAt,
    deadlineAt: admission.deadlineAt,
    fingerprint: admission.fingerprint,
    kind: admission.operation.kind,
    operationId: admission.operationId,
    operationKey: admission.operationKey,
    resourceId: admission.operation.serviceId,
    state: agent.state,
    submittedAt: new Date(admission.admittedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    ...(agent.state === "succeeded" ? { result: { changed: true } } : {}),
    ...(agent.state === "failed"
      ? {
          errorClass: "runtime",
          ...(agent.terminationRequestedAt === undefined
            ? {}
            : { terminationRequestedAt: agent.terminationRequestedAt }),
        }
      : {}),
  });
}

// One stable client: the docker helper caches the first client it is given.
const agentClient = vi.hoisted(() => ({
  execute: vi.fn(
    async (
      operation: OpsOperation,
      options: {
        operationKey: string;
        execution?: { requestedDeadlineAt: number };
        parentAssertion?: string;
      },
    ) => {
      if (operation.kind === "controlRetention.acknowledge") {
        const proof = verifyApiRetentionProof(token, operation.proof);
        const retained = projectedOperations()?.[operation.operationKey] as
          | {
              attempt?: { attemptId: string };
              receiptDelivery?: { state: string; terminalDigest: string };
            }
          | undefined;
        expect(retained?.receiptDelivery?.state).toBe("pending");
        expect(proof).toMatchObject({
          apiJobId: JOB_ID,
          originalApiOwnerVersion: 1,
          checkpointOwnerVersion: 1,
          attemptId: retained?.attempt?.attemptId,
          operationKey: operation.operationKey,
          fingerprint: operation.fingerprint,
          terminalDigest: controlTerminalReceiptDigest(agentStatus()),
        });
        expect(operation.terminalDigest).toBe(proof.terminalDigest);
        agent.acknowledgements.push(operation.operationKey);
        return { execution: "sync", kind: operation.kind, value: { acknowledged: true } };
      }
      if (!options.parentAssertion) throw Error("Original parent assertion required");
      const parent = verifyApiJobParentExecution(options.parentAssertion, token, {
        operationKey: options.operationKey,
        operationFingerprint: opsOperationFingerprint(operation),
        requestedDeadlineAt: options.execution?.requestedDeadlineAt,
      });
      if (parent.issuer !== "api") throw Error("Original API parent required");
      expect(parent).toMatchObject({ issuer: "api", apiJobId: JOB_ID, apiOwnerVersion: 1 });
      const retained = projectedOperations()?.[options.operationKey];
      expect(retained).toMatchObject({
        operation,
        attempt: { apiJobId: JOB_ID, apiOwnerVersion: 1, attemptId: parent.attemptId },
      });
      const identity = normalizeExecutionAdmission({
        kind: operation.kind,
        operationKey: options.operationKey,
        operationFingerprint: opsOperationFingerprint(operation),
        admittedAt: Date.now(),
        requestedDeadlineAt: options.execution?.requestedDeadlineAt,
        parent,
      });
      const operationId = `job1_${operation.kind.replace(/\W/g, "_")}_0123456789`;
      agent.admissions.push({
        operation,
        operationKey: options.operationKey,
        operationId,
        ...identity,
      });
      return {
        execution: "async",
        kind: operation.kind,
        operationId,
        operationKey: options.operationKey,
        state: "queued",
        fingerprint: identity.fingerprint,
        deadlineAt: identity.deadlineAt,
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
      agent.terminationRequestedAt = new Date().toISOString();
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
// The in-memory row replaces PostgreSQL; real checkpoint merge/identity guards
// still run. This double does not establish locking, CAS or host authority proof.
vi.mock("../../db", () => {
  function update(value: Record<string, unknown>) {
    const apply = () => {
      const p = database.row.result?.opsProjection as
        | { operations: Record<string, { terminal: boolean; receiptDelivery?: { state: string } }> }
        | undefined;
      if (
        value.status === "canceled" &&
        (database.row.status !== "cancel_pending" ||
          !p ||
          Object.values(p.operations).some(
            (o) => !o.terminal || o.receiptDelivery?.state !== "confirmed",
          ))
      )
        return [];
      database.updates.push(value);
      if (typeof value.status === "string") database.row.status = value.status;
      if (value.result && typeof value.result === "object" && !("queryChunks" in value.result))
        database.row.result = structuredClone(value.result as Record<string, unknown>);
      if (value.status === "cancel_pending")
        database.row.result = {
          ...database.row.result,
          _cancelRequestedAt: new Date().toISOString(),
        };
      return [structuredClone(database.row)];
    };
    return {
      returning: async () => apply(),
      // biome-ignore lint/suspicious/noThenProperty: Drizzle updates are intentionally thenable.
      then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(apply()).then(resolve),
    };
  }
  const db = {
    update: vi.fn(() => ({
      set: (value: Record<string, unknown>) => ({ where: () => update(value) }),
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [structuredClone(database.row)],
          for: async () => [structuredClone(database.row)],
        }),
      }),
    })),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return { db };
});

const JOB_ID = "1d2b29cd-23de-4b19-8c32-86c196833b79";

let serviceStop: typeof import("../admin-ops.js").serviceStop;
let serviceRestart: typeof import("../admin-ops.js").serviceRestart;
let createDurableOpsKey: typeof import("../ops-client.js").createDurableOpsKey;
let jobRunner: typeof import("../job-runner.js").jobRunner;

const token = Buffer.alloc(32, 19).toString("base64url");
let tokenDirectory: string;
let previousTokenFile: string | undefined;
beforeAll(async () => {
  tokenDirectory = await mkdtemp(join(tmpdir(), "omx-cancel-unit-"));
  const file = join(tokenDirectory, "api-token");
  await writeFile(file, token, { mode: 0o600 });
  previousTokenFile = process.env.OPS_AGENT_TOKEN_FILE;
  process.env.OPS_AGENT_TOKEN_FILE = file;
});
afterAll(async () => {
  if (authSecret.previous === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = authSecret.previous;
  if (previousTokenFile === undefined) delete process.env.OPS_AGENT_TOKEN_FILE;
  else process.env.OPS_AGENT_TOKEN_FILE = previousTokenFile;
  await rm(tokenDirectory, { recursive: true, force: true });
});

const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  vi.useFakeTimers();
  agent.state = "running";
  agent.cancelBehavior = "hold";
  agent.terminationRequestedAt = undefined;
  agent.admissions.length = 0;
  agent.cancelCalls.length = 0;
  agent.acknowledgements.length = 0;
  agent.events = [];
  database.row.status = "running";
  database.row.result = {
    _execution: { owner: "4c0c9623-252c-41b6-8f99-41915ad38b12", version: 1 },
  };
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
    execution: { owner: "4c0c9623-252c-41b6-8f99-41915ad38b12", version: 1 },
    payload: {},
    signal: controller.signal,
    log,
    setProgress: vi.fn().mockResolvedValue(undefined),
    checkpoint: async (result, _progress, admissionKey, stepAddress) => {
      // Use the production merge/identity checks for managed checkpoints.
      if ((result.opsProjection as { version?: number } | undefined)?.version === 3) {
        const { checkpointOwnedAdminJob } = await import("../admin-job-checkpoint");
        ctx.checkpointResult = await checkpointOwnedAdminJob(
          JOB_ID,
          ctx.execution,
          result,
          undefined,
          admissionKey,
          stepAddress,
          ctx.checkpointResult ?? {},
        );
      } else {
        database.row.result = { ...database.row.result, ...structuredClone(result) };
        ctx.checkpointResult = structuredClone(database.row.result);
      }
    },
    checkpointResult: structuredClone(database.row.result),
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
    // Let native token-file reads settle while fake timers drive bounded polling.
    await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
  expect(predicate(), "bounded condition did not settle").toBe(true);
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
  { name: "stop", kind: "service.stop", run: () => serviceStop },
  {
    name: "restart",
    kind: "service.restart",
    run: () => serviceRestart,
  },
] as const;

describe.each(ACTIONS)("single-service $name cancellation", (scenario) => {
  const stepAddress = () =>
    createDurableOpsKey(`admin-job.service.${scenario.name}`, `${JOB_ID}:redis`);
  const expectedKey = () => {
    const admission = agent.admissions[0];
    if (!admission) throw Error("No admitted operation");
    return admission.operationKey;
  };

  it("persists the admitted operation before waiting, under its stable step address and original attempt", async () => {
    const job = startJob(scenario.run());
    await until(
      () =>
        agent.admissions.length === 1 &&
        Object.values(projectedOperations() ?? {}).some((o) => o.operationId !== undefined),
    );

    expect(agent.admissions).toHaveLength(1);
    expect(agent.admissions[0]?.operation).toEqual({ kind: scenario.kind, serviceId: "redis" });
    expect(expectedKey()).toMatch(/^opk1_t1_/);
    expect(database.row.result?.opsProjection).toMatchObject({
      version: 3,
      steps: {
        [stepAddress()]: {
          operationKey: expectedKey(),
          requestedDeadlineAt: agent.admissions[0]?.deadlineAt,
        },
      },
    });
    expect(projectedOperations()).toEqual({
      [expectedKey()]: expect.objectContaining({
        kind: scenario.kind,
        operationKey: expectedKey(),
        operationId: agent.admissions[0]?.operationId,
        terminal: false,
        attempt: expect.objectContaining({
          apiJobId: JOB_ID,
          apiOwnerVersion: 1,
          attemptId: expect.any(String),
          childOperationFingerprint: opsOperationFingerprint({
            kind: scenario.kind,
            serviceId: "redis",
          }),
        }),
      }),
    });
    expect(job.outcome.state).toBe("pending");
  });

  it("reports cancellation only after the exact agent operation is contained", async () => {
    const job = startJob(scenario.run());
    await until(
      () =>
        agent.admissions.length === 1 &&
        Object.values(projectedOperations() ?? {}).some((o) => o.operationId !== undefined),
    );
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
    expect(job.controller.signal.aborted).toBe(true);
    expect(database.updates).toContainEqual(expect.objectContaining({ status: "cancel_pending" }));
    expect(database.updates).not.toContainEqual(expect.objectContaining({ status: "canceled" }));

    // The agent's authoritative termination is the containment evidence.
    agent.state = "failed";
    await vi.advanceTimersByTimeAsync(600);

    await until(() => cancellation.settled);
    expect(cancellation).toMatchObject({ settled: true, value: true });
    expect(agent.cancelCalls).toEqual([operationId]);
    expect(job.controller.signal.aborted).toBe(true);
    expect(database.updates).toContainEqual(
      expect.objectContaining({ status: "canceled", finishedAt: expect.any(Date) }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(job.outcome.state).toBe("rejected");
    expect(job.outcome.error).toMatchObject({ name: "OpsObservationPending" });
    expect(agent.acknowledgements).toEqual([expectedKey()]);
    expect(projectedOperations()?.[expectedKey()]).toMatchObject({
      terminal: true,
      receiptDelivery: { state: "confirmed" },
    });
    expect(job.log).not.toHaveBeenCalledWith(expect.stringMatching(/ (stopped|restarted)\.$/));
  });

  it("retains pending containment while retiring only the local observer", async () => {
    const job = startJob(scenario.run());
    await until(
      () =>
        agent.admissions.length === 1 &&
        Object.values(projectedOperations() ?? {}).some((o) => o.operationId !== undefined),
    );

    const cancellation = observe(jobRunner.cancel(JOB_ID));
    await vi.advanceTimersByTimeAsync(5_000);

    await until(() => cancellation.settled);
    expect(cancellation).toMatchObject({ settled: true, value: false });
    expect(agent.cancelCalls).toEqual([agent.admissions[0]?.operationId]);
    expect(job.controller.signal.aborted).toBe(true);
    expect(job.outcome.state).toBe("rejected");
    expect(database.row.status).toBe("cancel_pending");
    expect(agent.acknowledgements).toEqual([]);
    expect(database.updates).not.toContainEqual(expect.objectContaining({ status: "canceled" }));
  });

  it("does not turn an operation that already succeeded into a cancellation", async () => {
    agent.cancelBehavior = "already-succeeded";
    const job = startJob(scenario.run());
    await until(
      () =>
        agent.admissions.length === 1 &&
        Object.values(projectedOperations() ?? {}).some((o) => o.operationId !== undefined),
    );

    const cancellation = observe(jobRunner.cancel(JOB_ID));
    await vi.advanceTimersByTimeAsync(2_000);

    await until(() => cancellation.settled);
    expect(cancellation).toMatchObject({ settled: true, value: false });
    expect(job.controller.signal.aborted).toBe(true);
    expect(database.updates).not.toContainEqual(expect.objectContaining({ status: "canceled" }));
    expect(database.row.status).toBe("cancel_pending");
    expect(projectedOperations()?.[expectedKey()]).toMatchObject({
      terminal: true,
      result: { changed: true },
      receiptDelivery: { state: "confirmed", terminalReceipt: { state: "succeeded" } },
    });
    const { resumeAdminJobObservation } = await import("../admin-job-ops");
    const recovered: JobContext = {
      jobId: JOB_ID,
      payload: {},
      execution: { owner: "4c0c9623-252c-41b6-8f99-41915ad38b12", version: 1 },
      signal: new AbortController().signal,
      checkpointResult: structuredClone(database.row.result),
      checkpoint: async () => {},
      log: async () => {},
      setProgress: async () => {},
    };
    await expect(resumeAdminJobObservation(recovered)).resolves.toMatchObject({
      service: "redis",
      action: scenario.name,
    });
    expect(agent.admissions).toHaveLength(1);
  });

  it("does not claim containment for a failure with no termination marker", async () => {
    agent.cancelBehavior = "already-failed";
    const job = startJob(scenario.run());
    await until(
      () =>
        agent.admissions.length === 1 &&
        Object.values(projectedOperations() ?? {}).some((o) => o.operationId !== undefined),
    );

    const cancellation = observe(jobRunner.cancel(JOB_ID));
    await vi.advanceTimersByTimeAsync(2_000);

    await until(() => cancellation.settled);
    expect(cancellation).toMatchObject({ settled: true, value: false });
    expect(job.controller.signal.aborted).toBe(true);
    expect(database.updates).not.toContainEqual(expect.objectContaining({ status: "canceled" }));
    expect(database.row.status).toBe("cancel_pending");
    expect(projectedOperations()?.[expectedKey()]).toMatchObject({
      terminal: true,
      receiptDelivery: { state: "confirmed", terminalReceipt: { state: "failed" } },
    });
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
    await until(
      () =>
        agent.admissions.length === 1 &&
        Object.values(projectedOperations() ?? {}).some((o) => o.operationId !== undefined),
    );
    await vi.advanceTimersByTimeAsync(500);
    agent.state = "succeeded";
    await vi.advanceTimersByTimeAsync(1_000);

    expect(agent.cancelCalls).toEqual([]);
    await until(() => job.outcome.state !== "pending");
    expect(job.outcome.error).toBeUndefined();
    expect(job.outcome.state).toBe("resolved");
    expect(Object.values(projectedOperations() ?? {})).toEqual([
      expect.objectContaining({ kind: "service.stop", terminal: true }),
    ]);
  });
});
