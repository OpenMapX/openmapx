import { resolveDatabaseUrl } from "@openmapx/core/service-secret-files";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    // The same connection the API uses: its own role, with the password from
    // DATABASE_PASSWORD_FILE when that is set.
    url: resolveDatabaseUrl("postgresql://postgres:postgres@localhost:5432/openmapx"),
  },
  extensionsFilters: ["postgis"],
});
