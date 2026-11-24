import { describe, expect, it } from "vitest";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

describe.skipIf(skipE2e)("search-index schema in PostGIS", () => {
  it("creates constrained tables and usable term/proximity indexes", async () => {
    const pg = await startPostgis();
    try {
      await pg.sql.unsafe(buildSearchIndexSchemaDDL("osm_search__staging"));
      await pg.sql.unsafe(
        `INSERT INTO osm_search__staging.places
          (osm_type, osm_id, name, geom, category, tags, importance)
         VALUES ('node', 1, 'Example', ST_Point(13.4, 52.5, 4326), 'place:city', '{}', 0.9)`,
      );
      await pg.sql.unsafe(
        `INSERT INTO osm_search__staging.terms
          (osm_type, osm_id, normalized_term, display_value, kind, namespace)
         VALUES ('node', 1, 'ex', 'EX', 'explicit_alias', 'short_name')`,
      );
      await pg.sql.unsafe(buildSearchIndexIndexesDDL("osm_search__staging"));
      const indexes = await pg.sql.unsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE schemaname='osm_search__staging'`,
      );
      expect(indexes.map((row) => row.indexname).sort()).toEqual([
        "index_state_pkey",
        "places_geom_idx",
        "places_pkey",
        "publication_fence_pkey",
        "terms_normalized_term_idx",
        "terms_pkey",
      ]);
      // The provider's exact-or-prefix predicate uses the one pattern index.
      await pg.sql.unsafe(`ANALYZE osm_search__staging.terms`);
      const plan = await pg.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL enable_seqscan = off`);
        return tx.unsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN SELECT * FROM osm_search__staging.terms
            WHERE normalized_term = 'ex' OR normalized_term LIKE 'ex' || '%'`,
        );
      });
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toContain("terms_normalized_term_idx");
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
