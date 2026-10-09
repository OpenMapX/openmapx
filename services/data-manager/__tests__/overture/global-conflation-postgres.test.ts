import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "global conflation workspace",
  () => {
    let pg: PostgisFixture;
    let old: string | undefined;
    let module: typeof import("../../src/jobs/overture/conflate.js");
    let db: typeof import("../../src/db/index.js");
    beforeAll(async () => {
      pg = await startPostgis();
      old = process.env.DATABASE_URL;
      process.env.DATABASE_URL = pg.connectionString;
      vi.resetModules();
      module = await import("../../src/jobs/overture/conflate.js");
      db = await import("../../src/db/index.js");
    }, 120000);
    afterAll(async () => {
      await db?.sql.end({ timeout: 2 });
      await pg?.stop();
      if (old === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = old;
    });
    async function edges(schema: string, count: number, chain: boolean) {
      await pg.sql.unsafe(buildSchemaDDL(schema));
      await pg.sql.unsafe(
        `INSERT INTO "${schema}".places(gers_id,geom,release) SELECT 'g'||i,ST_SetSRID(ST_MakePoint(139.7,35.7),4326),'fixture' FROM generate_series(1,$1) i`,
        [count],
      );
      await pg.sql.unsafe(
        `INSERT INTO "${schema}".poi_conflation_candidate(osm_type,osm_id,gers_id,match_confidence,distance_m,method,evidence,release)
   SELECT 'node',${chain ? "i" : "1"},'g'||i,0.9,0,'fixture','{}','fixture' FROM generate_series(1,$1) i`,
        [count],
      );
    }
    it("preserves exact transitive groups across source ID order and disconnected branches", async () => {
      await edges("overture_global", 10001, true);
      await pg.sql.unsafe(`INSERT INTO overture_global.poi_conflation_candidate(osm_type,osm_id,gers_id,match_confidence,distance_m,method,evidence,release)
   VALUES('node',10001,'g10000',0.8,1,'fixture','{}','fixture'),('node',10000,'g1',0.8,1,'fixture','{}','fixture')`);
      const count = await module.buildConflationComponents("overture_global");
      expect(count).toBe(9999);
      const rows = await pg.sql.unsafe(
        `SELECT count(DISTINCT component_id)::INT AS groups FROM overture_global.poi_conflation_component WHERE osm_id IN (1,10000,10001)`,
      );
      expect(rows[0].groups).toBe(1);
      const result = await module.assignOvertureCandidates({
        schema: "overture_global",
        componentCount: count,
      });
      expect(result.stagedLinks).toBe(10001);
      const [unique] = await pg.sql.unsafe(
        `SELECT count(*)::INT AS n,count(DISTINCT gers_id)::INT AS g,count(DISTINCT osm_id)::INT AS o FROM overture_global.poi_conflation_link_next`,
      );
      expect(unique).toEqual({ n: 10001, g: 10001, o: 10001 });
    }, 120000);
    it("updates more than 10000 component proposals without skipping a page", async () => {
      await edges("overture_pages", 20002, true);
      await pg.sql.unsafe(`INSERT INTO overture_pages.poi_conflation_candidate(osm_type,osm_id,gers_id,match_confidence,distance_m,method,evidence,release)
        SELECT 'node',i+10001,'g'||i,0.8,1,'fixture','{}','fixture' FROM generate_series(1,10001) i`);
      const count = await module.buildConflationComponents("overture_pages");
      expect(count).toBe(10001);
      const [roots] = await pg.sql.unsafe(
        `SELECT count(*)::INT AS n FROM overture_pages.poi_conflation_component a JOIN overture_pages.poi_conflation_component b ON b.osm_id=a.osm_id+10001 AND b.osm_type=a.osm_type WHERE a.osm_id<=10001 AND a.component_id=b.component_id`,
      );
      expect(roots.n).toBe(10001);
    }, 120000);
    it("refuses oversized connected graphs without publishing arbitrary truncated assignments", async () => {
      await edges("overture_dense", 513, false);
      await expect(module.assignOvertureCandidates({ schema: "overture_dense" })).rejects.toThrow(
        /component.*512/i,
      );
      const [counts] = await pg.sql.unsafe(
        `SELECT (SELECT count(*) FROM overture_dense.poi_conflation_link)::INT AS published,(SELECT count(*) FROM overture_dense.poi_conflation_link_next)::INT AS staged`,
      );
      expect(counts).toEqual({ published: 0, staged: 0 });
    }, 120000);
  },
);
