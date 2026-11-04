import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_LOCK_KEY, type MigrationLogger, startMigrations } from "../migration-runner.js";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const SLOW_MIGRATION = "9999_slow_test_migration";

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");

let container: StartedPostgreSqlContainer;
let tempDir: string;

interface LogLine {
  level: "info" | "warn";
  fields: Record<string, unknown>;
  message: string;
}

function recordingLogger(): MigrationLogger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    info: (fields, message) => lines.push({ level: "info", fields, message }),
    warn: (fields, message) => lines.push({ level: "warn", fields, message }),
  };
}

/** The production migrations followed by one that sleeps until it is stopped. */
function migrationsWithSlowTail(): string {
  const folder = join(tempDir, "slow");
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const last = journal.entries.at(-1);
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: SLOW_MIGRATION });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(folder, `${SLOW_MIGRATION}.sql`), "SELECT pg_sleep(120);");
  return folder;
}

async function freshDatabase(name: string): Promise<string> {
  const admin = postgres(container.getConnectionUri(), { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  return url.toString();
}

function session(url: string): Sql {
  return postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "migration-runner-test" },
  });
}

async function until(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

integration("startup migration runner", () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "migration-runner-"));
    container = await new PostgreSqlContainer(
      "ghcr.io/baosystems/postgis:18-3.6@sha256:8784f86b3e0e046859c96ea25eb8b10f0b801fd891b99a82b82f28ac4a643db8",
    )
      .withStartupTimeout(60_000)
      .start();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("names the migrations it applies, and none once the schema is current", async () => {
    const url = await freshDatabase("names");
    const control = postgres(url, { max: 2 });
    try {
      const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
      const tags = journal.entries.map((entry: { tag: string }) => entry.tag);

      const firstLog = recordingLogger();
      const first = startMigrations({
        session: session(url),
        control,
        migrationsFolder: MIGRATIONS,
        log: firstLog,
      });
      expect(await first.done).toEqual(tags);
      expect(firstLog.lines).toContainEqual({
        level: "info",
        fields: { migrations: tags },
        message: `Applying ${tags.length} database migrations`,
      });

      const secondLog = recordingLogger();
      const second = startMigrations({
        session: session(url),
        control,
        migrationsFolder: MIGRATIONS,
        log: secondLog,
      });
      expect(await second.done).toEqual([]);
      expect(secondLog.lines).toEqual([]);
    } finally {
      await control.end({ timeout: 5 });
    }
  }, 120_000);

  it("waits for another instance's migration lock before migrating", async () => {
    const url = await freshDatabase("locked");
    const control = postgres(url, { max: 2 });
    const holder = session(url);
    try {
      await holder`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY.toString()}::bigint)`;
      const log = recordingLogger();
      const run = startMigrations({
        session: session(url),
        control,
        migrationsFolder: MIGRATIONS,
        log,
        progressIntervalMs: 200,
      });
      let finished = false;
      void run.done.then(() => {
        finished = true;
      });

      await until(async () =>
        log.lines.some(
          (line) =>
            line.message === "Still waiting for another app-api instance to finish migrating",
        ),
      );
      expect(log.lines[0]?.message).toBe(
        "Waiting for another app-api instance to finish migrating the database",
      );
      expect(finished).toBe(false);
      const [{ exists }] = await control<{ exists: boolean }[]>`
        SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
      `;
      expect(exists).toBe(false);

      await holder`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY.toString()}::bigint)`;
      expect((await run.done).length).toBeGreaterThan(0);
    } finally {
      await holder.end({ timeout: 5 });
      await control.end({ timeout: 5 });
    }
  }, 120_000);

  it("reports the running statement and rolls back at once when cancelled", async () => {
    const url = await freshDatabase("cancelled");
    const control = postgres(url, { max: 2 });
    try {
      const log = recordingLogger();
      const run = startMigrations({
        session: session(url),
        control,
        migrationsFolder: migrationsWithSlowTail(),
        log,
        progressIntervalMs: 200,
      });
      const outcome = run.done.then(
        () => "applied",
        () => "failed",
      );

      await until(async () =>
        log.lines.some(
          (line) =>
            line.message === "Still applying database migrations" &&
            String(line.fields.statement).includes("pg_sleep"),
        ),
      );

      const cancelledAt = Date.now();
      await run.cancel();
      expect(await outcome).toBe("failed");
      expect(Date.now() - cancelledAt).toBeLessThan(10_000);

      const sessions = await control`
        SELECT 1 FROM pg_stat_activity WHERE application_name = 'migration-runner-test'
      `;
      expect(sessions).toHaveLength(0);
      // The whole pending batch ran in one transaction, so nothing was recorded.
      const [{ exists }] = await control<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations) AS exists
      `;
      expect(exists).toBe(false);
      const [{ locked }] = await control<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY.toString()}::bigint) AS locked
      `;
      expect(locked).toBe(true);
    } finally {
      await control.end({ timeout: 5 });
    }
  }, 120_000);
});
