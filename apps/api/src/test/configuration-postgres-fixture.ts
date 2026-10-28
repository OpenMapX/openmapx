import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";

/** An explicitly supplied owned/migrated synthetic database. No migrations run.
 * Only empty fixture copies of the current configuration/job tables are created and removed. */
export async function createConfigurationPostgresFixture() {
  const url = process.env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL;
  if (!url) throw Error("Explicit owned synthetic PostgreSQL connection required");
  const name = `task012_${randomUUID().replaceAll("-", "")}`;
  const control = postgres(url, { max: 1, onnotice: () => {} });
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    await control.unsafe(`CREATE SCHEMA "${name}"`);
    for (const table of [
      "admin_job",
      "admin_job_log",
      "admin_audit_log",
      "capability_binding",
      "service_config",
      "integration_config",
      "service_secret",
      "integration_secret",
    ])
      await control.unsafe(
        `CREATE TABLE "${name}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    sql = postgres(url, {
      max: 6,
      connection: { search_path: name, application_name: "openmapx-task012-test" },
    });
    const ownedSql = sql;
    return {
      sql: ownedSql,
      db: drizzle(ownedSql, { schema }),
      schema: name,
      async stop() {
        await ownedSql.end({ timeout: 2 });
        try {
          await control.unsafe(`DROP SCHEMA "${name}" CASCADE`);
        } finally {
          await control.end({ timeout: 2 });
        }
      },
    };
  } catch (error) {
    await sql?.end({ timeout: 2 });
    try {
      await control.unsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    } finally {
      await control.end({ timeout: 2 });
    }
    throw error;
  }
}
