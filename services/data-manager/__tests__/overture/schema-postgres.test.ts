// Requires Docker. CI opts out of testcontainers through the same convention
// as the POI-ingest end-to-end suite.
import { describe, expect, it } from "vitest";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import { startPostgis } from "../poi-ingest/_testcontainer.js";

const skipE2e = process.env.CI === "true" || process.env.SKIP_TESTCONTAINERS === "1";

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
});
