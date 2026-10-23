import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
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
const { executeAdminJobOperation } = await import("../admin-job-ops");
const { jobEventBus } = await import("../job-events");
const { OpsClientError } = await import("@openmapx/core/ops");
const { adminJob, adminJobLog } = schema;
const runner = jobRunner as unknown as {
  executeJob(...args: unknown[]): Promise<void>;
  launchJob(...args: unknown[]): Promise<void>;
};

// Explicit opt-in connection supplied only after the task launcher verifies the
// synthetic container's exact ID/owner. No migrations or table-wide cleanup.
describe.skipIf(!process.env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL)(
  "admin job PostgreSQL ownership/recovery",
  () => {
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
      expect(
        await state.db.select().from(adminJobLog).where(eq(adminJobLog.jobId, job.id)),
      ).toEqual([]);
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
      expect(
        await state.db.select().from(adminJobLog).where(eq(adminJobLog.jobId, job.id)),
      ).toEqual([]);
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
        const terminal = {
          version: 1,
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
        const execute = vi.fn().mockResolvedValue({
          execution: "async",
          kind: "backup.delete",
          operationId: opId,
          operationKey: key,
          state: "queued",
        });
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
        expect(execute).toHaveBeenCalledTimes(1);
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
  },
);
