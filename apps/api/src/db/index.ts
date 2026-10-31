import { assertProductionDatabaseUrlSecret } from "@openmapx/core/deployment-secret-policy";
import { envString } from "@openmapx/core/server-env";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = envString(
  "DATABASE_URL",
  "postgresql://postgres:postgres@localhost:5432/openmapx",
);

assertProductionDatabaseUrlSecret(connectionString, process.env.NODE_ENV);

export const sql = postgres(connectionString, {
  connection: { application_name: "openmapx-api" },
});

export const db = drizzle(sql, { schema });

/**
 * One connection for startup migrations, so the migration lock and the
 * migration transaction share a session. Operators find it in
 * `pg_stat_activity` by its application name.
 */
export function openMigrationSession() {
  return postgres(connectionString, {
    max: 1,
    connection: { application_name: "openmapx-api-migrations" },
  });
}
