import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishSchemaSwap } from "../src/jobs/publish-schema-swap.js";
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
});
