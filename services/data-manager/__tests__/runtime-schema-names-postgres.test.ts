import { describe, expect, it } from "vitest";
import {
  buildNotablePlacesFinishDDL,
  buildNotablePlacesSchemaDDL,
} from "../src/jobs/notable-places/schema.js";
import { NOTABLE_DISPLAY_LANGUAGES } from "../src/jobs/notable-places/sparql.js";
import {
  buildEmbeddingCacheDDL,
  buildOsmPoisIndexesDDL,
  buildOsmPoisTableDDL,
  buildSchemaDDL,
} from "../src/jobs/overture/schema.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../src/jobs/search-index/schema.js";
import { startPostgis } from "./helpers/postgis-testcontainer.js";

const SUFFIX = { index: "idx", p: "pkey", u: "key", f: "fkey", c: "check" } as const;

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "runtime-built schema object names",
  () => {
    it("name every index and constraint <table>_<cols>_<kind>", async () => {
      const pg = await startPostgis();
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search__staging") +
            buildSearchIndexIndexesDDL("osm_search__staging") +
            buildNotablePlacesSchemaDDL("notable_places__staging") +
            buildNotablePlacesFinishDDL("notable_places__staging", NOTABLE_DISPLAY_LANGUAGES) +
            buildSchemaDDL("overture_places") +
            buildOsmPoisTableDDL("overture_places", "osm_pois__staging") +
            buildOsmPoisIndexesDDL("overture_places", "osm_pois__staging") +
            buildEmbeddingCacheDDL(),
        );
        const objects = await pg.sql.unsafe<
          { schema: string; table: string; name: string; kind: keyof typeof SUFFIX }[]
        >(
          `SELECT n.nspname AS schema, t.relname AS table, i.relname AS name, 'index' AS kind
             FROM pg_index x
             JOIN pg_class i ON i.oid = x.indexrelid
             JOIN pg_class t ON t.oid = x.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = ANY($1::TEXT[])
              AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
           UNION ALL
           SELECT n.nspname, t.relname, c.conname, c.contype::TEXT
             FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = ANY($1::TEXT[]) AND c.contype <> 'n'
            ORDER BY 1, 2, 3`,
          [
            [
              "osm_search__staging",
              "notable_places__staging",
              "overture_embeddings",
              "overture_places",
            ],
          ],
        );
        const misnamed = objects.filter(
          ({ table, name, kind }) =>
            !new RegExp(`^${table}_(?:[a-z0-9_]+_)?${SUFFIX[kind]}$`).test(name) ||
            (kind !== "p" && name === `${table}_${SUFFIX[kind]}`),
        );
        expect(misnamed).toEqual([]);
        expect(objects.map(({ schema, name }) => `${schema}.${name}`)).toEqual([
          "notable_places__staging.descriptions_pkey",
          "notable_places__staging.descriptions_qid_fkey",
          "notable_places__staging.index_state_pkey",
          "notable_places__staging.index_state_singleton_check",
          "notable_places__staging.index_state_status_check",
          "notable_places__staging.labels_pkey",
          "notable_places__staging.labels_qid_fkey",
          "notable_places__staging.names_normalized_idx",
          "notable_places__staging.names_normalized_trgm_idx",
          "notable_places__staging.names_pkey",
          "notable_places__staging.names_qid_fkey",
          "notable_places__staging.places_fame_check",
          "notable_places__staging.places_geom_check",
          "notable_places__staging.places_geom_idx",
          "notable_places__staging.places_kind_check",
          "notable_places__staging.places_pkey",
          "notable_places__staging.places_qid_check",
          "notable_places__staging.places_sitelinks_check",
          "osm_search__staging.index_state_pkey",
          "osm_search__staging.index_state_singleton_check",
          "osm_search__staging.index_state_status_check",
          "osm_search__staging.places_geom_check",
          "osm_search__staging.places_geom_idx",
          "osm_search__staging.places_importance_check",
          "osm_search__staging.places_osm_type_check",
          "osm_search__staging.places_pkey",
          "osm_search__staging.terms_kind_check",
          "osm_search__staging.terms_normalized_term_idx",
          "osm_search__staging.terms_osm_type_osm_id_fkey",
          "osm_search__staging.terms_pkey",
          "overture_embeddings.embedding_cache_pkey",
          "overture_places.conflation_state_attempt_count_check",
          "overture_places.conflation_state_phase_check",
          "overture_places.conflation_state_pkey",
          "overture_places.conflation_state_place_count_check",
          "overture_places.conflation_state_singleton_check",
          "overture_places.conflation_state_sources_catalogue_check",
          "overture_places.conflation_state_status_check",
          "overture_places.osm_pois_category_idx",
          "overture_places.osm_pois_geom_check",
          "overture_places.osm_pois_geom_idx",
          "overture_places.osm_pois_h3_r8_osm_type_osm_id_idx",
          "overture_places.osm_pois_pkey",
          "overture_places.osm_pois__staging_category_idx",
          "overture_places.osm_pois__staging_geom_check",
          "overture_places.osm_pois__staging_geom_idx",
          "overture_places.osm_pois__staging_h3_r8_osm_type_osm_id_idx",
          "overture_places.osm_pois__staging_pkey",
          "overture_places.places_basic_category_idx",
          "overture_places.places_geom_idx",
          "overture_places.places_h3_r8_idx",
          "overture_places.places_pkey",
          "overture_places.places_taxonomy_alternates_idx",
          "overture_places.places_taxonomy_hierarchy_idx",
          "overture_places.places_taxonomy_primary_idx",
          "overture_places.poi_conflation_candidate_distance_m_check",
          "overture_places.poi_conflation_candidate_gers_id_fkey",
          "overture_places.poi_conflation_candidate_gers_id_idx",
          "overture_places.poi_conflation_candidate_match_confidence_check",
          "overture_places.poi_conflation_candidate_pkey",
          "overture_places.poi_conflation_component_component_id_osm_type_osm_id_idx",
          "overture_places.poi_conflation_component_pkey",
          "overture_places.poi_conflation_link_distance_m_check",
          "overture_places.poi_conflation_link_gers_id_key",
          "overture_places.poi_conflation_link_match_confidence_check",
          "overture_places.poi_conflation_link_pkey",
          "overture_places.poi_conflation_link_next_distance_m_check",
          "overture_places.poi_conflation_link_next_gers_id_key",
          "overture_places.poi_conflation_link_next_match_confidence_check",
          "overture_places.poi_conflation_link_next_pkey",
        ]);
      } finally {
        await pg.stop();
      }
    }, 120_000);

    it("store points as indexed geometry(Point, 4326) without coordinate columns", async () => {
      const pg = await startPostgis();
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") +
            buildSearchIndexIndexesDDL("osm_search") +
            buildNotablePlacesSchemaDDL("notable_places") +
            buildNotablePlacesFinishDDL("notable_places", NOTABLE_DISPLAY_LANGUAGES) +
            buildSchemaDDL("overture_places"),
        );
        const points = await pg.sql.unsafe(
          `SELECT f_table_schema AS schema, f_table_name AS table, f_geometry_column AS column,
                  type, srid
             FROM geometry_columns
            WHERE f_table_schema IN ('osm_search', 'notable_places', 'overture_places')
            ORDER BY 1, 2`,
        );
        expect(points).toEqual([
          { schema: "notable_places", table: "places", column: "geom", type: "POINT", srid: 4326 },
          { schema: "osm_search", table: "places", column: "geom", type: "POINT", srid: 4326 },
          {
            schema: "overture_places",
            table: "osm_pois",
            column: "geom",
            type: "POINT",
            srid: 4326,
          },
          { schema: "overture_places", table: "places", column: "geom", type: "POINT", srid: 4326 },
        ]);
        const leftovers = await pg.sql.unsafe(
          `SELECT table_schema, table_name, column_name FROM information_schema.columns
            WHERE table_schema IN ('osm_search', 'notable_places', 'overture_places')
              AND (column_name IN ('lat', 'lng') OR udt_name = 'geography')`,
        );
        expect(leftovers).toEqual([]);
        const gist = await pg.sql.unsafe<{ index: string }[]>(
          `SELECT n.nspname || '.' || i.relname AS index
             FROM pg_index x
             JOIN pg_class i ON i.oid = x.indexrelid
             JOIN pg_class t ON t.oid = x.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_am am ON am.oid = i.relam
            WHERE am.amname = 'gist' AND n.nspname IN ('osm_search', 'notable_places', 'overture_places')
            ORDER BY 1`,
        );
        expect(gist.map((row) => row.index)).toEqual([
          "notable_places.places_geom_idx",
          "osm_search.places_geom_idx",
          "overture_places.osm_pois_geom_idx",
          "overture_places.places_geom_idx",
        ]);
        // Coordinates outside WGS 84 bounds are refused, as they were before.
        await expect(
          pg.sql.unsafe(
            `INSERT INTO osm_search.places (osm_type, osm_id, name, geom, tags, importance)
             VALUES ('node', 1, 'Off the map', ST_Point(13.4, 91, 4326), '{}', 0.5)`,
          ),
        ).rejects.toMatchObject({ code: "23514", constraint_name: "places_geom_check" });
      } finally {
        await pg.stop();
      }
    }, 120_000);
  },
);
