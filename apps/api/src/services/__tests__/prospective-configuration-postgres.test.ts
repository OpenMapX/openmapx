import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import { createConfigurationPostgresFixture } from "../../test/configuration-postgres-fixture";
import type { JobContext } from "../job-runner";

type Fixture = Awaited<ReturnType<typeof createConfigurationPostgresFixture>>;
const connection = vi.hoisted(() => ({ fixture: null as unknown as Fixture }));
vi.mock("../../db", () => ({
  get db() {
    return connection.fixture.db;
  },
  get sql() {
    return connection.fixture.sql;
  },
}));
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../service-registry", () => ({ getServiceRegistry: () => ({ list: () => [] }) }));
const subject = await import("../administrative-configuration-writer");

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "prospective configuration dedicated PostgreSQL writer",
  () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await createConfigurationPostgresFixture();
      connection.fixture = fixture;
    });
    afterAll(async () => {
      await fixture?.stop();
    });
    async function job(): Promise<JobContext> {
      const jobId = randomUUID(),
        execution = { owner: randomUUID(), version: 1 };
      await fixture.db.insert(schema.adminJob).values({
        id: jobId,
        type: "compose.render",
        status: "running",
        result: { _execution: execution },
      });
      const ctx: JobContext = {
        jobId,
        jobType: "compose.render",
        execution,
        payload: {},
        signal: new AbortController().signal,
        checkpointResult: { _execution: execution },
        log: async () => {},
        setProgress: async () => {},
        checkpoint: async (result) => {
          await fixture.db
            .update(schema.adminJob)
            .set({ result })
            .where(eq(schema.adminJob.id, jobId));
          ctx.checkpointResult = result;
        },
      };
      return ctx;
    }
    function writer<T>(
      ctx: JobContext,
      ids: string[],
      run: Parameters<typeof subject.withAdministrativeConfigurationWriter<T>>[1],
    ) {
      return subject.withAdministrativeConfigurationJob(ctx, () =>
        subject.withAdministrativeConfigurationWriter(
          {
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            integrationIds: ids,
          },
          run,
        ),
      );
    }

    it("serializes two real connections with inverse caller integration order and reuses nested ownership", async () => {
      const first = await job(),
        second = await job();
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const order: string[] = [],
        pids: number[] = [];
      const a = writer(first, ["zeta", "alpha"], async (owned) => {
        expect(owned.integrationIds).toEqual(["alpha", "zeta"]);
        const state = subject.administrativeConfigurationState(owned);
        pids.push(
          (await state.connection.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!
            .pid,
        );
        await subject.withAdministrativeConfigurationWriter(
          { actorId: first.jobId, operationKey: owned.operationKey, integrationIds: ["alpha"] },
          async (nested) => {
            expect(nested).toBe(owned);
          },
        );
        order.push("first");
        entered.resolve();
        await release.promise;
      });
      void a.catch(entered.reject);
      await entered.promise;
      const b = writer(second, ["alpha", "zeta"], async (owned) => {
        const state = subject.administrativeConfigurationState(owned);
        pids.push(
          (await state.connection.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!
            .pid,
        );
        order.push("second");
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual(["first"]);
      release.resolve();
      await Promise.all([a, b]);
      expect(order).toEqual(["first", "second"]);
      expect(new Set(pids).size).toBe(2);
    });

    it("rolls back desired writes on the same dedicated connection and proves rollback before classifying it", async () => {
      const ctx = await job();
      await writer(ctx, [], async (owned) => {
        const state = subject.administrativeConfigurationState(owned);
        const [owner] = await state.connection.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        await expect(
          subject.withConfigurationWriteTransaction(owned, async (tx) => {
            const [actual] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
            expect(actual!.pid).toBe(owner!.pid);
            await tx
              .insert(schema.serviceConfig)
              .values({ id: randomUUID(), serviceId: "rollback-fixture", config: { WORKERS: 4 } });
            throw Error("synthetic failure after desired write");
          }),
        ).rejects.toBeInstanceOf(subject.ConfigurationWriteRolledBack);
      });
      expect(await fixture.db.select().from(schema.serviceConfig)).toEqual([]);
    });

    it("rejects a nested transaction before it can commit the outer writer's desired row", async () => {
      const ctx = await job();
      let nestedEntered = false;
      await writer(ctx, [], async (owned) => {
        await expect(
          subject.withConfigurationWriteTransaction(owned, async (tx) => {
            await tx.insert(schema.serviceConfig).values({
              id: randomUUID(),
              serviceId: "nested-rollback-fixture",
              config: { WORKERS: 7 },
            });
            await expect(
              subject.withConfigurationWriteTransaction(owned, async () => {
                nestedEntered = true;
              }),
            ).rejects.toThrow("Configuration transaction already active");
            throw Error("synthetic outer rollback after refused nested transaction");
          }),
        ).rejects.toBeInstanceOf(subject.ConfigurationWriteRolledBack);
      });
      expect(await fixture.db.select().from(schema.serviceConfig)).toEqual([]);
      expect(nestedEntered).toBe(false);
    });

    it("refuses expansion, conflicting job identity, foreign participant and expired writer", async () => {
      const ctx = await job();
      let expired: Parameters<typeof subject.administrativeConfigurationState>[0] | undefined;
      await writer(ctx, ["alpha"], async (owned) => {
        expired = owned;
        await expect(
          subject.withAdministrativeConfigurationWriter(
            { actorId: ctx.jobId, operationKey: owned.operationKey, integrationIds: ["beta"] },
            async () => {},
          ),
        ).rejects.toThrow();
        await expect(
          subject.withAdministrativeConfigurationWriter(
            { actorId: randomUUID(), operationKey: owned.operationKey, integrationIds: [] },
            async () => {},
          ),
        ).rejects.toThrow();
        await expect(
          subject.withConfigurationCommitParticipant(
            owned,
            {
              kind: "configuration-migration",
              mode: "preview",
              actorId: ctx.jobId,
              operationKey: owned.operationKey,
            } as never,
            async () => {},
          ),
        ).rejects.toThrow();
      });
      expect(() => subject.administrativeConfigurationState(expired!)).toThrow();
    });

    it("retains a durable unresolved candidate fence after the physical session lock releases", async () => {
      const first = await job(),
        second = await job();
      await writer(first, [], async (owned) => {
        await first.checkpoint({
          ...first.checkpointResult,
          _configurationCandidate: { operationKey: owned.operationKey, phase: "save_attempted" },
        });
      });
      await expect(writer(second, [], async () => {})).rejects.toThrow(
        "Configuration writer unavailable",
      );
      await first.checkpoint({
        ...first.checkpointResult,
        _configurationCandidate: {
          operationKey: `opk1_${first.jobId.replaceAll("-", "")}`,
          phase: "settled",
        },
      });
      await expect(writer(second, [], async () => "allowed")).resolves.toBe("allowed");
    });
  },
);
