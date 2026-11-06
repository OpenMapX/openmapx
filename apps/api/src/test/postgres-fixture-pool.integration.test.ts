import { describe, expect, it } from "vitest";
import { createPostgresFixturePool } from "./postgres-fixture-pool";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "worker-owned migrated fixture pool",
  () => {
    it("clones fresh isolated current schemas and cleans failed/unfinished scenarios", async () => {
      const pool = await createPostgresFixturePool();
      try {
        const [left, right] = await Promise.all([pool.create(), pool.create()]);
        expect(left.connectionUri).not.toBe(right.connectionUri);
        await left.sql`CREATE TABLE isolated_probe (value text)`;
        await right.sql`CREATE TABLE isolated_probe (value text)`;
        await left.sql`INSERT INTO isolated_probe VALUES ('left only')`;
        expect(await right.sql`SELECT * FROM isolated_probe`).toHaveLength(0);
        await right.sql`INSERT INTO isolated_probe VALUES ('right only')`;
        expect(await left.sql`SELECT value FROM isolated_probe`).toEqual([{ value: "left only" }]);
        await left.stop();
        const fresh = await pool.create();
        const tables = await fresh.sql`SELECT to_regclass('public.isolated_probe') AS name`;
        expect(tables[0].name).toBeNull();
        // Deliberately leave right/fresh open: the worker teardown owns both.
        await pool.stop();
        await expect(pool.create()).rejects.toThrow(/closed/);
        await expect(right.sql`SELECT 1`).rejects.toThrow();
        await expect(fresh.sql`SELECT 1`).rejects.toThrow();
      } finally {
        await pool.stop();
      }
    }, 120000);
  },
);
