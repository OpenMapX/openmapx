import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";

export interface PostgisFixture {
  container: StartedPostgreSqlContainer;
  sql: ReturnType<typeof postgres>;
  connectionString: string;
  stop: () => Promise<void>;
}

// Why `postgis/postgis:16-3.4`: the reader/swap stages depend on the `geom`
// column being `geography(POINT, 4326)` and on `ST_MakeEnvelope` /
// `ST_Intersects`, none of which the vanilla `postgres` image ships. Pinning
// the image keeps test runs reproducible across machines.
export async function startPostgis(): Promise<PostgisFixture> {
  const container = await new PostgreSqlContainer("postgis/postgis:16-3.4")
    .withDatabase("openmapx_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .withStartupTimeout(60_000)
    .start();
  const connectionString = container.getConnectionUri();
  const sql = postgres(connectionString, { max: 2 });
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS postgis`);
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS poi_ingest`);
  return {
    container,
    sql,
    connectionString,
    stop: async () => {
      await sql.end({ timeout: 2 });
      await container.stop();
    },
  };
}
