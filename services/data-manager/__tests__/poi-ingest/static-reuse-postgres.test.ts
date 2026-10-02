// Explicit opt-in; all SQL is confined to the disposable PostGIS fixture.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoiRow, RegisteredPoiSource } from "@openmapx/poi-source-registry";
import { createStaticPoiChangeKey } from "@openmapx/poi-source-registry/static-change-key";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPoiJobContext, runStaticIngest } from "../../src/jobs/poi-ingest/pipeline.js";
import { type PostgisFixture, startPostgis } from "./_testcontainer.js";

const fixture = vi.hoisted(() => ({
  sql: null as unknown as import("postgres").Sql,
  db: null as unknown as ReturnType<typeof drizzle>,
}));
// Persistence uses its module's DB exports. Redirect only those exports to
// our disposable fixture; never create or use the application DB connection.
vi.mock("../../src/db/index.js", () => ({
  sql: { unsafe: (query: string, values: never[]) => fixture.sql.unsafe(query, values) },
  db: { insert: (...args: Parameters<typeof fixture.db.insert>) => fixture.db.insert(...args) },
}));

const skipDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";
const rows: PoiRow[] = [{ poiId: "a", lng: 6, lat: 50, payload: { name: "A", tariff: 1 } }];
const source: RegisteredPoiSource = {
  id: "de-static-acceptance",
  stationIdPrefix: "de-static-acceptance:",
  domain: "ev-charging",
  name: "Fixture",
  static: {
    cron: "0 4 * * *",
    fetch: { type: "http", url: "https://example.invalid/static" },
    parse: () => rows,
    staticChangeKey: createStaticPoiChangeKey("acceptance-v1"),
  },
};

describe.skipIf(skipDatabase)("static publication reuse in disposable PostGIS", () => {
  let pg: PostgisFixture;
  beforeAll(async () => {
    pg = await startPostgis();
    fixture.sql = pg.sql;
    fixture.db = drizzle(pg.sql);
    await migrate(fixture.db, {
      migrationsFolder: join(__dirname, "../../../../apps/api/src/db/migrations"),
    });
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  async function ingest(at: string) {
    const result = await runStaticIngest(
      buildPoiJobContext({
        source,
        kind: "static",
        sql: pg.sql,
        redis: null,
        jobId: `fixture-${at}`,
        now: () => at,
        download: async (opts) => {
          writeFileSync(opts.destination, "fixture");
          return { bytesWritten: 7, contentType: null, finalUrl: opts.url };
        },
      }),
    );
    expect(result.status).toBe("ok");
    const { upsertPoiFeedState } = await import("../../src/jobs/poi-ingest/persistence.js");
    await upsertPoiFeedState({ sourceId: source.id, domain: source.domain, result });
    return result;
  }
  async function publication() {
    const [state] =
      await pg.sql.unsafe(`SELECT last_static_hash, last_static_row_count, last_static_ingest_at, refresh_evidence,
      to_regclass('poi_ingest.de_static_acceptance_static')::oid::text AS table_oid
      FROM data_manager.poi_feed_state WHERE source_id = 'de-static-acceptance'`);
    return state;
  }

  it("preserves table identity, publication time/version/count and advances checks; changed content or missing table rebuild", async () => {
    await ingest("2026-09-01T00:00:00.000Z");
    const first = await publication();
    const secondResult = await ingest("2026-09-02T00:00:00.000Z");
    const second = await publication();
    expect(secondResult.skippedStaticSwap).toBe(true);
    expect(second.table_oid).toBe(first.table_oid);
    expect(second.last_static_ingest_at).toEqual(first.last_static_ingest_at);
    expect(second.last_static_hash).toBe(first.last_static_hash);
    expect(second.last_static_row_count).toBe(1);
    expect(second.refresh_evidence.static).toMatchObject({
      activeVersion: first.refresh_evidence.static.activeVersion,
      lastPublishedVersion: first.refresh_evidence.static.lastPublishedVersion,
      lastPublishedAt: "2026-09-01T00:00:00.000Z",
      rowCount: 1,
      lastSuccessfullyCheckedVersion: first.refresh_evidence.static.activeVersion,
      lastSuccessfulCheckAt: "2026-09-02T00:00:00.000Z",
      lastAttempt: { outcome: "unchanged" },
    });
    // A same-name table recreated outside publication must not inherit reuse.
    await pg.sql.unsafe("DROP TABLE poi_ingest.de_static_acceptance_static CASCADE");
    await pg.sql.unsafe("CREATE TABLE poi_ingest.de_static_acceptance_static (poi_id text)");
    const replacement = await publication();
    expect(replacement.table_oid).not.toBe(second.table_oid);
    const restored = await ingest("2026-09-02T12:00:00.000Z");
    expect(restored.skippedStaticSwap).not.toBe(true);
    rows[0].payload.tariff = 2;
    await ingest("2026-09-03T00:00:00.000Z");
    const changed = await publication();
    expect(changed.table_oid).not.toBe(second.table_oid);
    expect(changed.last_static_hash).not.toBe(second.last_static_hash);
    const [stored] = await pg.sql.unsafe(
      "SELECT payload FROM poi_ingest.de_static_acceptance_static",
    );
    expect(stored.payload.tariff).toBe(2);
    await pg.sql.unsafe("DROP TABLE poi_ingest.de_static_acceptance_static CASCADE");
    const repaired = await ingest("2026-09-04T00:00:00.000Z");
    expect(repaired.skippedStaticSwap).not.toBe(true);
    expect((await publication()).table_oid).not.toBe(changed.table_oid);
  });
});
