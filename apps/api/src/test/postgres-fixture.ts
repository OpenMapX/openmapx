import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../db/schema";

/** Never consumes DATABASE_URL: all migrations and requests use a disposable database. */
export async function createMigratedPostgresFixture(options: { throughMigration?: number } = {}) {
  const container = await new PostgreSqlContainer(
    "ghcr.io/baosystems/postgis:18-3.6@sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7",
  )
    .withDatabase("openmapx_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .withStartupTimeout(60_000)
    .start();
  const sql = postgres(container.getConnectionUri(), { max: 4 });
  const db = drizzle(sql, { schema });
  let temporaryMigrations: string | undefined;
  const stop = async () => {
    try {
      await sql.end({ timeout: 2 });
    } finally {
      try {
        await container.stop();
      } finally {
        if (temporaryMigrations) await rm(temporaryMigrations, { recursive: true, force: true });
      }
    }
  };
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
    let migrationsFolder = fileURLToPath(new URL("../db/migrations", import.meta.url));
    if (options.throughMigration !== undefined) {
      const journal = JSON.parse(
        await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"),
      ) as { entries: { idx: number; tag: string }[] };
      if (
        !Number.isInteger(options.throughMigration) ||
        !journal.entries.some((e) => e.idx === options.throughMigration)
      )
        throw Error("Invalid fixture migration boundary");
      journal.entries = journal.entries.filter((e) => e.idx <= options.throughMigration!);
      temporaryMigrations = await mkdtemp(join(tmpdir(), "openmapx-migration-fixture-"));
      await mkdir(join(temporaryMigrations, "meta"));
      await writeFile(join(temporaryMigrations, "meta/_journal.json"), JSON.stringify(journal));
      for (const entry of journal.entries)
        await copyFile(
          join(migrationsFolder, `${entry.tag}.sql`),
          join(temporaryMigrations, `${entry.tag}.sql`),
        );
      migrationsFolder = temporaryMigrations;
    }
    await migrate(db, { migrationsFolder });
    return { sql, db, stop, connectionUri: container.getConnectionUri() };
  } catch (error) {
    await stop();
    throw error;
  }
}
