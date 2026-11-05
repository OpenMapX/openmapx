import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpsJobStatus, OpsOperation } from "@openmapx/core/ops";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import type { ApiJobChildAttempt } from "../admin-job-parent";
import type { JobContext } from "../job-runner";
import type { ApiOpsClient } from "../ops-client";

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle<typeof schema>>,
  client: null as unknown as ApiOpsClient,
}));
vi.mock("../../db", () => ({
  get db() {
    return state.db;
  },
}));
vi.mock("../ops-client", async (original) => ({
  ...(await original<typeof import("../ops-client")>()),
  createApiOpsClient: () => state.client,
}));
const { jobRunner } = await import("../job-runner");
const { claimAdminJob, renewAdminJobClaim, readJobExecution, JobOwnershipLost } = await import(
  "../admin-job-state"
);
const { executeAdminJobOperation, readProjection } = await import("../admin-job-ops");
const { jobEventBus } = await import("../job-events");
const { OpsClientError } = await import("@openmapx/core/ops");
const { adminJob, adminJobLog } = schema;
const runner = jobRunner as unknown as {
  executeJob(...args: unknown[]): Promise<void>;
  launchJob(...args: unknown[]): Promise<void>;
};

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw Error("Missing fixture value");
  return value;
}
function checkedCheckpoint(
  value: unknown,
): Record<string, unknown> & { opsProjection: ReturnType<typeof readProjection> } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Missing fixture checkpoint");
  return { ...value, opsProjection: readProjection(value) };
}
// Explicit opt-in connection supplied only after the task launcher verifies the
// synthetic container's exact ID/owner. No migrations or table-wide cleanup.
describe.skipIf(
  !process.env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("admin job PostgreSQL ownership/recovery", () => {
  let client: ReturnType<typeof postgres>;
  let root: string;
  const ids: string[] = [];
  beforeAll(async () => {
    const connectionUrl = process.env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL;
    if (!connectionUrl) throw new Error("Explicit synthetic DB required");
    client = postgres(connectionUrl, {
      max: 4,
      connection: { statement_timeout: 5000 },
    });
    state.db = drizzle(client, { schema });
    const active = await state.db
      .select()
      .from(adminJob)
      .where(inArray(adminJob.status, ["queued", "running", "cancel_pending"]));
    expect(active).toEqual([]); // Never adopt another fixture's work.
    root = await mkdtemp(join(tmpdir(), "task022-fix1-"));
    const tokenFile = join(root, "api-token");
    await writeFile(tokenFile, Buffer.alloc(32, 7).toString("base64url"), { mode: 0o600 });
    vi.stubEnv("OPS_AGENT_TOKEN_FILE", tokenFile);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (ids.length) await state.db.delete(adminJob).where(inArray(adminJob.id, ids.splice(0)));
  });
  afterAll(async () => {
    await client?.end({ timeout: 2 });
    if (root) await rm(root, { recursive: true });
    vi.unstubAllEnvs();
  });
  async function seed(
    type = "backup.operation",
    result: Record<string, unknown> = {},
    status = "running",
  ) {
    const id = randomUUID();
    ids.push(id);
    const execution = { owner: randomUUID(), version: 1 };
    const [job] = await state.db
      .insert(adminJob)
      .values({ id, type, status, payload: {}, result: { ...result, _execution: execution } })
      .returning();
    return job;
  }
  const row = async (id: string) =>
    (await state.db.select().from(adminJob).where(eq(adminJob.id, id)))[0];
  const run = (job: typeof adminJob.$inferSelect, observe = false) =>
    runner.executeJob(job.id, job.type, {}, job.result, new AbortController().signal, observe);

  it("rejects a resumed old owner's log before insert/publication and stops forward work", async () => {
    const job = await seed("test.stale-log");
    const ready = Promise.withResolvers<JobContext>();
    const resume = Promise.withResolvers<void>();
    const after = vi.fn();
    jobRunner.register(job.type, async (ctx) => {
      ready.resolve(ctx);
      await resume.promise;
      await ctx.log("stale");
      after();
      return {};
    });
    const logs: unknown[] = [];
    const stop = jobEventBus.subscribe(job.id, ({ event }) => {
      if (event.type === "log") logs.push(event);
    });
    const running = run(job);
    const ctx = await ready.promise;
    await claimAdminJob(job);
    resume.resolve();
    await running;
    stop();
    expect(await state.db.select().from(adminJobLog).where(eq(adminJobLog.jobId, job.id))).toEqual(
      [],
    );
    expect(logs).toEqual([]);
    expect(after).not.toHaveBeenCalled();
    expect(ctx.signal.aborted).toBe(true);
  });

  it("publishes a source event once when its atomic insert is deduplicated", async () => {
    const job = await seed("test.duplicate-log");
    jobRunner.register(job.type, async (ctx) => {
      await ctx.log("once", "stdout", `${job.id}:event`, 1);
      await ctx.log("once", "stdout", `${job.id}:event`, 1);
      return {};
    });
    const logs: unknown[] = [];
    const stop = jobEventBus.subscribe(job.id, ({ event }) => {
      if (event.type === "log") logs.push(event);
    });
    await run(job);
    stop();
    expect(
      await state.db.select().from(adminJobLog).where(eq(adminJobLog.jobId, job.id)),
    ).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it("rechecks ownership after waiting behind a concurrent replacement's row lock", async () => {
    const job = await seed("test.blocked-log");
    const ready = Promise.withResolvers<JobContext>();
    const resume = Promise.withResolvers<void>();
    jobRunner.register(job.type, async (ctx) => {
      ready.resolve(ctx);
      await resume.promise;
      await ctx.log("blocked stale log");
      return {};
    });
    const running = run(job);
    await ready.promise;
    const locked = Promise.withResolvers<number>();
    const commit = Promise.withResolvers<void>();
    const replacement = client.begin(async (tx) => {
      await tx`UPDATE admin_job SET result = result || ${JSON.stringify({ _execution: { owner: randomUUID(), version: 2 } })}::jsonb WHERE id = ${job.id}`;
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      locked.resolve(backend.pid);
      await commit.promise;
    });
    const pid = await locked.promise;
    try {
      resume.resolve();
      await vi.waitFor(
        async () => {
          const [waiting] =
            await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
          expect(waiting.n).toBe(1);
        },
        { timeout: 2000, interval: 10 },
      );
    } finally {
      commit.resolve();
      await replacement;
      await running;
    }
    expect(await state.db.select().from(adminJobLog).where(eq(adminJobLog.jobId, job.id))).toEqual(
      [],
    );
  });

  it("preserves a renewed live lease through checkpoints and rejects a stale due-row claim", async () => {
    const job = await seed("test.live-lease");
    const claimed = await claimAdminJob(job);
    const ready = Promise.withResolvers<JobContext>();
    const resume = Promise.withResolvers<void>();
    jobRunner.register(job.type, async (ctx) => {
      ready.resolve(ctx);
      await resume.promise;
      return {};
    });
    if (!claimed) throw new Error("Missing claim");
    const work = run(claimed);
    const ctx = await ready.promise;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    try {
      vi.setSystemTime(start + 40_000);
      await renewAdminJobClaim(job.id, ctx.execution);
      const live = (await row(job.id)).result as Record<string, unknown>;
      await ctx.checkpoint({ phase: "still working" });
      expect((await row(job.id)).result).toHaveProperty(
        "_observationLeaseUntil",
        live._observationLeaseUntil,
      );
      vi.setSystemTime(start + 65_000); // Original snapshot expired, renewed owner is live.
      expect(await claimAdminJob(claimed, {}, true)).toBeUndefined();
      expect(readJobExecution((await row(job.id)).result)).toEqual(ctx.execution);
      vi.setSystemTime(start + 105_000);
      await expect(renewAdminJobClaim(job.id, ctx.execution)).rejects.toBeInstanceOf(
        JobOwnershipLost,
      );
    } finally {
      resume.resolve();
      await work;
    }
  });

  it.each([
    ["pending", false],
    ["finalization", false],
    ["pending", true],
    ["finalization", true],
  ] as const)(
    "recovers a %s write outage without restart or another POST (backendFailed=%s)",
    async (failure, backendFailed) => {
      const job = await seed();
      const claimed = await claimAdminJob(job);
      let offline = false;
      const update = state.db.update.bind(state.db);
      vi.spyOn(state.db, "update").mockImplementation((...args) => {
        if (offline) throw new Error("synthetic database unavailable");
        return update(...args);
      });
      const key = "opk1_fixround1recover12";
      const opId = "job1_fixround1recover12";
      const terminal: OpsJobStatus = {
        version: 2,
        admittedAt: Date.now(),
        deadlineAt: Date.now() + 300000,
        fingerprint: "a".repeat(64),
        operationId: opId,
        operationKey: key,
        kind: "backup.delete",
        resourceId: "nightly",
        ...(backendFailed
          ? {
              state: "failed",
              errorClass: "runtime",
              failureResult: {
                diagnostics: {
                  truncated: false,
                  tail: [{ stream: "stderr", message: "retained failure" }],
                },
              },
            }
          : { state: "succeeded", result: { backupId: "nightly" } }),
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const execute = vi.fn(
        async (
          operation: OpsOperation,
          options: NonNullable<Parameters<ApiOpsClient["execute"]>[1]>,
        ) => {
          if (operation.kind === "controlRetention.acknowledge")
            return { execution: "sync", kind: operation.kind, value: { acknowledged: true } };
          if (!options.operationKey || !options.execution)
            throw Error("Missing durable fixture root");
          terminal.operationKey = options.operationKey;
          terminal.deadlineAt = options.execution.requestedDeadlineAt;
          return {
            execution: "async",
            kind: "backup.delete",
            operationId: opId,
            operationKey: terminal.operationKey,
            fingerprint: terminal.fingerprint,
            deadlineAt: terminal.deadlineAt,
            state: "queued",
          };
        },
      );
      const status = vi.fn(async () => {
        offline = true;
        if (failure === "pending") throw new OpsClientError("authorization");
        return terminal;
      });
      state.client = {
        execute,
        status,
        events: vi.fn().mockResolvedValue({
          version: 1,
          operationId: opId,
          events: [],
          nextCursor: 0,
          terminal: true,
          truncated: false,
        }),
        cancel: vi.fn(),
        lookup: vi.fn().mockResolvedValue(terminal),
      } as unknown as ApiOpsClient;
      jobRunner.register(job.type, async (ctx) => {
        await executeAdminJobOperation(
          ctx,
          { kind: "backup.delete", backupId: "nightly" },
          "admin-job.backup.delete",
          { client: state.client, operationKey: key },
        );
        return { backupId: "nightly" };
      });
      const outcomes: string[] = [];
      const stop = jobEventBus.subscribe(job.id, ({ event }) => {
        if (event.type === "status") outcomes.push(event.status);
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await runner.launchJob(claimed);
      offline = false;
      expect((await row(job.id)).status).toBe("running");
      expect(outcomes).not.toContain("failed");
      expect(outcomes).not.toContain("canceled");
      status.mockResolvedValue(terminal);
      // The abandoned claim must become due without initialize() or an unknown write.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 65_000);
      await jobRunner.reconcile();
      expect((await row(job.id)).status).toBe(backendFailed ? "failed" : "success");
      if (backendFailed)
        expect((await row(job.id)).result).toHaveProperty(
          "diagnostics.tail.0.message",
          "retained failure",
        );
      expect(
        execute.mock.calls.filter(([operation]) => operation.kind === "backup.delete"),
      ).toHaveLength(1);
      expect(state.client.cancel).not.toHaveBeenCalled();
      if (!backendFailed) expect(outcomes).not.toContain("failed");
      expect(outcomes).not.toContain("canceled");
      stop();
      errors.mockRestore();
    },
  );

  it("never converts repeated success-finalization outages into a handler failure", async () => {
    const job = await seed();
    const claimed = await claimAdminJob(job);
    let failures = 0;
    const update = state.db.update.bind(state.db);
    vi.spyOn(state.db, "update").mockImplementation((...args) => {
      if (failures-- > 0) throw new Error("synthetic DB outage");
      return update(...args);
    });
    jobRunner.register(job.type, async () => {
      failures = 2;
      return { completed: true };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runner.launchJob(claimed);
    expect((await row(job.id)).status).toBe("running");
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "settles cancellation only with containment (reconcile=%s, unknownLink=%s)",
    async (reconcile, unknownLink) => {
      const key = "opk1_fixround1cancel123";
      const operationId = "job1_fixround1cancel123";
      const diagnostics = { truncated: false, tail: [{ stream: "stderr", message: "retained" }] };
      const job = await seed(
        "backup.operation",
        {
          ...(unknownLink
            ? {
                _hardlinkAttempts: {
                  synthetic: { revisionId: "cfg1_synthetic", phase: "attempted" },
                },
              }
            : {}),
          observation: {
            state: "unknown",
            reason: "transport",
            nextCheckAt: new Date(0).toISOString(),
          },
          diagnostics,
          opsProjection: {
            version: 1,
            eventTotal: 0,
            byteTotal: 0,
            truncated: false,
            operations: {
              [key]: {
                kind: "backup.delete",
                operationKey: key,
                operationId,
                cursor: 0,
                events: 0,
                bytes: 0,
                truncated: false,
                terminal: false,
              },
            },
          },
        },
        reconcile ? "cancel_pending" : "running",
      );
      const status = {
        version: 1,
        kind: "backup.delete",
        operationKey: key,
        operationId,
        state: "failed",
        errorClass: "runtime",
        terminationRequestedAt: new Date().toISOString(),
        diagnostics,
      };
      state.client = {
        status: vi.fn().mockResolvedValue(status),
        cancel: vi.fn(),
        lookup: vi.fn(),
      } as unknown as ApiOpsClient;
      const events: unknown[] = [];
      const stop = jobEventBus.subscribe(job.id, ({ event }) => {
        if (event.type === "status" && event.status === "canceled") events.push(event.result);
      });
      if (reconcile) await jobRunner.reconcile();
      else await jobRunner.cancel(job.id);
      stop();
      const finished = await row(job.id);
      expect(finished.result).toHaveProperty("diagnostics", diagnostics);
      if (unknownLink) {
        expect(finished.status).toBe("cancel_pending");
        expect(finished.result).toHaveProperty("observation.state", "unknown");
        expect(events).toEqual([]);
      } else {
        expect(finished.status).toBe("canceled");
        expect(finished.result).not.toHaveProperty("observation");
        expect(events).toEqual([expect.objectContaining({ diagnostics })]);
        expect(events[0]).not.toHaveProperty("observation");
      }
    },
  );

  async function checkpointContexts(job: typeof adminJob.$inferSelect, n = 2) {
    const found: JobContext[] = [],
      ready = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    jobRunner.register(job.type, async (ctx) => {
      found.push(ctx);
      if (found.length === n) ready.resolve();
      await release.promise;
      throw new (await import("../admin-job-failure")).JobObservationPending("transport");
    });
    const runs = Array.from({ length: n }, () => run(job));
    await ready.promise;
    return {
      contexts: found,
      finish: async () => {
        release.resolve();
        await Promise.all(runs);
      },
    };
  }
  function successfulClient() {
    const statuses = new Map<string, OpsJobStatus>();
    let mutations = 0,
      acks = 0;
    const execute = vi.fn(
      async (
        operation: OpsOperation,
        options: NonNullable<Parameters<ApiOpsClient["execute"]>[1]>,
      ) => {
        if (operation.kind === "controlRetention.acknowledge") {
          acks++;
          return { execution: "sync", kind: operation.kind, value: { acknowledged: true } };
        }
        if (operation.kind !== "backup.delete" || !options.operationKey || !options.execution)
          throw Error("Unsupported fixture operation");
        mutations++;
        const id = `job1_${randomUUID().replaceAll("-", "")}`,
          at = Date.now();
        const status: OpsJobStatus = {
          version: 2,
          kind: operation.kind,
          operationId: id,
          operationKey: options.operationKey,
          resourceId: operation.backupId,
          state: "succeeded",
          admittedAt: at,
          deadlineAt: options.execution.requestedDeadlineAt,
          fingerprint: "a".repeat(64),
          result: { backupId: operation.backupId },
          submittedAt: new Date(at).toISOString(),
          updatedAt: new Date(at).toISOString(),
        };
        statuses.set(id, status);
        return { execution: "async", ...status, state: "queued" };
      },
    );
    const client = {
      execute,
      status: vi.fn(async (_kind: string, id: string) => {
        const value = statuses.get(id);
        if (!value) throw new OpsClientError("runtime");
        return value;
      }),
      lookup: vi.fn(async (_op: OpsOperation, key: string) => {
        const value = [...statuses.values()].find((s) => s.operationKey === key);
        if (!value) throw new OpsClientError("runtime");
        return value;
      }),
      events: vi.fn(async (id: string) => ({
        version: 2,
        operationId: id,
        terminal: true,
        events: [],
        nextCursor: 0,
        truncated: false,
      })),
      cancel: vi.fn(),
    } as unknown as ApiOpsClient;
    return { client, counts: () => ({ mutations, acks }), statuses };
  }
  function retainedParent(id: string) {
    return {
      operationKey: `opk1_parent${id.replaceAll("-", "")}`,
      fingerprint: "b".repeat(64),
      deadlineAt: Date.now() + 3600_000,
    };
  }
  async function seedCapacity(count: number, mixed = false) {
    const job = await seed(`test.renewal.capacity.${randomUUID()}`),
      execution = required(readJobExecution(job.result));
    const parent = retainedParent(job.id),
      operations: ReturnType<typeof readProjection>["operations"] = {},
      steps: ReturnType<typeof readProjection>["steps"] = {};
    const { createControlRootOperationKey, controlTerminalReceiptDigest } = await import(
      "@openmapx/core/ops"
    );
    for (let n = 0; n < count; n++) {
      const address = `opk1_legacyfixture${String(n).padStart(16, "0")}`,
        deadlineAt = parent.deadlineAt;
      const key =
        mixed && n % 2 === 0
          ? address
          : createControlRootOperationKey({
              notAfter: deadlineAt,
              nonce: Buffer.from(n.toString(16).padStart(32, "0"), "hex"),
            });
      const operation = { kind: "backup.delete" as const, backupId: `old-${n}` };
      const attempt: ApiJobChildAttempt | undefined =
        mixed && n % 2 === 0
          ? undefined
          : {
              version: 1,
              apiJobId: job.id,
              apiOwnerVersion: execution.version,
              parentOperationKey: parent.operationKey,
              parentFingerprint: parent.fingerprint,
              parentDeadlineAt: parent.deadlineAt,
              childOperationKey: key,
              childOperationFingerprint: (
                await import("@openmapx/core/ops")
              ).opsOperationFingerprint(operation),
              requestedDeadlineAt: deadlineAt,
              attemptId: randomUUID(),
            };
      const status = {
        version: 2 as const,
        operationId: `job1_fixture${String(n).padStart(16, "0")}`,
        operationKey: key,
        kind: operation.kind,
        resourceId: operation.backupId,
        state: "succeeded" as const,
        result: { backupId: operation.backupId },
        admittedAt: deadlineAt - 3600_000,
        deadlineAt,
        fingerprint: "a".repeat(64),
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      operations[key] = {
        kind: operation.kind,
        operationKey: key,
        operationId: status.operationId,
        operation,
        attempt,
        phase: "terminal",
        terminal: true,
        result: status.result,
        fingerprint: status.fingerprint,
        deadlineAt,
        cursor: 0,
        events: 0,
        bytes: 0,
        truncated: false,
        ...(attempt
          ? {
              receiptDelivery: {
                state: "confirmed",
                terminalCopyId: randomUUID(),
                checkpointOwnerVersion: 1,
                terminalDigest: controlTerminalReceiptDigest(status),
                terminalReceipt: status,
              },
            }
          : {}),
      };
      if (attempt) steps[address] = { operationKey: key, requestedDeadlineAt: deadlineAt };
    }
    const result = {
      ...(job.result as Record<string, unknown>),
      _parentExecution: parent,
      untouched: { receipt: "preserve" },
      opsProjection: {
        version: 3,
        eventTotal: 7,
        byteTotal: 17,
        truncated: false,
        steps,
        operations,
      },
    };
    await state.db.update(adminJob).set({ result }).where(eq(adminJob.id, job.id));
    return { ...job, result };
  }
  it("renewal: same-owner same-address different deadlines has one CAS winner and at most one mutation POST", async () => {
    const job = await seed("test.renewal.same-address"),
      holders = await checkpointContexts(job),
      remote = successfulClient();
    const lockReady = Promise.withResolvers<void>(),
      unlock = Promise.withResolvers<void>();
    const locked = state.db.transaction(async (tx) => {
      await tx.select().from(adminJob).where(eq(adminJob.id, job.id)).for("update");
      lockReady.resolve();
      await unlock.promise;
    });
    await lockReady.promise;
    const first = executeAdminJobOperation(
      required(holders.contexts[0]),
      { kind: "backup.delete", backupId: "winner" },
      "test",
      { operationKey: "opk1_sameaddress12345", client: remote.client, pollIntervalMs: 1 },
    );
    await new Promise((r) => setTimeout(r, 15));
    const second = executeAdminJobOperation(
      required(holders.contexts[1]),
      { kind: "backup.delete", backupId: "loser" },
      "test",
      { operationKey: "opk1_sameaddress12345", client: remote.client, pollIntervalMs: 1 },
    );
    unlock.resolve();
    await locked;
    await Promise.allSettled([first, second]);
    const saved = checkedCheckpoint((await row(job.id)).result);
    expect(Object.keys(saved.opsProjection.steps)).toHaveLength(1);
    expect(Object.keys(saved.opsProjection.operations)).toHaveLength(1);
    expect(remote.counts().mutations).toBe(1);
    const winner = required(saved.opsProjection.steps.opk1_sameaddress12345);
    expect(
      (
        required(saved.opsProjection.operations[winner.operationKey]).operation as {
          backupId: string;
        }
      ).backupId,
    ).toBe("winner");
    expect(holders.contexts[1]?.checkpointResult).toMatchObject({
      opsProjection: { steps: { opk1_sameaddress12345: winner } },
    });
    await holders.finish();
  });
  it("renewal: lost acknowledgement and confirmation checkpoint keep a copied known result pending across cached restart", async () => {
    const job = await seedCapacity(0),
      holders = await checkpointContexts(job),
      remote = successfulClient(),
      ctx = required(holders.contexts[0]);
    const execute = remote.client.execute.bind(remote.client);
    let loseAck = true;
    remote.client.execute = vi.fn(async (...args: Parameters<ApiOpsClient["execute"]>) => {
      const result = await execute(...args);
      if (args[0].kind === "controlRetention.acknowledge" && loseAck) {
        loseAck = false;
        throw new OpsClientError("timeout");
      }
      return result;
    }) as ApiOpsClient["execute"];
    await expect(
      executeAdminJobOperation(ctx, { kind: "backup.delete", backupId: "original" }, "test", {
        operationKey: "opk1_receiptdelivery123",
        client: remote.client,
        pollIntervalMs: 1,
      }),
    ).rejects.toMatchObject({ reason: "receipt_delivery" });
    const saved = checkedCheckpoint((await row(job.id)).result),
      projected = required(Object.values(saved.opsProjection.operations)[0]);
    expect(projected).toMatchObject({
      terminal: true,
      result: { backupId: "original" },
      receiptDelivery: {
        state: "pending",
        terminalReceipt: { state: "succeeded", result: { backupId: "original" } },
      },
    });
    expect(projected.outcome).toBeUndefined();
    const { cancelAdminJobOperations } = await import("../admin-job-ops");
    loseAck = true;
    await expect(
      cancelAdminJobOperations(saved, remote.client, { context: ctx, jobId: job.id }),
    ).rejects.toMatchObject({ reason: "receipt_delivery" });
    state.client = remote.client;
    loseAck = true;
    expect(await jobRunner.cancel(job.id)).toBe(false);
    expect((await row(job.id)).result).toMatchObject({
      observation: { state: "receipt_delivery", reason: "receipt_delivery" },
    });
    const { and } = await import("drizzle-orm"),
      { noPendingReceiptDelivery } = await import("../admin-job-state");
    expect(
      await state.db
        .update(adminJob)
        .set({ status: "success" })
        .where(and(eq(adminJob.id, job.id), noPendingReceiptDelivery()))
        .returning({ id: adminJob.id }),
    ).toEqual([]);
    const restarted = required(holders.contexts[1]);
    restarted.checkpointResult = saved;
    const abort = new AbortController();
    abort.abort();
    restarted.signal = abort.signal;
    const checkpoint = restarted.checkpoint;
    let blockConfirmation = true;
    restarted.checkpoint = async (...args) => {
      const entries = Object.values(readProjection(args[0]).operations);
      if (blockConfirmation && entries.some((o) => o.receiptDelivery?.state === "confirmed"))
        throw Error("confirmation DB unavailable");
      await checkpoint(...args);
    };
    await expect(
      executeAdminJobOperation(restarted, { kind: "backup.delete", backupId: "changed" }, "test", {
        operationKey: "opk1_receiptdelivery123",
        client: remote.client,
      }),
    ).rejects.toMatchObject({ reason: "receipt_delivery" });
    expect(
      checkedCheckpoint((await row(job.id)).result).opsProjection.operations[projected.operationKey]
        ?.receiptDelivery?.state,
    ).toBe("pending");
    blockConfirmation = false;
    await expect(
      executeAdminJobOperation(
        restarted,
        { kind: "backup.delete", backupId: "changed-again" },
        "test",
        { operationKey: "opk1_receiptdelivery123", client: remote.client },
      ),
    ).resolves.toEqual({ backupId: "original" });
    const ackCalls = vi
      .mocked(remote.client.execute)
      .mock.calls.filter((c) => c[0].kind === "controlRetention.acknowledge");
    expect(
      new Set(
        ackCalls.map((c) =>
          c[0].kind === "controlRetention.acknowledge" ? c[0].proof : undefined,
        ),
      ).size,
    ).toBe(1);
    expect(ackCalls.every((c) => !c[1]?.signal?.aborted)).toBe(true);
    expect(remote.counts().mutations).toBe(1);
    await holders.finish();
  });
  it("renewal: current-row log capacity admits one last event and stale checkpoints cannot reset its charge", async () => {
    const job = await seedCapacity(0),
      execution = required(readJobExecution(job.result));
    const stale = { ...job.result, _opsLogEvents: 1999, _opsLogBytes: 0 };
    await state.db.update(adminJob).set({ result: stale }).where(eq(adminJob.id, job.id));
    const { insertOwnedJobLog } = await import("../admin-job-state");
    const { checkpointOwnedAdminJob } = await import("../admin-job-checkpoint");
    const entries = [0, 1].map((seq) => ({
      id: `${job.id}:last:${seq}`,
      jobId: job.id,
      seq,
      stream: "stdout",
      line: "last",
      createdAt: new Date(),
    }));
    const accepted = await Promise.all(entries.map((entry) => insertOwnedJobLog(execution, entry)));
    expect(accepted.filter(Boolean)).toHaveLength(1);
    const winner = required(entries[accepted.indexOf(true)]);
    expect(await insertOwnedJobLog(execution, winner)).toBe(false);
    await checkpointOwnedAdminJob(
      job.id,
      execution,
      { ...stale, retainedPatch: true },
      undefined,
      undefined,
      undefined,
      stale,
    );
    expect((await row(job.id)).result).toMatchObject({
      _opsLogEvents: 2000,
      _opsLogBytes: 4,
      retainedPatch: true,
    });
    expect(
      await state.db.select().from(adminJobLog).where(eq(adminJobLog.jobId, job.id)),
    ).toHaveLength(1);
  });
  it("renewal: actual expiry cleanup preserves the last pending terminal copy", async () => {
    const { lt, and, ne } = await import("drizzle-orm"),
      { pruneCompletedJobs } = await import("../activity-retention");
    const job = await seedCapacity(1),
      value = checkedCheckpoint(structuredClone(job.result));
    required(required(Object.values(value.opsProjection.operations)[0]).receiptDelivery).state =
      "pending";
    const cutoff = new Date(Date.now() - 36500 * 24 * 3600_000);
    expect(
      await state.db
        .select({ id: adminJob.id })
        .from(adminJob)
        .where(and(ne(adminJob.id, job.id), lt(adminJob.finishedAt, cutoff))),
    ).toEqual([]);
    await state.db
      .update(adminJob)
      .set({
        status: "failed",
        finishedAt: new Date(cutoff.getTime() - 24 * 3600_000),
        result: value,
      })
      .where(eq(adminJob.id, job.id));
    expect(await pruneCompletedJobs(36500)).toBe(0);
    expect(await row(job.id)).toBeDefined();
  });
  it.each(["success", "failure"])(
    "renewal: actual runner blocks %s finalization when receipt delivery is pending",
    async (outcome) => {
      const job = await seed(`test.renewal.finalization.${outcome}`),
        remote = successfulClient();
      const execute = remote.client.execute.bind(remote.client);
      remote.client.execute = vi.fn(async (...args: Parameters<ApiOpsClient["execute"]>) => {
        if (args[0].kind === "controlRetention.acknowledge") throw new OpsClientError("timeout");
        return execute(...args);
      }) as ApiOpsClient["execute"];
      jobRunner.register(job.type, async (ctx) => {
        try {
          await executeAdminJobOperation(
            ctx,
            { kind: "backup.delete", backupId: "known" },
            "test",
            { client: remote.client, pollIntervalMs: 1 },
          );
        } catch {}
        if (outcome === "failure") throw Error("Known parent failure");
        return { known: "success" };
      });
      await run(job);
      const saved = await row(job.id);
      expect(saved.status).toBe("running");
      expect(saved.finishedAt).toBeNull();
      expect(saved.result).toHaveProperty("observation.reason", "receipt_delivery");
      expect(remote.counts().mutations).toBe(1);
    },
  );
  it("renewal: ambiguous committed allocation sends no POST and recovery remains lookup-only", async () => {
    const job = await seed("test.renewal.ambiguous"),
      holders = await checkpointContexts(job),
      remote = successfulClient();
    const transaction = state.db.transaction.bind(state.db);
    vi.spyOn(state.db, "transaction").mockImplementationOnce(async (fn) => {
      await transaction(fn);
      throw Error("lost commit response");
    });
    await expect(
      executeAdminJobOperation(
        required(holders.contexts[0]),
        { kind: "backup.delete", backupId: "original" },
        "test",
        { operationKey: "opk1_ambiguousaddress", client: remote.client },
      ),
    ).rejects.toThrow();
    expect(
      Object.keys(checkedCheckpoint((await row(job.id)).result).opsProjection.steps),
    ).toHaveLength(1);
    const fresh = (await row(job.id)).result;
    required(holders.contexts[1]).checkpointResult = fresh as Record<string, unknown>;
    await expect(
      executeAdminJobOperation(
        required(holders.contexts[1]),
        { kind: "backup.delete", backupId: "changed" },
        "test",
        { operationKey: "opk1_ambiguousaddress", client: remote.client, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow();
    expect(remote.counts().mutations).toBe(0);
    await holders.finish();
  });
  it("renewal: distinct stable addresses merge into the current row without erasing sibling receipts", async () => {
    const job = await seedCapacity(1),
      holders = await checkpointContexts(job),
      remote = successfulClient();
    await Promise.allSettled(
      holders.contexts.map((ctx, n) =>
        executeAdminJobOperation(ctx, { kind: "backup.delete", backupId: `new-${n}` }, "test", {
          operationKey: `opk1_distinctaddress${n}`,
          client: remote.client,
          pollIntervalMs: 1,
        }),
      ),
    );
    const saved = checkedCheckpoint((await row(job.id)).result);
    expect(Object.keys(saved.opsProjection.steps)).toHaveLength(3);
    expect(Object.keys(saved.opsProjection.operations)).toHaveLength(3);
    expect(saved.untouched).toEqual({ receipt: "preserve" });
    expect(saved.opsProjection.eventTotal).toBe(7);
    expect(remote.counts().mutations).toBe(2);
    await holders.finish();
  });
  it("renewal: two distinct allocators at63 share one last slot, never persist65, and preserve all receipts", async () => {
    const job = await seedCapacity(63),
      holders = await checkpointContexts(job),
      remote = successfulClient();
    const results = await Promise.allSettled(
      holders.contexts.map((ctx, n) =>
        executeAdminJobOperation(ctx, { kind: "backup.delete", backupId: `last-${n}` }, "test", {
          operationKey: `opk1_lastslotaddress${n}`,
          client: remote.client,
          pollIntervalMs: 1,
        }),
      ),
    );
    expect(
      results.filter(
        (r) =>
          r.status === "rejected" &&
          (r.reason as Error).constructor.name === "JobStepCapacityExceeded",
      ),
    ).toHaveLength(1);
    const saved = checkedCheckpoint((await row(job.id)).result);
    expect(Object.keys(saved.opsProjection.steps)).toHaveLength(64);
    expect(Object.keys(saved.opsProjection.operations)).toHaveLength(64);
    expect(remote.counts().mutations).toBe(1);
    for (const [key, value] of Object.entries(
      checkedCheckpoint(job.result).opsProjection.operations,
    ))
      expect(saved.opsProjection.operations[key]).toEqual(value);
    await holders.finish();
  });
  it("renewal: full mixed legacy/v3 rows refuse a missing address but observe an existing winner at capacity", async () => {
    const job = await seedCapacity(64, true),
      holders = await checkpointContexts(job, 1),
      remote = successfulClient(),
      ctx = required(holders.contexts[0]);
    const before = structuredClone((await row(job.id)).result);
    await expect(
      executeAdminJobOperation(ctx, { kind: "backup.delete", backupId: "refused" }, "test", {
        operationKey: "opk1_missingfulladdress",
        client: remote.client,
      }),
    ).rejects.toBeInstanceOf((await import("../admin-job-state")).JobStepCapacityExceeded);
    const address = required(Object.keys(checkedCheckpoint(job.result).opsProjection.steps)[0]);
    await expect(
      executeAdminJobOperation(ctx, { kind: "backup.delete", backupId: "changed" }, "test", {
        operationKey: address,
        client: remote.client,
      }),
    ).resolves.toMatchObject({ backupId: expect.stringMatching(/^old-/) });
    expect((await row(job.id)).result).toEqual(before);
    expect(remote.counts().mutations).toBe(0);
    await holders.finish();
  });
});
