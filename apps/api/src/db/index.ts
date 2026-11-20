import { assertProductionDatabaseUrlSecret } from "@openmapx/core/deployment-secret-policy";
import { resolveDatabaseUrl } from "@openmapx/core/service-secret-files";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = resolveDatabaseUrl(
  "postgresql://postgres:postgres@localhost:5432/openmapx",
);

assertProductionDatabaseUrlSecret(connectionString, process.env.NODE_ENV);

/**
 * Sessions, admin, saved data and control work. No statement timeout: control
 * transactions and saved imports have no audited upper bound.
 */
export const sql = postgres(connectionString, {
  max: 10,
  connect_timeout: 10,
  idle_timeout: 60,
  connection: { application_name: "openmapx-api" },
});

/**
 * Public request-path SQL that integrations run through `ctx.db` (POI search,
 * notable places, aliases, Overture). Its own small pool keeps a slow search
 * from taking the connections sessions and admin need, and the server ends a
 * statement after 5 seconds so a pathological query degrades the provider
 * instead of holding a connection.
 */
export const integrationSql = postgres(connectionString, {
  max: 4,
  connect_timeout: 10,
  idle_timeout: 60,
  connection: { application_name: "openmapx-api-integrations", statement_timeout: 5000 },
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
