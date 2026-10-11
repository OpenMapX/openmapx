import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PostgisFixture,
  startPostgis,
} from "../../../../../services/data-manager/__tests__/helpers/postgis-testcontainer";
import { healthHistory } from "../../db/health-history-schema";

const holder = vi.hoisted(() => ({ db: null as unknown, sql: null as unknown }));
vi.mock("../../db", () => ({
  get db() {
    return holder.db;
  },
  get sql() {
    return holder.sql;
  },
}));

import { getTimeline, pruneOldRecords, recordHealthResult } from "../health-history";

const cutoff = new Date("2026-09-11T12:00:00Z");
const fixtureRequire = createRequire(
  new URL("../../../../../services/data-manager/package.json", import.meta.url),
);
const runtimeRequire = createRequire(fixtureRequire.resolve("@testcontainers/postgresql"));
const runtime = runtimeRequire("testcontainers") as {
  getContainerRuntimeClient(): Promise<{
    container: { getById(id: string): unknown; inspect(container: unknown): Promise<unknown> };
  }>;
};

async function pruneAt(cutoff: Date): Promise<number> {
  const clock = vi.spyOn(Date, "now").mockReturnValue(cutoff.getTime() + 30 * 86400000);
  try {
    return await pruneOldRecords();
  } finally {
    clock.mockRestore();
  }
}

function instrument(sql: PostgisFixture["sql"]) {
  const statements: Array<{
    text: string;
    parameters: unknown[];
    command: string;
    count: number;
    rows: number;
  }> = [];
  const traced = new Proxy(sql, {
    get(target, key, receiver) {
      if (key === "begin")
        return () => {
          throw new Error("Unexpected health history BEGIN");
        };
      if (key !== "unsafe") return Reflect.get(target, key, receiver);
      return (text: string, parameters: unknown[] = [], ...rest: unknown[]) => {
        const query = Reflect.apply(target.unsafe, target, [text, parameters, ...rest]);
        const then = query.then.bind(query);
        // biome-ignore lint/suspicious/noThenProperty: instrument the real PendingQuery while preserving its values method.
        query.then = (
          resolve: (rows: postgres.RowList<postgres.Row[]>) => unknown,
          reject: (error: unknown) => unknown,
        ) =>
          then((rows: postgres.RowList<postgres.Row[]>) => {
            statements.push({
              text,
              parameters,
              command: rows.command,
              count: rows.count,
              rows: rows.length,
            });
            return resolve(rows);
          }, reject);
        return query;
      };
    },
  });
  holder.sql = traced;
  holder.db = drizzle(traced, { schema: { healthHistory } });
  return statements;
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "disposable health history PostgreSQL",
  () => {
    let pg: PostgisFixture;
    beforeAll(async () => {
      pg = await startPostgis();
      holder.db = drizzle(pg.sql, { schema: { healthHistory } });
      holder.sql = pg.sql;
      await pg.sql.unsafe(`CREATE TABLE health_history (id serial PRIMARY KEY, service_id text NOT NULL, status text NOT NULL, response_time integer, error text, checked_at timestamp NOT NULL DEFAULT now());
      CREATE INDEX "healthHistory_serviceId_checkedAt_idx" ON health_history(service_id, checked_at)`);
      console.info("OWNED_HEALTH_FIXTURE", pg.container.getId());
      console.info("health fixture version", await pg.sql.unsafe("SELECT version() AS version"));
    }, 90000);
    afterAll(async () => {
      if (!pg) return;
      const ownedId = pg.container.getId();
      expect(ownedId).toMatch(/^[a-f0-9]{64}$/);
      const errors: unknown[] = [];
      try {
        await pg.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        const client = await runtime.getContainerRuntimeClient();
        await expect(
          client.container.inspect(client.container.getById(ownedId)),
        ).rejects.toMatchObject({ statusCode: 404 });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Owned health fixture cleanup failed");
      console.info("OWNED_HEALTH_FIXTURE_ABSENT", ownedId);
    }, 30000);
    beforeEach(async () => {
      holder.sql = pg.sql;
      holder.db = drizzle(pg.sql, { schema: { healthHistory } });
      await pg.sql.unsafe("TRUNCATE health_history RESTART IDENTITY");
    });

    it("uses exactly the original strict DELETE predicate with native count and zero returned ID rows", async () => {
      await pg.sql.unsafe(
        `INSERT INTO health_history(service_id,status,checked_at)
         SELECT 'expired','healthy',$1::timestamp - interval '1 second' FROM generate_series(1,2501)`,
        [cutoff.toISOString()],
      );
      await pg.sql.unsafe(
        `INSERT INTO health_history(service_id,status,checked_at) VALUES
         ('boundary','healthy',$1::timestamp), ('live','healthy',$1::timestamp + interval '1 second')`,
        [cutoff.toISOString()],
      );
      const statements = instrument(pg.sql);
      try {
        expect(await pruneAt(cutoff)).toBe(2501);
        expect(statements).toEqual([
          {
            text: 'delete from "health_history" where "health_history"."checked_at" < $1',
            parameters: [cutoff.toISOString()],
            command: "DELETE",
            count: 2501,
            rows: 0,
          },
        ]);
        expect(await pruneAt(cutoff)).toBe(0);
        expect(statements[1]).toEqual({ ...statements[0], count: 0 });
      } finally {
        holder.sql = pg.sql;
        holder.db = drizzle(pg.sql, { schema: { healthHistory } });
      }
      expect(await pg.sql.unsafe("SELECT service_id FROM health_history ORDER BY id")).toEqual([
        { service_id: "boundary" },
        { service_id: "live" },
      ]);
    });

    it.each([350000, 1050000])(
      "counts exactly %i expired IDs without returning them and preserves two million live rows, boundary and timeline",
      async (expired) => {
        await pg.sql.unsafe(
          `INSERT INTO health_history(service_id,status,checked_at)
         SELECT 'expired-' || i, 'unhealthy', $1::timestamp - interval '1 second' FROM generate_series(1,$2::int) i`,
          [cutoff.toISOString(), expired],
        );
        await pg.sql.unsafe(
          `INSERT INTO health_history(service_id,status,checked_at)
         SELECT 'live-' || i, 'healthy', $1::timestamp + interval '1 second' FROM generate_series(1,2000000) i`,
          [cutoff.toISOString()],
        );
        await pg.sql.unsafe(
          `INSERT INTO health_history(service_id,status,checked_at) VALUES ('boundary','healthy',$1::timestamp)`,
          [cutoff.toISOString()],
        );
        await pg.sql.unsafe(`INSERT INTO health_history(service_id,status,response_time,checked_at) VALUES
        ('timeline','healthy',100,'2026-10-11 11:59:59.999'),
        ('timeline','unhealthy',NULL,'2026-10-11 12:00:00'),
        ('timeline','healthy',200,'2026-10-11 12:59:59.999')`);
        const [before] = await pg.sql.unsafe(
          `SELECT count(*)::int AS count,
        count(*) FILTER(WHERE id BETWEEN 1 AND $2::int AND service_id='expired-' || id AND checked_at < $1::timestamp)::int AS exact_expired
        FROM health_history`,
          [cutoff.toISOString(), expired],
        );
        expect(before).toEqual({ count: expired + 2000004, exact_expired: expired });
        const timelineClock = vi
          .spyOn(Date, "now")
          .mockReturnValue(new Date("2026-10-11T13:30:00Z").getTime());
        const timelineBefore = await getTimeline("timeline", 24);
        timelineClock.mockRestore();
        const statements = instrument(pg.sql);
        let count: number;
        try {
          count = await pruneAt(cutoff);
          expect(count).toBe(expired);
          expect(statements).toEqual([
            {
              text: 'delete from "health_history" where "health_history"."checked_at" < $1',
              parameters: [cutoff.toISOString()],
              command: "DELETE",
              count: expired,
              rows: 0,
            },
          ]);
        } finally {
          holder.sql = pg.sql;
          holder.db = drizzle(pg.sql, { schema: { healthHistory } });
        }
        const [after] = await pg.sql.unsafe(
          `SELECT count(*)::int AS count,
        count(*) FILTER(WHERE id BETWEEN 1 AND $2::int OR checked_at < $1::timestamp)::int AS retained_expired,
        count(*) FILTER(WHERE id BETWEEN $2::int+1 AND $2::int+2000000 AND service_id='live-' || (id-$2::int)
          AND status='healthy' AND response_time IS NULL AND error IS NULL AND checked_at=$1::timestamp+interval '1 second')::int AS exact_live,
        count(*) FILTER(WHERE id=$2::int+2000001 AND service_id='boundary' AND checked_at=$1::timestamp)::int AS exact_boundary
        FROM health_history`,
          [cutoff.toISOString(), expired],
        );
        expect(after).toEqual({
          count: 2000004,
          retained_expired: 0,
          exact_live: 2000000,
          exact_boundary: 1,
        });
        const clock = vi
          .spyOn(Date, "now")
          .mockReturnValue(new Date("2026-10-11T13:30:00Z").getTime());
        try {
          expect(await getTimeline("timeline", 24)).toEqual(timelineBefore);
        } finally {
          clock.mockRestore();
        }
        expect(timelineBefore).toHaveLength(2);
        expect(timelineBefore.map((row) => row.total)).toEqual([1, 2]);
      },
      180000,
    );

    it("keeps per-result samples, nullable fields and database insertion-time timestamps beyond 100 samples", async () => {
      const [{ before }] = await pg.sql.unsafe<{ before: Date }[]>(
        "SELECT clock_timestamp()::timestamp AS before",
      );
      const samples = Array.from({ length: 105 }, (_, i) => ({
        serviceId: `sample-${i}`,
        status: ["healthy", "unhealthy", "degraded", "error"][i % 4] ?? "error",
        responseTime: i % 2 ? null : i,
        error: i % 4 ? null : `failure-${i}`,
      }));
      await Promise.all(
        samples.map((s) => recordHealthResult(s.serviceId, s.status, s.responseTime, s.error)),
      );
      const [{ after }] = await pg.sql.unsafe<{ after: Date }[]>(
        "SELECT clock_timestamp()::timestamp AS after",
      );
      const rows = await pg.sql.unsafe<
        {
          service_id: string;
          status: string;
          response_time: number | null;
          error: string | null;
          checked_at: Date;
        }[]
      >("SELECT * FROM health_history ORDER BY substring(service_id from '[0-9]+')::int");
      expect(
        rows.map((r) => ({
          serviceId: r.service_id,
          status: r.status,
          responseTime: r.response_time,
          error: r.error,
        })),
      ).toEqual(samples);
      for (const row of rows) {
        expect(new Date(row.checked_at).getTime()).toBeGreaterThanOrEqual(
          new Date(before).getTime(),
        );
        expect(new Date(row.checked_at).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
      }
    });

    it("retains deterministic hourly timelines across insertion-hour boundaries", async () => {
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(new Date("2026-10-11T13:30:00Z").getTime());
      try {
        await pg.sql.unsafe(`INSERT INTO health_history(service_id,status,response_time,error,checked_at) VALUES
        ('timeline','healthy',100,NULL,'2026-10-11 11:59:59.999'),
        ('timeline','unhealthy',NULL,'timeout','2026-10-11 12:00:00'),
        ('timeline','healthy',200,NULL,'2026-10-11 12:59:59.999'),
        ('timeline','degraded',400,NULL,'2026-10-11 13:00:00')`);
        const timeline = await getTimeline("timeline", 24);
        expect(timeline).toEqual([
          {
            hour: "2026-10-11 11:00:00",
            total: 1,
            healthy: 1,
            uptimePercent: 100,
            avgResponseTime: 100,
          },
          {
            hour: "2026-10-11 12:00:00",
            total: 2,
            healthy: 1,
            uptimePercent: 50,
            avgResponseTime: 200,
          },
          {
            hour: "2026-10-11 13:00:00",
            total: 1,
            healthy: 0,
            uptimePercent: 0,
            avgResponseTime: 400,
          },
        ]);
      } finally {
        clock.mockRestore();
      }
    });

    it("preserves history through rejected deletes and counts concurrent whole-cutoff pruning exactly", async () => {
      await pg.sql.unsafe(
        `INSERT INTO health_history(service_id,status,checked_at) SELECT 'old','healthy',$1::timestamp - interval '1 day' FROM generate_series(1,2500)`,
        [cutoff.toISOString()],
      );
      await pg.sql.unsafe(
        "CREATE FUNCTION reject_health_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id=1700 THEN RAISE EXCEPTION 'injected rejection'; END IF; RETURN OLD; END $$; CREATE TRIGGER health_rejection BEFORE DELETE ON health_history FOR EACH ROW EXECUTE FUNCTION reject_health_delete()",
      );
      try {
        await expect(pruneAt(cutoff)).rejects.toMatchObject({
          cause: { code: "P0001", message: "injected rejection" },
        });
        expect(
          (await pg.sql.unsafe("SELECT count(*)::int AS count FROM health_history"))[0]?.count,
        ).toBe(2500);
      } finally {
        await pg.sql.unsafe(
          "DROP TRIGGER health_rejection ON health_history; DROP FUNCTION reject_health_delete()",
        );
      }
      const counts = await Promise.all([pruneAt(cutoff), pruneAt(cutoff)]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(2500);
      expect(
        (await pg.sql.unsafe("SELECT count(*)::int AS count FROM health_history"))[0]?.count,
      ).toBe(2500 - counts.reduce((a, b) => a + b, 0));
    });

    it("drains five logical days of 350000 newly expired rows while retaining two million live rows and continuous actual-writer arrivals", async () => {
      const firstCutoff = new Date(Date.now() - 30 * 86400000);
      const liveTimestamp = new Date(firstCutoff.getTime() + 10 * 86400000).toISOString();
      const runs: Array<{
        logicalDay: number;
        cutoff: string;
        fixtureDrainDurationMs: number;
        deleted: number;
        arrivals: number;
        cumulativeArrivals: number;
      }> = [];
      await pg.sql.unsafe(
        `INSERT INTO health_history(service_id,status,checked_at)
        SELECT 'live-' || (i % 100), 'healthy', $1::timestamp FROM generate_series(1,2000000) i`,
        [liveTimestamp],
      );
      let cumulativeArrivals = 0;
      const arrivalWindows: Array<{
        logicalDay: number;
        firstId: number;
        lastId: number;
        before: string;
        after: string;
        count: number;
      }> = [];
      for (let logicalDay = 1; logicalDay <= 5; logicalDay++) {
        const dailyCutoff = new Date(firstCutoff.getTime() + (logicalDay - 1) * 86400000);
        await pg.sql.unsafe(
          `INSERT INTO health_history(service_id,status,checked_at)
          SELECT 'expired-day-' || $2::text,'healthy',$1::timestamp - interval '1 second'
          FROM generate_series(1,350000)`,
          [dailyCutoff.toISOString(), logicalDay],
        );
        await pg.sql.unsafe("ANALYZE health_history");
        const [windowStart] = await pg.sql.unsafe<{ last_id: number; before: string }[]>(
          "SELECT last_value::int AS last_id, clock_timestamp()::timestamp::text AS before FROM health_history_id_seq",
        );
        let settled = false;
        let arrivals = 0;
        const started = performance.now();
        let fixtureDrainDurationMs = 0;
        const deleting = pruneAt(dailyCutoff).finally(() => {
          fixtureDrainDurationMs = performance.now() - started;
          settled = true;
        });
        const arriving = (async () => {
          do {
            await recordHealthResult(`arrival-day-${logicalDay}`, "healthy", 1);
            arrivals++;
          } while (!settled);
        })();
        const [deletion, arrivalOutcome] = await Promise.allSettled([deleting, arriving] as const);
        if (deletion.status === "rejected") throw deletion.reason;
        if (arrivalOutcome.status === "rejected") throw arrivalOutcome.reason;
        const deleted = deletion.value;
        const [windowEnd] = await pg.sql.unsafe<{ after: string }[]>(
          "SELECT clock_timestamp()::timestamp::text AS after",
        );
        if (!windowStart || !windowEnd)
          throw new Error("Missing server insertion-time window metadata");
        arrivalWindows.push({
          logicalDay,
          firstId: windowStart.last_id + 1,
          lastId: windowStart.last_id + arrivals,
          before: windowStart.before,
          after: windowEnd.after,
          count: arrivals,
        });
        cumulativeArrivals += arrivals;
        expect(deleted).toBe(350000);
        expect(arrivals).toBeGreaterThan(1);
        const [state] = await pg.sql.unsafe(
          `SELECT count(*)::int AS total,
          count(*) FILTER(WHERE id BETWEEN 1 AND 2000000 AND service_id='live-' || (id % 100)
            AND status='healthy' AND response_time IS NULL AND error IS NULL AND checked_at=$1::timestamp)::int AS exact_live,
          count(*) FILTER(WHERE service_id LIKE 'arrival-day-%' AND status='healthy' AND response_time=1
            AND error IS NULL AND checked_at >= $2::timestamp)::int AS exact_arrivals,
          count(*) FILTER(WHERE checked_at < $2::timestamp)::int AS still_expired
          FROM health_history`,
          [liveTimestamp, dailyCutoff.toISOString()],
        );
        expect(state).toEqual({
          total: 2000000 + cumulativeArrivals,
          exact_live: 2000000,
          exact_arrivals: cumulativeArrivals,
          still_expired: 0,
        });
        for (const window of arrivalWindows) {
          const [exact] = await pg.sql.unsafe(
            `SELECT count(*)::int AS total,
            count(*) FILTER(WHERE id BETWEEN $2::int AND $3::int AND status='healthy' AND response_time=1
              AND error IS NULL AND checked_at >= $4::timestamp AND checked_at <= $5::timestamp)::int AS exact
            FROM health_history WHERE service_id=$1`,
            [
              `arrival-day-${window.logicalDay}`,
              window.firstId,
              window.lastId,
              window.before,
              window.after,
            ],
          );
          expect(exact).toEqual({ total: window.count, exact: window.count });
        }
        runs.push({
          logicalDay,
          cutoff: dailyCutoff.toISOString(),
          fixtureDrainDurationMs,
          deleted,
          arrivals,
          cumulativeArrivals,
        });
      }
      console.info(
        "health retention controlled steady-expiry fixture",
        JSON.stringify({
          scope:
            "five logical days, unchanged retained rows, actual recordHealthResult loop during each prune; correctness only; not a production 24h soak, performance gate or pool/network readiness",
          runs,
        }),
      );
    }, 600000);
  },
);
