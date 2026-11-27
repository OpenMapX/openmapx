import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as Awaited<ReturnType<typeof createMigratedPostgresFixture>> | null,
}));

vi.mock("../db", () => ({
  get db() {
    if (!state.fixture) throw Error("Owned database not installed");
    return state.fixture.db;
  },
}));

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "integration task runs in PostgreSQL",
  () => {
    let runs: typeof import("../services/integration-task-runs");
    let activity: typeof import("../services/activity-jobs");

    beforeAll(async () => {
      state.fixture = await createMigratedPostgresFixture();
      runs = await import("../services/integration-task-runs");
      activity = await import("../services/activity-jobs");
    }, 120_000);

    afterAll(async () => {
      await state.fixture?.stop();
      state.fixture = null;
    });

    const sql = () => {
      if (!state.fixture) throw Error("Owned database not installed");
      return state.fixture.sql;
    };

    beforeEach(async () => {
      await sql()`delete from integration_task_run`;
    });

    async function row(id: string) {
      const [found] = await sql()<
        Array<{ status: string; error: string | null; finished: boolean }>
      >`select status, error, finished_at is not null as finished
        from integration_task_run where id = ${id}`;
      return found;
    }

    it("marks runs left running by a previous process as failed", async () => {
      const store = runs.createTaskRunStore();
      const id = await store.start("demo", "t");
      if (!id) throw Error("No run started");
      const finished = await store.start("demo", "done");
      if (!finished) throw Error("No run started");
      await store.finish(finished, "succeeded");
      expect(await store.failInterrupted()).toBe(1);
      expect(await row(id)).toMatchObject({
        status: "failed",
        error: "interrupted by restart",
        finished: true,
      });
      expect(await row(finished)).toMatchObject({
        status: "succeeded",
        error: null,
        finished: true,
      });
    });

    it("lets only one process hold a running row per task", async () => {
      const store = runs.createTaskRunStore();
      const first = await store.start("demo", "t");
      expect(first).toEqual(expect.any(String));
      expect(await store.start("demo", "t")).toBeNull();
      expect(await store.start("other", "t")).toEqual(expect.any(String));
      await store.finish(first as string, "failed", "deadline exceeded");
      expect(await row(first as string)).toMatchObject({
        status: "failed",
        error: "deadline exceeded",
        finished: true,
      });
      expect(await store.start("demo", "t")).toEqual(expect.any(String));
    });

    it("prunes finished runs started more than 30 days ago and keeps running ones", async () => {
      const [oldFinished, oldRunning, recent] = await sql()<Array<{ id: string }>>`
        insert into integration_task_run (integration_id, task_name, status, started_at, finished_at)
        values
          ('demo', 'a', 'succeeded', now() - interval '40 days', now() - interval '40 days'),
          ('demo', 'b', 'running', now() - interval '40 days', null),
          ('demo', 'c', 'failed', now() - interval '10 days', now() - interval '10 days')
        returning id`;
      expect(await runs.pruneIntegrationTaskRuns()).toBe(1);
      const left = await sql()<Array<{ id: string }>>`select id from integration_task_run`;
      expect(left.map(({ id }) => id).sort()).toEqual([oldRunning?.id, recent?.id].sort());
      expect(left.map(({ id }) => id)).not.toContain(oldFinished?.id);
    });

    it("refuses a status change that leaves finished_at unset", async () => {
      const id = await runs.createTaskRunStore().start("demo", "t");
      await expect(
        sql()`update integration_task_run set status = 'failed' where id = ${id as string}`,
      ).rejects.toMatchObject({ constraint_name: "integration_task_run_finished_at_check" });
    });

    it("lists an integration task run and opens its detail", async () => {
      const store = runs.createTaskRunStore();
      const running = (await store.start("demo", "refresh")) as string;
      const succeeded = (await store.start("demo", "sync")) as string;
      await store.finish(succeeded, "succeeded");
      const failed = (await store.start("demo", "prune")) as string;
      await store.finish(failed, "failed", "deadline exceeded");

      const listed = await activity.listActivityJobs({ limit: 50, offset: 0 });
      expect(listed.total).toBe(3);
      expect(listed.jobs.find((job) => job.id === running)).toMatchObject({
        source: "integration-task",
        type: "demo:refresh",
        status: "running",
        cancelable: false,
        actor: null,
        createdBy: null,
        actorLabel: "Scheduled",
        error: null,
        finishedAt: null,
      });
      expect(listed.jobs.find((job) => job.id === succeeded)).toMatchObject({
        status: "completed",
        finishedAt: expect.any(Date),
      });
      expect(listed.jobs.find((job) => job.id === failed)).toMatchObject({
        status: "failed",
        error: "deadline exceeded",
      });

      for (const [filter, id] of [
        ["active", running],
        ["completed", succeeded],
        ["failed", failed],
      ] as const) {
        const filtered = await activity.listActivityJobs({ filter, limit: 50, offset: 0 });
        expect(filtered.jobs.map((job) => job.id)).toEqual([id]);
        expect(filtered.total).toBe(1);
      }

      expect(await activity.getActivityJob(failed, "integration-task")).toMatchObject({
        source: "integration-task",
        id: failed,
        type: "demo:prune",
        status: "failed",
        error: "deadline exceeded",
        cancelable: false,
        createdBy: null,
        logs: [],
        stages: [],
      });
      expect(
        await activity.getActivityJob("0193e4a0-0000-7000-8001-000000000001", "integration-task"),
      ).toBeNull();
    });
  },
);
