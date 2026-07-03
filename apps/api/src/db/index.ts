import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { envString } from "../utils/env";
import * as schema from "./schema";

const connectionString = envString(
  "DATABASE_URL",
  "postgresql://postgres:postgres@localhost:5432/openmapx",
);

export const sql = postgres(connectionString);

export const db = drizzle(sql, { schema });
