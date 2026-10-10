import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const LAST_BEFORE_DROP = "0038_better_auth_account_issuer_cleanup";

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");

let container: StartedPostgreSqlContainer;
let tempDir: string;

interface Journal {
  entries: { tag: string }[];
}

/** A copy of the migrations folder whose journal stops at `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const folder = join(tempDir, lastTag);
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (end < 0) throw new Error(`migration ${lastTag} not in the journal`);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

async function freshDatabase(name: string): Promise<Sql> {
  const admin = postgres(container.getConnectionUri(), { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 2, onnotice: () => {} });
  await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
  return sql;
}

async function migrateTo(sql: Sql, migrationsFolder: string): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder });
}

integration("dropping the POI-ingest pipeline's database state", () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "drop-poi-ingest-"));
    container = await new PostgreSqlContainer(
      "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8",
    )
      .withStartupTimeout(60_000)
      .start();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("drops the ingest schema, its tables and the pipeline's job rows on a database that ran it", async () => {
    const sql = await freshDatabase("ingested");
    try {
      await migrateTo(sql, migrationsUpTo(LAST_BEFORE_DROP));

      await sql`CREATE SCHEMA poi_ingest`;
      await sql`CREATE TABLE poi_ingest.de_bnetza_static (id text PRIMARY KEY, geom geometry(Point, 4326))`;
      await sql`INSERT INTO poi_ingest.de_bnetza_static (id, geom) VALUES ('a', ST_SetSRID(ST_MakePoint(8.4, 49.0), 4326))`;
      await sql`INSERT INTO data_manager.poi_feed_state (source_id, domain) VALUES ('de-bnetza', 'ev-charging')`;
      const ingestJobs = await sql<{ id: string }[]>`
        INSERT INTO data_manager.jobs (kind, status) VALUES
          ('poi-ingest:static', 'ok'),
          ('poi-ingest:static', 'error')
        RETURNING id
      `;
      const [kept] = await sql<{ id: string }[]>`
        INSERT INTO data_manager.jobs (kind, status) VALUES ('transitous-sync', 'ok') RETURNING id
      `;
      for (const job of [...ingestJobs, kept]) {
        await sql`
          INSERT INTO data_manager.job_stages (job_id, stage, status, started_at, finished_at, duration_ms)
          VALUES (${job.id}, 'fetch', 'ok', now(), now(), 1)
        `;
      }

      await migrateTo(sql, MIGRATIONS);

      const schemas = await sql`
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'poi_ingest'
      `;
      expect(schemas).toHaveLength(0);
      const tables = await sql`
        SELECT 1 FROM information_schema.tables
        WHERE (table_schema = 'poi_ingest')
           OR (table_schema = 'data_manager' AND table_name = 'poi_feed_state')
      `;
      expect(tables).toHaveLength(0);
      const jobs = await sql<{ id: string; kind: string }[]>`
        SELECT id, kind FROM data_manager.jobs
      `;
      expect(jobs).toEqual([{ id: kept.id, kind: "transitous-sync" }]);
      const stages = await sql<{ job_id: string }[]>`SELECT job_id FROM data_manager.job_stages`;
      expect(stages).toEqual([{ job_id: kept.id }]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  it("migrates a fresh database to head", async () => {
    const sql = await freshDatabase("fresh");
    try {
      await migrateTo(sql, MIGRATIONS);

      const tables = await sql`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'data_manager' AND table_name = 'poi_feed_state'
      `;
      expect(tables).toHaveLength(0);
      const [{ count }] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM data_manager.jobs
      `;
      expect(count).toBe("0");
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
