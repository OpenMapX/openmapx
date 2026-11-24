import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  AMBIENT_SCHEMA_VERSION,
  ensureAmbientSchema,
} from "../../src/jobs/ambient-places/schema.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";

const GENERATION = "00000000-0000-4000-8000-000000000001";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")("ambient places schema", () => {
  it("creates typed geometry, one partitioned feature store, checks and conventional names", async () => {
    const pg = await startPostgis();
    try {
      await ensureAmbientSchema(pg.sql);
      expect(
        await pg.sql.unsafe(`SELECT singleton,schema_version FROM ambient_places.state`),
      ).toEqual([{ singleton: 1, schema_version: AMBIENT_SCHEMA_VERSION }]);
      expect(
        await pg.sql.unsafe(
          `SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='ambient_places.features'::regclass AND attname='geom'`,
        ),
      ).toEqual([{ type: "geometry(Geometry,3857)" }]);
      expect(
        await pg.sql.unsafe(`SELECT pg_get_partkeydef('ambient_places.features'::regclass) AS key`),
      ).toEqual([{ key: "LIST (generation)" }]);
      expect(
        await pg.sql.unsafe(
          `SELECT c.relname AS name,c.relkind AS kind FROM pg_class c WHERE c.relnamespace='ambient_places'::regnamespace AND c.relkind IN ('r','p') ORDER BY 1`,
        ),
      ).toEqual([
        { name: "features", kind: "p" },
        { name: "generations", kind: "r" },
        { name: "planet_builds", kind: "r" },
        { name: "state", kind: "r" },
      ]);
      expect(
        (
          await pg.sql.unsafe<{ name: string }[]>(
            `SELECT indexrelid::regclass::TEXT AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='ambient_places'::regnamespace ORDER BY 1`,
          )
        ).map((row) => row.name),
      ).toEqual([
        "ambient_places.features_geom_idx",
        "ambient_places.features_gers_id_idx",
        "ambient_places.features_pkey",
        "ambient_places.generations_pkey",
        "ambient_places.planet_builds_pkey",
        "ambient_places.state_pkey",
      ]);
      expect(
        (
          await pg.sql.unsafe<{ name: string }[]>(
            `SELECT conname AS name FROM pg_constraint WHERE connamespace='ambient_places'::regnamespace AND contype IN ('c','f') ORDER BY 1`,
          )
        ).map((row) => row.name),
      ).toEqual([
        "generations_publication_status_check",
        "generations_storage_check",
        "planet_builds_generation_fkey",
        "planet_builds_status_check",
        "state_active_fkey",
        "state_previous_fkey",
        "state_singleton_check",
      ]);
      const insert = (storage: string, status: string) =>
        pg.sql.unsafe(
          `INSERT INTO ambient_places.generations(id,manifest,storage,publication_status) VALUES($1,'{}',$2,$3)`,
          [GENERATION, storage, status],
        );
      await expect(insert("legacy", "published")).rejects.toThrow(/generations_storage_check/);
      await expect(insert("regional", "retired")).rejects.toThrow(
        /generations_publication_status_check/,
      );
      await insert("regional", "published");
      // A geometry in another projection does not fit the column.
      await expect(
        pg.sql.unsafe(
          `CREATE TABLE ambient_places.features_probe PARTITION OF ambient_places.features FOR VALUES IN ('${GENERATION}');
           INSERT INTO ambient_places.features(generation,id,name,category,rank,min_zoom,tenant,sources,geom)
           VALUES('${GENERATION}','osm:node/1','Clinic','hospital',1,13,false,'osm',ST_SetSRID(ST_MakePoint(6.08,50.77),4326))`,
        ),
      ).rejects.toThrow(/SRID/);
    } finally {
      await pg.stop();
    }
  }, 120_000);

  it("refuses a schema of another version or layout and names the remedy", async () => {
    const pg = await startPostgis();
    const fresh = () => postgres(pg.connectionString, { max: 1 });
    const clients: postgres.Sql[] = [];
    const client = () => {
      const sql = fresh();
      clients.push(sql);
      return sql;
    };
    try {
      await ensureAmbientSchema(pg.sql);
      // Another process finds the current version and creates nothing.
      await ensureAmbientSchema(client());
      await pg.sql.unsafe(`UPDATE ambient_places.state SET schema_version=999`);
      await expect(ensureAmbientSchema(client())).rejects.toThrow(
        `The ambient_places schema has version 999, but this data manager uses version ${AMBIENT_SCHEMA_VERSION}. Drop it with DROP SCHEMA ambient_places CASCADE and build nearby places again.`,
      );
      // A layout from before the version marker.
      await pg.sql.unsafe(`DROP SCHEMA ambient_places CASCADE;
        CREATE SCHEMA ambient_places;
        CREATE TABLE ambient_places.state(singleton SMALLINT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT true);
        INSERT INTO ambient_places.state VALUES(1,true)`);
      await expect(ensureAmbientSchema(client())).rejects.toThrow(
        /has no schema version.*DROP SCHEMA ambient_places CASCADE/,
      );
      // Tables without the state table are an unknown layout too.
      await pg.sql.unsafe(`DROP TABLE ambient_places.state;
        CREATE TABLE ambient_places.features(generation UUID NOT NULL)`);
      await expect(ensureAmbientSchema(client())).rejects.toThrow(/has no schema version/);
      // An empty schema, such as one an operator created, is filled in.
      await pg.sql.unsafe(`DROP TABLE ambient_places.features`);
      await ensureAmbientSchema(client());
      expect(await pg.sql.unsafe(`SELECT schema_version FROM ambient_places.state`)).toEqual([
        { schema_version: AMBIENT_SCHEMA_VERSION },
      ]);
    } finally {
      for (const sql of clients) await sql.end({ timeout: 2 });
      await pg.stop();
    }
  }, 120_000);
});
