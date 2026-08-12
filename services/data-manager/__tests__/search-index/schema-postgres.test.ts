import { describe, expect, it } from "vitest";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { startPostgis } from "../poi-ingest/_testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_POSTGRES_TESTS !== "1";

describe.skipIf(skipE2e)("search-index schema in PostGIS", () => {
  it("creates constrained tables and usable term/proximity indexes", async () => {
    const pg = await startPostgis();
    try {
      await pg.sql.unsafe(buildSearchIndexSchemaDDL("osm_search__staging"));
      await pg.sql.unsafe(
        `INSERT INTO osm_search__staging.places
          (osm_type, osm_id, name, lat, lng, category, tags, importance)
         VALUES ('node', 1, 'Example', 52.5, 13.4, 'place:city', '{}', 0.9)`,
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
      expect(indexes.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          "idx_osm_search_terms_exact",
          "idx_osm_search_terms_prefix",
          "idx_osm_search_places_geom",
        ]),
      );
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
