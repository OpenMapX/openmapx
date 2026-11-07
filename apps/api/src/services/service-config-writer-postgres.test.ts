import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceConfig } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

type Fixture = Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
const connection = vi.hoisted(() => ({ db: null as unknown as Fixture["db"] }));
// Only substitute the connection; production Drizzle SQL and locks are real.
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
  "service config atomic merge in PostgreSQL",
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

    it("merges against locked current state after an ordinary writer", async () => {
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
        second = writer.mergeServiceConfig("alpha", { partial: 3 });
        void second.catch(() => {});
        await blocked(pid);
        held.resume.resolve();
        await first;
        await second;
        expect((await rows())[0].config).toEqual({ base: 1, concurrent: 2, partial: 3 });
      } finally {
        held.resume.resolve();
        await Promise.allSettled([first, second]);
      }
    });
  },
);
