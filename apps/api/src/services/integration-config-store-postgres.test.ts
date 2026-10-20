import { randomUUID } from "node:crypto";
import type { AdminIntegrationConfigEntry } from "@openmapx/core/api-contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { integrationConfig } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

type Fixture = Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
const connection = vi.hoisted(() => ({ db: null as unknown as Fixture["db"] }));
// Redirect only the connection: every select, lock, tuple version and mutation
// below is production Drizzle SQL against the disposable migrated PostgreSQL 18.
vi.mock("../db", () => ({
  get db() {
    return connection.db;
  },
}));
const { persistIntegrationImport, persistIntegrationConfigPatch } = await import(
  "./integration-config-store"
);

function barrier() {
  return { entered: Promise.withResolvers<number>(), resume: Promise.withResolvers<void>() };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("PostgreSQL barrier timed out")), 8_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// xmin is a request-local tuple token, never a durable revision. See PostgreSQL
// 18 ddl-system-columns, explicit-locking and transaction-iso documentation.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "integration configuration ownership in PostgreSQL",
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
      await fixture.db.delete(integrationConfig);
      const transaction = fixture.db.transaction.bind(fixture.db);
      // Instrument only the pre-commit boundary. Do not simulate transactions,
      // SQL results or locks; hold the actual production transaction open.
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

    const seed = (integrationId: string, config: Record<string, unknown>) =>
      fixture.db.insert(integrationConfig).values({ id: randomUUID(), integrationId, config });
    const rows = () =>
      fixture.db
        .select({
          id: integrationConfig.id,
          integrationId: integrationConfig.integrationId,
          config: integrationConfig.config,
          version: sql<string>`xmin::text`,
        })
        .from(integrationConfig)
        .orderBy(integrationConfig.integrationId);
    const waitForBlockedWriter = async (holder: number) => {
      await vi.waitFor(
        async () => {
          const waiting = await fixture.sql`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND ${holder} = ANY(pg_blocking_pids(pid))`;
          expect(waiting).toHaveLength(1);
        },
        { timeout: 3_000, interval: 10 },
      );
    };

    it("replaces only named overrides, preserves omitted enabled, and owns the inverse of existing and inserted rows", async () => {
      await seed("alpha", { old: "before", enabled: false });
      await seed("unnamed", { untouched: true });
      const before = await rows();
      const saved = await persistIntegrationImport([
        { integrationId: "alpha", config: { label: "imported" } },
        { integrationId: "beta", config: {} },
      ]);
      expect(saved.previous).toEqual([
        { integrationId: "alpha", config: { old: "before", enabled: false } },
        { integrationId: "beta", config: null },
      ]);
      const imported = await rows();
      expect(imported.map((row) => row.config)).toEqual([
        { label: "imported", enabled: false },
        {},
        { untouched: true },
      ]);
      expect(imported[0].version).not.toBe(before[0].version);
      expect(imported[2]).toEqual(before[1]);
      expect(await saved.owns()).toBe(true);
      expect(await saved.restore()).toBe(true);
      expect(await saved.owns()).toBe(true);
      const restored = await rows();
      expect(restored.map((row) => row.config)).toEqual(before.map((row) => row.config));
      expect(restored[0].id).toBe(before[0].id);
      expect(restored[0].version).not.toBe(imported[0].version);
      expect(restored[1]).toEqual(before[1]);
      await seed("beta", {});
      expect(await saved.owns()).toBe(false);
    });

    it.each<AdminIntegrationConfigEntry["config"]>([
      { label: "ordinary" },
      { enabled: true },
      { enabled: false },
    ])("merges partial intent %j only after waiting for the import's row lock", async (patch) => {
      await seed("alpha", { stale: "remove", enabled: false });
      const held = barrier();
      nextCommit = held;
      const importing = persistIntegrationImport([
        { integrationId: "alpha", config: { label: "imported", nested: { count: 2 } } },
      ]);
      void importing.catch(() => {});
      let editing: ReturnType<typeof persistIntegrationConfigPatch> | undefined;
      try {
        const pid = await bounded(held.entered.promise);
        editing = persistIntegrationConfigPatch({ integrationId: "alpha", config: patch });
        void editing.catch(() => {});
        await waitForBlockedWriter(pid);
        held.resume.resolve();
        const imported = await importing;
        const edited = await editing;
        expect((await rows())[0].config).toEqual({
          label: "imported",
          nested: { count: 2 },
          enabled: false,
          ...patch,
        });
        expect(edited.previous).toEqual([
          {
            integrationId: "alpha",
            config: { label: "imported", nested: { count: 2 }, enabled: false },
          },
        ]);
        expect(await imported.owns()).toBe(false);
        expect(await edited.restore()).toBe(true);
        expect(await edited.owns()).toBe(true);
        expect((await rows())[0].config).toEqual({
          label: "imported",
          nested: { count: 2 },
          enabled: false,
        });
      } finally {
        held.resume.resolve();
        await Promise.allSettled([importing, editing]);
      }
    });

    it.each(["equal-value update", "delete/reinsert"])(
      "loses actual tuple ownership after external %s and preserves the replacement",
      async (mutation) => {
        const saved = await persistIntegrationImport([
          { integrationId: "alpha", config: { label: "same" } },
        ]);
        const [owned] = await rows();
        if (mutation === "equal-value update") {
          await fixture.sql`UPDATE integration_config SET config = config WHERE integration_id = 'alpha'`;
        } else {
          await fixture.sql.begin(async (tx) => {
            await tx`DELETE FROM integration_config WHERE integration_id = 'alpha'`;
            await tx`INSERT INTO integration_config (id, integration_id, config)
              VALUES (${randomUUID()}, 'alpha', '{"label":"same"}'::jsonb)`;
          });
        }
        const [replacement] = await rows();
        expect(replacement.config).toEqual(owned.config);
        expect(replacement.version).not.toBe(owned.version);
        expect(replacement.id === owned.id).toBe(mutation === "equal-value update");
        expect(await saved.owns()).toBe(false);
        expect(await saved.restore()).toBe(false);
        expect(await rows()).toEqual([replacement]);
      },
    );

    it("rolls back the earlier inverse write when a later row conflicts after a lock wait", async () => {
      await seed("alpha", { label: "old-a" });
      await seed("zeta", { label: "old-z" });
      const saved = await persistIntegrationImport([
        { integrationId: "zeta", config: { label: "new-z" } },
        { integrationId: "alpha", config: { label: "new-a" } },
      ]);
      const [alpha] = await rows();
      const held = barrier();
      nextCommit = held;
      const competing = fixture.db.transaction(async (tx) => {
        await tx
          .update(integrationConfig)
          .set({ config: { label: "competitor" } })
          .where(eq(integrationConfig.integrationId, "zeta"));
      });
      void competing.catch(() => {});
      let restoring: Promise<boolean> | undefined;
      try {
        const pid = await bounded(held.entered.promise);
        restoring = saved.restore();
        void restoring.catch(() => {});
        await waitForBlockedWriter(pid);
        // The later zeta conflict must occur after this transaction has already
        // locked/written alpha, so this is an actual partial-inverse rollback.
        await expect(fixture.sql`
          SELECT id FROM integration_config WHERE integration_id = 'alpha' FOR UPDATE NOWAIT
        `).rejects.toMatchObject({ code: "55P03" });
        held.resume.resolve();
        await competing;
        expect(await restoring).toBe(false);
        const after = await rows();
        expect(after[0]).toEqual(alpha); // Earlier UPDATE (including xmin) rolled back.
        expect(after[1].config).toEqual({ label: "competitor" });
        expect(await saved.owns()).toBe(false);
      } finally {
        held.resume.resolve();
        await Promise.allSettled([competing, restoring]);
      }
    });

    it("rejects a concurrent absent-row insertion without committing the earlier batch write", async () => {
      await seed("alpha", { label: "original" });
      const [alpha] = await rows();
      const held = barrier();
      nextCommit = held;
      const winner = persistIntegrationImport([
        { integrationId: "zeta", config: { label: "winner" } },
      ]);
      void winner.catch(() => {});
      let loser: ReturnType<typeof persistIntegrationImport> | undefined;
      try {
        const pid = await bounded(held.entered.promise);
        loser = persistIntegrationImport([
          { integrationId: "zeta", config: { label: "loser" } },
          { integrationId: "alpha", config: { label: "partial" } },
        ]);
        void loser.catch(() => {});
        await waitForBlockedWriter(pid);
        // Prove the losing batch reached its earlier write before the unique
        // insertion conflict, rather than rejecting before it touched any row.
        await expect(fixture.sql`
          SELECT id FROM integration_config WHERE integration_id = 'alpha' FOR UPDATE NOWAIT
        `).rejects.toMatchObject({ code: "55P03" });
        held.resume.resolve();
        const saved = await winner;
        await expect(loser).rejects.toThrow();
        const after = await rows();
        expect(after[0]).toEqual(alpha);
        expect(after[1].config).toEqual({ label: "winner" });
        expect(await saved.owns()).toBe(true);
      } finally {
        held.resume.resolve();
        await Promise.allSettled([winner, loser]);
      }
    });
  },
);
