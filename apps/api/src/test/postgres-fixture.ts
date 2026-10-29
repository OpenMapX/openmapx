import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../db/schema";

/** Never consumes DATABASE_URL: all migrations and requests use a disposable database. */
export async function createMigratedPostgresFixture() {
  const container = await new PostgreSqlContainer(
    "ghcr.io/baosystems/postgis:18-3.6@sha256:8784f86b3e0e046859c96ea25eb8b10f0b801fd891b99a82b82f28ac4a643db8",
  )
    .withDatabase("openmapx_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .withStartupTimeout(60_000)
    .start();
  const sql = postgres(container.getConnectionUri(), { max: 4 });
  const db = drizzle(sql, { schema });
  const stop = async () => {
    try {
      await sql.end({ timeout: 2 });
    } finally {
      await container.stop();
    }
  };
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../db/migrations", import.meta.url)),
    });
    return { sql, db, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
