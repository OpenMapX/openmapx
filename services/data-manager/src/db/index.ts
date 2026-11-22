import { assertProductionDatabaseUrlSecret } from "@openmapx/core/deployment-secret-policy";
import { resolveDatabaseUrl } from "@openmapx/core/service-secret-files";
import {
  feedState,
  jobStages,
  jobs,
  offlinePackageArtifactReferences,
  offlinePackageJobOwners,
  offlinePackageJobs,
} from "@openmapx/db-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString = resolveDatabaseUrl(
  "postgresql://postgres:postgres@openmapx-postgis:5432/openmapx",
);

assertProductionDatabaseUrlSecret(connectionString, process.env.NODE_ENV);

/** A separate pool whose connections carry `applicationName`. Each data
 * execution's worker gets its own, so cancelling the worker reaches exactly
 * its queries. */
export function connectDatabase(applicationName: string): postgres.Sql {
  return postgres(connectionString, { max: 4, connection: { application_name: applicationName } });
}

// `postgres-js` is happy with a small connection pool here — the data-manager
// is single-tenant and writes are infrequent (one INSERT per stage).
export const sql = connectDatabase("openmapx-data-manager");
export const db = drizzle(sql, {
  schema: {
    jobs,
    jobStages,
    feedState,
    offlinePackageJobs,
    offlinePackageJobOwners,
    offlinePackageArtifactReferences,
  },
});
