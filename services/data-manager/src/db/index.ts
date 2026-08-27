import { assertProductionDatabaseUrlSecret } from "@openmapx/core/deployment-secret-policy";
import {
  feedState,
  jobStages,
  jobs,
  offlinePackageArtifactReferences,
  offlinePackageJobOwners,
  offlinePackageJobs,
  poiFeedState,
} from "@openmapx/db-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@postgis:5432/openmapx";

assertProductionDatabaseUrlSecret(connectionString, process.env.NODE_ENV);

// `postgres-js` is happy with a small connection pool here — the data-manager
// is single-tenant and writes are infrequent (one INSERT per stage).
export const sql = postgres(connectionString, { max: 4 });
export const db = drizzle(sql, {
  schema: {
    jobs,
    jobStages,
    feedState,
    poiFeedState,
    offlinePackageJobs,
    offlinePackageJobOwners,
    offlinePackageArtifactReferences,
  },
});
