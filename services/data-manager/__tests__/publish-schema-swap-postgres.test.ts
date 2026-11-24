import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPublicationFenceDDL } from "../src/jobs/publication-fence.js";
import { publishSchemaSwap, publishTableSwap } from "../src/jobs/publish-schema-swap.js";
import { type PostgisFixture, startPostgis } from "./helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";
const quickRetry = { attempts: 2, backoffMs: 10 };

describe.skipIf(skipE2e)("schema publication by rename", () => {
  let pg: PostgisFixture;
  let reader: postgres.Sql;

  beforeAll(async () => {
    pg = await startPostgis();
    reader = postgres(pg.connectionString, { max: 1 });
  }, 120_000);

  afterAll(async () => {
    await reader?.end({ timeout: 2 });
    await pg?.stop();
  });

  async function stage(schema: string, label: string): Promise<void> {
    await pg.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pg.sql.unsafe(`CREATE SCHEMA "${schema}"`);
    await pg.sql.unsafe(buildPublicationFenceDDL(schema));
    await pg.sql.unsafe(`CREATE TABLE "${schema}".snapshot (label TEXT NOT NULL)`);
    await pg.sql.unsafe(`INSERT INTO "${schema}".snapshot VALUES ($1)`, [label]);
  }

  async function schemas(): Promise<string[]> {
    const rows = await pg.sql.unsafe<{ name: string }[]>(
      `SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'osm\\_search%' ORDER BY 1`,
    );
    return rows.map(({ name }) => name);
  }

  async function liveLabel(): Promise<string | undefined> {
    const [row] = await pg.sql.unsafe<{ label: string }[]>(`SELECT label FROM osm_search.snapshot`);
    return row?.label;
  }

  it("keeps the old schema while a reader outlasts the drop, and the next publication drops it first", async () => {
    await pg.sql.unsafe(`DROP SCHEMA IF EXISTS osm_search__previous CASCADE`);
    await stage("osm_search", "first");
    const holder = await reader.reserve();
    try {
      await holder.unsafe(`BEGIN`);
      await holder.unsafe(`SELECT count(*) FROM osm_search.snapshot`);

      await stage("osm_search__staging", "second");
      await publishSchemaSwap(pg.sql, {
        live: "osm_search",
        staging: "osm_search__staging",
        lockTimeoutMs: 100,
        retry: quickRetry,
      });
      expect(await liveLabel()).toBe("second");
      expect(await schemas()).toEqual(["osm_search", "osm_search__previous"]);
      const [kept] = await pg.sql.unsafe<{ label: string }[]>(
        `SELECT label FROM osm_search__previous.snapshot`,
      );
      expect(kept?.label).toBe("first");

      // While the reader still holds the leftover, a publication cannot start.
      await stage("osm_search__staging", "third");
      await expect(
        publishSchemaSwap(pg.sql, {
          live: "osm_search",
          staging: "osm_search__staging",
          lockTimeoutMs: 100,
          retry: quickRetry,
        }),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(await liveLabel()).toBe("second");

      await holder.unsafe(`COMMIT`);
      await publishSchemaSwap(pg.sql, {
        live: "osm_search",
        staging: "osm_search__staging",
        lockTimeoutMs: 100,
        retry: quickRetry,
      });
      expect(await liveLabel()).toBe("third");
      expect(await schemas()).toEqual(["osm_search"]);
    } finally {
      await holder.unsafe(`ROLLBACK`).catch(() => undefined);
      holder.release();
    }
  });

  it("leaves the live and staging schemas untouched when the swap's transaction fails", async () => {
    await stage("osm_search", "live");
    await stage("osm_search__staging", "staged");
    await expect(
      publishSchemaSwap(pg.sql, {
        live: "osm_search",
        staging: "osm_search__staging",
        retry: quickRetry,
        carryOver: async () => {
          throw new Error("injected carry-over failure");
        },
      }),
    ).rejects.toThrow("injected carry-over failure");
    expect(await liveLabel()).toBe("live");
    expect(await schemas()).toEqual(["osm_search", "osm_search__staging"]);
  });

  it("publishes the first snapshot when no live schema exists", async () => {
    await pg.sql.unsafe(`DROP SCHEMA IF EXISTS osm_search CASCADE`);
    await stage("osm_search__staging", "initial");
    const carried: (string | null)[] = [];
    await publishSchemaSwap(pg.sql, {
      live: "osm_search",
      staging: "osm_search__staging",
      retry: quickRetry,
      carryOver: async (_tx, previous) => {
        carried.push(previous);
      },
    });
    expect(carried).toEqual([null]);
    expect(await liveLabel()).toBe("initial");
    expect(await schemas()).toEqual(["osm_search"]);
    const [stats] = await pg.sql.unsafe<{ analyzed: boolean }[]>(
      `SELECT reltuples >= 0 AS analyzed FROM pg_class WHERE oid = 'osm_search.snapshot'::regclass`,
    );
    expect(stats?.analyzed).toBe(true);
  });

  async function fenceOid(schema: string): Promise<string | null> {
    const [row] = await pg.sql.unsafe<{ oid: string | null }[]>(
      `SELECT to_regclass($1)::OID::TEXT AS oid`,
      [`"${schema}".publication_fence`],
    );
    return row?.oid ?? null;
  }

  // A backup holds ACCESS SHARE on every table it dumps, the fence among them.
  async function withBackupLikeHolder(tables: string[], run: () => Promise<void>): Promise<void> {
    const holder = await reader.reserve();
    try {
      await holder.unsafe(`BEGIN ISOLATION LEVEL REPEATABLE READ`);
      for (const table of tables) await holder.unsafe(`LOCK TABLE ${table} IN ACCESS SHARE MODE`);
      await run();
    } finally {
      await holder.unsafe(`ROLLBACK`).catch(() => undefined);
      holder.release();
    }
  }

  it("waits for a backup that holds the fence, fails, and leaves the live schema readable", async () => {
    await pg.sql.unsafe(`DROP SCHEMA IF EXISTS osm_search__previous CASCADE`);
    await stage("osm_search", "live");
    await stage("osm_search__staging", "staged");
    const probe = postgres(pg.connectionString, {
      max: 1,
      connection: { statement_timeout: 500 },
    });
    try {
      await withBackupLikeHolder(["osm_search.publication_fence"], async () => {
        const publication = publishSchemaSwap(pg.sql, {
          live: "osm_search",
          staging: "osm_search__staging",
          retry: quickRetry,
        });
        // Readers never touch the fence, so the waiting publication queues nobody.
        await expect(probe.unsafe(`SELECT label FROM osm_search.snapshot`)).resolves.toEqual([
          { label: "live" },
        ]);
        await expect(publication).rejects.toMatchObject({ code: "55P03" });
      });
    } finally {
      await probe.end({ timeout: 2 });
    }
    expect(await liveLabel()).toBe("live");
    expect(await schemas()).toEqual(["osm_search", "osm_search__staging"]);

    // Once the backup has ended, the publication goes through and replaces the fence.
    const fence = await fenceOid("osm_search");
    const staged = await fenceOid("osm_search__staging");
    await publishSchemaSwap(pg.sql, {
      live: "osm_search",
      staging: "osm_search__staging",
      retry: quickRetry,
    });
    expect(await liveLabel()).toBe("staged");
    expect(await fenceOid("osm_search")).toBe(staged);
    expect(fence).not.toBe(staged);
    expect(await schemas()).toEqual(["osm_search"]);
  });

  it("refuses a staging schema without a fence", async () => {
    await stage("osm_search", "live");
    await stage("osm_search__staging", "unfenced");
    await pg.sql.unsafe(`DROP TABLE osm_search__staging.publication_fence`);
    await expect(
      publishSchemaSwap(pg.sql, {
        live: "osm_search",
        staging: "osm_search__staging",
        retry: quickRetry,
      }),
    ).rejects.toThrow('The staging schema "osm_search__staging" has no publication_fence table');
    expect(await liveLabel()).toBe("live");
  });

  it("retries a swap that lost a deadlock with a backup still taking its locks", async () => {
    await stage("osm_search", "live");
    await pg.sql.unsafe(
      `CREATE TABLE osm_search.snapshot_next (label TEXT NOT NULL);
       INSERT INTO osm_search.snapshot_next VALUES ('next')`,
    );
    // Like pg_dump in its lock phase: it holds the live table and asks for
    // the fence next, while the swap holds the fence and waits for the table.
    const backup = await reader.reserve();
    try {
      await backup.unsafe(`BEGIN ISOLATION LEVEL REPEATABLE READ`);
      await backup.unsafe(`LOCK TABLE osm_search.snapshot IN ACCESS SHARE MODE`);
      const swap = publishTableSwap(pg.sql, {
        schema: "osm_search",
        live: "snapshot",
        staging: "snapshot_next",
        // Longer than deadlock_timeout (1 s), so the first wait ends in the
        // deadlock, which the swap that waited first detects and loses.
        lockTimeoutMs: 3000,
        retry: quickRetry,
      });
      const swapFailure = swap.catch((error: unknown) => error);
      const waitingForTable = async () => {
        const [row] = await pg.sql.unsafe<{ waiting: boolean }[]>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted
             AND relation = 'osm_search.snapshot'::regclass) AS waiting`,
        );
        return row?.waiting === true;
      };
      for (let attempt = 0; !(await waitingForTable()); attempt += 1) {
        if (attempt > 100) throw new Error("the swap never waited for the table");
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      const asked = Date.now();
      await backup.unsafe(`LOCK TABLE osm_search.publication_fence IN ACCESS SHARE MODE`);
      // The deadlock released the fence after about a second, not the 3 s timeout.
      expect(Date.now() - asked).toBeLessThan(2500);
      // The retry then waits for the backup, which now holds the fence, and times out.
      expect(await swapFailure).toMatchObject({ code: "55P03" });
    } finally {
      await backup.unsafe(`ROLLBACK`).catch(() => undefined);
      backup.release();
    }
    expect(await liveLabel()).toBe("live");
  });

  it("locks and replaces the fence when it swaps a single table", async () => {
    await stage("osm_search", "live");
    await pg.sql.unsafe(
      `CREATE TABLE osm_search.snapshot_next (label TEXT NOT NULL);
       INSERT INTO osm_search.snapshot_next VALUES ('next')`,
    );
    const swap = () =>
      publishTableSwap(pg.sql, {
        schema: "osm_search",
        live: "snapshot",
        staging: "snapshot_next",
        retry: quickRetry,
      });
    await withBackupLikeHolder(["osm_search.publication_fence"], async () => {
      await expect(swap()).rejects.toMatchObject({ code: "55P03" });
    });
    expect(await liveLabel()).toBe("live");
    const fence = await fenceOid("osm_search");
    await swap();
    expect(await liveLabel()).toBe("next");
    const replaced = await fenceOid("osm_search");
    expect(replaced).not.toBeNull();
    expect(replaced).not.toBe(fence);
  });
});
