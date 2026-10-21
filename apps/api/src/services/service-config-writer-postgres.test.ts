import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceConfig } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

type Fixture = Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
const connection = vi.hoisted(() => ({ db: null as unknown as Fixture["db"] }));
// Only substitute the connection; production Drizzle SQL, locks and versions are real.
vi.mock("../db/index.js", () => ({
  get db() {
    return connection.db;
  },
}));
const writer = await import("./service-config-writer");

function barrier() {
  return { entered: Promise.withResolvers<number>(), resume: Promise.withResolvers<void>() };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PostgreSQL barrier timed out")), 8_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "service config ownership in PostgreSQL",
  () => {
    let fixture: Fixture;
    let nextCommit: ReturnType<typeof barrier> | undefined;
    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      connection.db = fixture.db;
    }, 120_000);
    afterAll(async () => {
      await fixture?.stop();
    });
    beforeEach(async () => {
      nextCommit = undefined;
      await fixture.db.delete(serviceConfig);
      const transaction = fixture.db.transaction.bind(fixture.db);
      vi.spyOn(fixture.db, "transaction").mockImplementation((run, config) =>
        transaction(async (tx) => {
          const hold = nextCommit;
          nextCommit = undefined;
          await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);
          await tx.execute(sql`SET LOCAL lock_timeout = '6s'`);
          const result = await run(tx);
          if (hold) {
            const [backend] = await tx.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            );
            hold.entered.resolve(backend.pid);
            await bounded(hold.resume.promise);
          }
          return result;
        }, config),
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const seed = (config: Record<string, unknown>) =>
      fixture.db.insert(serviceConfig).values({ id: randomUUID(), serviceId: "alpha", config });
    const rows = () =>
      fixture.db
        .select({
          id: serviceConfig.id,
          config: serviceConfig.config,
          version: sql<string>`xmin::text`,
        })
        .from(serviceConfig);
    async function blocked(holder: number) {
      await vi.waitFor(
        async () => {
          const waiting = await fixture.sql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND ${holder} = ANY(pg_blocking_pids(pid))`;
          expect(waiting).toHaveLength(1);
        },
        { timeout: 3_000, interval: 10 },
      );
    }

    it.each([false, true])(
      "restores only its written version (prior row %s) after commit",
      async (existing) => {
        if (existing) await seed({ before: true, kept: 1 });
        const before = await rows();
        const saved = await writer.persistServiceConfigPatch("alpha", { changed: true });
        expect(Object.keys(saved)).toEqual(["restore"]);
        const [owned] = await rows(); // Visible through another committed connection before host work.
        expect(owned.config).toEqual(
          existing ? { before: true, kept: 1, changed: true } : { changed: true },
        );
        expect(await saved.restore()).toBe(true);
        expect((await rows()).map((row) => row.config)).toEqual(before.map((row) => row.config));
        if (existing) expect((await rows())[0].id).toBe(before[0].id);
        expect(await saved.restore()).toBe(false); // A handle never owns the inverse's new tuple.
      },
    );

    it.each([false, true])("preserves a late ordinary merge (prior row %s)", async (existing) => {
      if (existing) await seed({ before: true });
      const saved = await writer.persistServiceConfigPatch("alpha", { value: "request" });
      await writer.mergeServiceConfig("alpha", { value: "later", independent: 2 });
      const after = await rows();
      expect(await saved.restore()).toBe(false);
      expect(await rows()).toEqual(after);
      expect(after[0].config).toMatchObject({ value: "later", independent: 2 });
    });

    it.each([false, true])(
      "rejects equal-value rewrites and delete/reinsert (prior row %s)",
      async (existing) => {
        if (existing) await seed({ before: true });
        const saved = await writer.persistServiceConfigPatch("alpha", { value: "same" });
        const [owned] = await rows();
        await fixture.sql`UPDATE service_config SET config = config WHERE service_id = 'alpha'`;
        const [rewritten] = await rows();
        expect(rewritten.id).toBe(owned.id);
        expect(rewritten.version).not.toBe(owned.version);
        expect(await saved.restore()).toBe(false);
        expect(await rows()).toEqual([rewritten]);
        const next = await writer.persistServiceConfigPatch("alpha", {});
        await fixture.sql.begin(async (tx) => {
          await tx`DELETE FROM service_config WHERE service_id = 'alpha'`;
          await tx`INSERT INTO service_config (id, service_id, config) VALUES (${randomUUID()}, 'alpha', ${JSON.stringify(rewritten.config)}::jsonb)`;
        });
        const [replacement] = await rows();
        expect(replacement.id).not.toBe(owned.id);
        expect(await next.restore()).toBe(false);
        expect(await rows()).toEqual([replacement]);
      },
    );

    it.each([false, true])(
      "rechecks inverse predicate in the writing statement after a lock wait (prior row %s)",
      async (existing) => {
        if (existing) await seed({ before: true });
        const saved = await writer.persistServiceConfigPatch("alpha", { value: "request" });
        const held = barrier();
        nextCommit = held;
        const competing = fixture.db.transaction(async (tx) => {
          await tx
            .update(serviceConfig)
            .set({ config: { value: "competitor" } })
            .where(eq(serviceConfig.serviceId, "alpha"));
        });
        void competing.catch(() => {});
        let restoring: Promise<boolean> | undefined;
        try {
          const pid = await bounded(held.entered.promise);
          restoring = saved.restore();
          void restoring.catch(() => {});
          await blocked(pid); // Restore has reached its actual conditional UPDATE/DELETE.
          held.resume.resolve();
          await competing;
          expect(await restoring).toBe(false);
          expect((await rows())[0].config).toEqual({ value: "competitor" });
        } finally {
          held.resume.resolve();
          await Promise.allSettled([competing, restoring]);
        }
      },
    );

    it.each(["ordinary", "guarded"])(
      "merges against locked current state after a %s writer",
      async (mode) => {
        await seed({ base: 1 });
        const held = barrier();
        nextCommit = held;
        const first = fixture.db.transaction(async (tx) => {
          await tx
            .update(serviceConfig)
            .set({ config: { base: 1, concurrent: 2 } })
            .where(eq(serviceConfig.serviceId, "alpha"));
        });
        void first.catch(() => {});
        let second: Promise<unknown> | undefined;
        try {
          const pid = await bounded(held.entered.promise);
          second =
            mode === "ordinary"
              ? writer.mergeServiceConfig("alpha", { partial: 3 })
              : writer.persistServiceConfigPatch("alpha", { partial: 3 });
          void second.catch(() => {});
          await blocked(pid);
          held.resume.resolve();
          await first;
          const saved = await second;
          expect((await rows())[0].config).toEqual({ base: 1, concurrent: 2, partial: 3 });
          if (mode === "guarded") {
            expect(await (saved as { restore(): Promise<boolean> }).restore()).toBe(true);
            expect((await rows())[0].config).toEqual({ base: 1, concurrent: 2 });
          }
        } finally {
          held.resume.resolve();
          await Promise.allSettled([first, second]);
        }
      },
    );

    it("fails an absent-row insertion conflict without damaging the contender", async () => {
      const held = barrier();
      nextCommit = held;
      const winner = writer.persistServiceConfigPatch("alpha", { winner: true });
      void winner.catch(() => {});
      let loser: ReturnType<typeof writer.persistServiceConfigPatch> | undefined;
      try {
        const pid = await bounded(held.entered.promise);
        loser = writer.persistServiceConfigPatch("alpha", { loser: true });
        void loser.catch(() => {});
        await blocked(pid);
        held.resume.resolve();
        const saved = await winner;
        await expect(loser).rejects.toThrow();
        expect((await rows())[0].config).toEqual({ winner: true });
        expect(await saved.restore()).toBe(true);
        expect(await rows()).toEqual([]);
      } finally {
        held.resume.resolve();
        await Promise.allSettled([winner, loser]);
      }
    });
  },
);
