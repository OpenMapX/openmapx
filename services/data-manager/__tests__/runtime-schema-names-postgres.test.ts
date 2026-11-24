import { describe, expect, it } from "vitest";
import {
  buildNotablePlacesFinishDDL,
  buildNotablePlacesSchemaDDL,
} from "../src/jobs/notable-places/schema.js";
import { NOTABLE_DISPLAY_LANGUAGES } from "../src/jobs/notable-places/sparql.js";
import {
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
            buildOsmPoisIndexesDDL("overture_places", "osm_pois__staging"),
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
          [["osm_search__staging", "notable_places__staging", "overture_places"]],
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
          "notable_places__staging.places_geom_idx",
          "notable_places__staging.places_kind_check",
          "notable_places__staging.places_lat_check",
          "notable_places__staging.places_lng_check",
          "notable_places__staging.places_pkey",
          "notable_places__staging.places_qid_check",
          "notable_places__staging.places_sitelinks_check",
          "osm_search__staging.index_state_pkey",
          "osm_search__staging.index_state_singleton_check",
          "osm_search__staging.index_state_status_check",
          "osm_search__staging.places_geom_idx",
          "osm_search__staging.places_importance_check",
          "osm_search__staging.places_lat_check",
          "osm_search__staging.places_lng_check",
          "osm_search__staging.places_osm_type_check",
          "osm_search__staging.places_pkey",
          "osm_search__staging.terms_kind_check",
          "osm_search__staging.terms_normalized_term_idx",
          "osm_search__staging.terms_osm_type_osm_id_fkey",
          "osm_search__staging.terms_pkey",
          "overture_places.conflation_state_attempt_count_check",
          "overture_places.conflation_state_phase_check",
          "overture_places.conflation_state_pkey",
          "overture_places.conflation_state_place_count_check",
          "overture_places.conflation_state_singleton_check",
          "overture_places.conflation_state_sources_catalogue_check",
          "overture_places.conflation_state_status_check",
          "overture_places.embedding_cache_pkey",
          "overture_places.osm_pois_category_idx",
          "overture_places.osm_pois_h3_r8_osm_type_osm_id_idx",
          "overture_places.osm_pois_pkey",
          "overture_places.osm_pois__staging_category_idx",
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
  },
);
