import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, expect, it, vi } from "vitest";
import { AdminJobFailure } from "../admin-job-failure";
import { claimAdminJob, jobOwnership } from "../admin-job-state";
import { jobEventBus } from "../job-events";
import { OpsObservationPending } from "../ops-client";

const store = vi.hoisted(() => ({
  writes: [] as Array<{ values: Record<string, unknown>; where: unknown }>,
  accept: true,
  status: "running",
  rows: [] as unknown[],
}));
vi.mock("../../db", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          store.writes.push({ values, where });
          const result = store.accept
            ? [{ id: "1d2b29cd-23de-4b19-8c32-86c196833b79", status: store.status }]
            : [];
          return Object.assign(Promise.resolve(result), { returning: async () => result });
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => store.rows,
          orderBy: () => ({ limit: async () => store.rows }),
        }),
      }),
    }),
  },
}));
const { jobRunner } = await import("../job-runner");
const jobId = "1d2b29cd-23de-4b19-8c32-86c196833b79";
const execution = { owner: "4c0c9623-252c-41b6-8f99-41915ad38b12", version: 4 };
const run = (type: string, result: Record<string, unknown> = {}) =>
  (jobRunner as unknown as { executeJob(...args: unknown[]): Promise<void> }).executeJob(
    jobId,
    type,
    {},
    { ...result, _execution: execution },
    new AbortController().signal,
  );
beforeEach(() => {
  store.writes.length = 0;
  store.accept = true;
  store.status = "running";
  store.rows = [];
});

it("merges AdminJobFailure evidence into DB/SSE without publishing ownership or admission proofs", async () => {
  const result = {
    serviceBatch: {
      outcome: "partial",
      completedServiceIds: ["tileserver"],
      failedServiceIds: ["valhalla"],
      skippedServiceIds: [],
    },
  };
  const events: unknown[] = [];
  const unsubscribe = jobEventBus.subscribe(jobId, ({ event }) => events.push(event));
  jobRunner.register("test.evidence", async () => {
    throw new AdminJobFailure("Build failed", await Promise.resolve(result));
  });
  await run("test.evidence", { phase: "build", opsProjection: { private: "proof" } });
  unsubscribe();
  expect(store.writes.at(-1)?.values).toMatchObject({
    status: "failed",
    result: { phase: "build", _execution: execution, ...result },
  });
  expect(events.at(-1)).toMatchObject({
    type: "status",
    status: "failed",
    result: { phase: "build", ...result },
  });
  expect(JSON.stringify(events)).not.toContain("_execution");
  expect(JSON.stringify(events)).not.toContain("proof");
});

it("publishes unknown observation without a terminal event and retains the original identity", async () => {
  const identity = {
    kind: "service.build" as const,
    operationKey: "opk1_abcdefghijklmnop",
    operationId: "job1_abcdefghijklmnop",
  };
  jobRunner.register("test.unknown", async () => {
    throw new OpsObservationPending(identity, "transport");
  });
  const events: Array<{ status?: string }> = [];
  const stop = jobEventBus.subscribe(jobId, ({ event }) => {
    if (event.type === "status") events.push(event);
  });
  await run("test.unknown", { receipt: identity });
  stop();
  const patch = new PgDialect().sqlToQuery(store.writes.at(-1)?.values.result as SQL);
  expect(JSON.parse(patch.params[0] as string)).toMatchObject({
    observation: { state: "unknown", reason: "transport", nextCheckAt: expect.any(String) },
  });
  expect(patch.sql).toContain("coalesce(");
  expect(
    events.some((event) => ["success", "failed", "canceled"].includes(event.status ?? "")),
  ).toBe(false);
});

it("does not announce an old owner's completion when PostgreSQL rejects its CAS", async () => {
  store.accept = false;
  jobRunner.register("test.stale", async () => ({ completed: true }));
  const events: Array<{ status?: string }> = [];
  const stop = jobEventBus.subscribe(jobId, ({ event }) => {
    if (event.type === "status") events.push(event);
  });
  await run("test.stale");
  stop();
  expect(events.some((event) => event.status === "success")).toBe(false);
  const late = new PgDialect().sqlToQuery(store.writes.at(-1)?.values.result as SQL);
  expect(JSON.parse(late.params[0] as string)).toEqual({
    _settled: { status: "success", result: { completed: true } },
  });
  for (const write of store.writes) {
    const query = new PgDialect().sqlToQuery(write.where as SQL);
    expect(query.sql).toContain("->'_execution'");
    expect(query.params).toContain(JSON.stringify(execution));
    expect(query.params).toContain(jobId);
  }
  expect(new PgDialect().sqlToQuery(store.writes.at(-1)?.where as SQL).params).toContain(
    "cancel_pending",
  );
});

it("rejects stale checkpoint writes before another child can be admitted", async () => {
  store.accept = false;
  const effect = vi.fn();
  jobRunner.register("test.checkpoint", async (ctx) => {
    await ctx.checkpoint({ _execution: { owner: "forged", version: 999 }, prepared: true });
    effect();
    return {};
  });
  await run("test.checkpoint");
  expect(effect).not.toHaveBeenCalled();
  expect(store.writes[0]?.values.result).toMatchObject({ _execution: execution });
});

it("changes owner and version together while retaining the complete result in PostgreSQL", async () => {
  await claimAdminJob({ id: jobId, status: "running", result: { _execution: execution } });
  const write = store.writes[0];
  if (!write) throw new Error("Missing claim");
  const assignment = new PgDialect().sqlToQuery(write.values.result as SQL);
  const next = JSON.parse(assignment.params[0] as string)._execution;
  expect(next.owner).not.toBe(execution.owner);
  expect(next.version).toBe(5);
  expect(assignment.sql).toContain("coalesce(");
  expect(assignment.sql).toContain("||");
  const where = new PgDialect().sqlToQuery(jobOwnership(jobId, execution) as SQL);
  expect(where.params).toEqual([jobId, "running", JSON.stringify(execution)]);
  await expect(jobRunner.reconcile({ limit: 33 })).rejects.toThrow("Invalid reconciliation limit");
});

it("CAS binds a fresh child attempt to an absent key and the retained parent before signing", async () => {
  const key = "opk1_abcdefghijklmnop";
  jobRunner.register("test.child-intent", async (ctx) => {
    await ctx.checkpoint(
      {
        _parentExecution: { operationKey: "opk1_parentidentity1234" },
        opsProjection: { operations: { [key]: { phase: "admitting" } } },
      },
      undefined,
      key,
    );
    return {};
  });
  await run("test.child-intent");
  const query = new PgDialect().sqlToQuery(store.writes[0]?.where as SQL);
  expect(query.sql).toContain("->'opsProjection'->'operations'->");
  expect(query.sql).toContain("IS NULL");
  expect(query.sql).toContain("->'_parentExecution'");
  expect(query.params).toContain(key);
  expect(query.params).toContain(JSON.stringify(execution));
});
