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

export const sql = postgres(connectionString);

export const db = drizzle(sql, { schema });
