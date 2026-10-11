// Requires Docker. The dedicated database gate opts in explicitly; once opted
// in, missing infrastructure is fatal.
import { describe, expect, it } from "vitest";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

describe.skipIf(skipE2e)("Overture schema in PostGIS", () => {
  it("creates the scalable conflation tables and enforces one release-local state row", async () => {
    const pg = await startPostgis();
    try {
      await pg.sql.unsafe(buildSchemaDDL("overture_places"));
      await pg.sql.unsafe(
        `INSERT INTO overture_places.conflation_state (release, region, place_count, status)
         VALUES ('2026-07-22.0', 'europe/germany/berlin', 100, 'pending')`,
      );
      await expect(
        pg.sql.unsafe(
          `INSERT INTO overture_places.conflation_state (release, region, place_count, status)
           VALUES ('2026-07-22.0', 'europe/germany/berlin', 100, 'pending')`,
        ),
      ).rejects.toThrow();

      const rows = await pg.sql.unsafe<{ relname: string; persistence: string }[]>(
        `SELECT relname, relpersistence AS persistence
         FROM pg_class
         WHERE oid IN (
           'overture_places.poi_conflation_candidate'::regclass,
           'overture_places.poi_conflation_link_next'::regclass,
           'overture_places.poi_conflation_component'::regclass
         )
         ORDER BY relname`,
      );
      expect(rows).toEqual([
        { relname: "poi_conflation_candidate", persistence: "p" },
        { relname: "poi_conflation_component", persistence: "u" },
        { relname: "poi_conflation_link_next", persistence: "p" },
      ]);
      const [h3] = await pg.sql.unsafe<{ is_nullable: string }[]>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'overture_places' AND table_name = 'osm_pois'
           AND column_name = 'h3_r8'`,
      );
      expect(h3?.is_nullable).toBe("NO");
    } finally {
      await pg.stop();
    }
  }, 120_000);
  it("uses one equivalent unique B-tree and preserves link constraints and lookups", async () => {
    const pg = await startPostgis();
    try {
      await pg.sql.unsafe(buildSchemaDDL("overture_places"));
      const indexes = await pg.sql.unsafe<
        {
          name: string;
          method: string;
          key: string;
          opclass: string;
          same_collation: boolean;
          predicate: string | null;
          expression: string | null;
          valid: boolean;
          ready: boolean;
          live: boolean;
          unique: boolean;
          backs_constraint: boolean;
        }[]
      >(`
        SELECT c.relname AS name, am.amname AS method,
          pg_get_indexdef(i.indexrelid, 1, true) AS key, op.opcname AS opclass,
          i.indcollation[0] = a.attcollation AS same_collation,
          pg_get_expr(i.indpred, i.indrelid) AS predicate,
          pg_get_expr(i.indexprs, i.indrelid) AS expression,
          i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
          i.indisunique AS unique,
          EXISTS (SELECT 1 FROM pg_constraint con
            WHERE con.conindid = i.indexrelid AND con.contype = 'u') AS backs_constraint
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attname = 'gers_id'
        JOIN pg_opclass op ON op.oid = i.indclass[0]
        WHERE i.indrelid = 'overture_places.poi_conflation_link'::regclass
          AND i.indnkeyatts = 1 AND i.indnatts = 1 AND a.attnum = ANY(i.indkey)
        ORDER BY c.relname
      `);
      for (const index of indexes) {
        expect(index).toMatchObject({
          method: "btree",
          key: "gers_id",
          opclass: "text_ops",
          same_collation: true,
          predicate: null,
          expression: null,
          valid: true,
          ready: true,
          live: true,
        });
      }
      expect(indexes).toHaveLength(1);
      expect(indexes[0]).toMatchObject({ unique: true, backs_constraint: true });
      const foreignKeys = await pg.sql.unsafe<{ definition: string; validated: boolean }[]>(`
        SELECT pg_get_constraintdef(oid) AS definition, convalidated AS validated
        FROM pg_constraint
        WHERE conrelid = 'overture_places.poi_conflation_link'::regclass AND contype = 'f'
      `);
      expect(foreignKeys).toEqual([
        {
          definition:
            "FOREIGN KEY (gers_id) REFERENCES overture_places.places(gers_id) ON DELETE CASCADE",
          validated: true,
        },
      ]);
      await pg.sql.unsafe(`
        INSERT INTO overture_places.places (gers_id, name, geom, release)
        VALUES ('gers-a', 'Fixture A', ST_SetSRID(ST_Point(7, 51), 4326), 'fixture'),
               ('gers-b', 'Fixture B', ST_SetSRID(ST_Point(8, 52), 4326), 'fixture');
        INSERT INTO overture_places.poi_conflation_link
          (osm_type, osm_id, gers_id, match_confidence, distance_m, method, evidence, release)
        VALUES ('node', 1, 'gers-a', 1, 0, 'fixture', '{}', 'fixture'),
               ('node', 2, 'gers-b', 1, 0, 'fixture', '{}', 'fixture')
      `);
      await expect(
        pg.sql.unsafe(`
        INSERT INTO overture_places.poi_conflation_link
          (osm_type, osm_id, gers_id, match_confidence, distance_m, method, evidence, release)
        VALUES ('node', 3, 'gers-a', 1, 0, 'fixture', '{}', 'fixture')
      `),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pg.sql.unsafe(`
        INSERT INTO overture_places.poi_conflation_link
          (osm_type, osm_id, gers_id, match_confidence, distance_m, method, evidence, release)
        VALUES ('node', 3, 'missing', 1, 0, 'fixture', '{}', 'fixture')
      `),
      ).rejects.toMatchObject({ code: "23503" });
      expect(
        await pg.sql.unsafe(`
        SELECT l.osm_type, l.osm_id::text, p.name
        FROM overture_places.poi_conflation_link l
        JOIN overture_places.places p USING (gers_id)
        WHERE l.gers_id = 'gers-a'
      `),
      ).toEqual([{ osm_type: "node", osm_id: "1", name: "Fixture A" }]);
      await pg.sql.unsafe("DELETE FROM overture_places.places WHERE gers_id = 'gers-a'");
      expect(
        await pg.sql.unsafe(`
        SELECT osm_id::text, gers_id FROM overture_places.poi_conflation_link
      `),
      ).toEqual([{ osm_id: "2", gers_id: "gers-b" }]);
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
