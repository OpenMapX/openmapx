import { feedState, jobStages, jobs, poiFeedState } from "@openmapx/db-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@postgis:5432/openmapx";

// `postgres-js` is happy with a small connection pool here — the data-manager
// is single-tenant and writes are infrequent (one INSERT per stage).
export const sql = postgres(connectionString, { max: 4 });
export const db = drizzle(sql, { schema: { jobs, jobStages, feedState, poiFeedState } });
