import { AMBIENT_PLANET_REGION } from "@openmapx/core/ambient-places";
import { readAmbientManifest } from "@openmapx/core/ambient-places-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as publisher from "../../src/jobs/ambient-places/build.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

const ample = async () => 1024 ** 4;
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "planet ambient publication",
  () => {
    let pg: PostgisFixture;
    beforeEach(async () => {
      pg = await startPostgis();
    }, 120000);
    afterEach(async () => {
      await pg?.stop();
    });
    async function seed(count = 5) {
      await pg.sql.unsafe(
        `DROP SCHEMA IF EXISTS ambient_places CASCADE; DROP SCHEMA IF EXISTS overture_places CASCADE`,
      );
      await pg.sql.unsafe(
        buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
      );
      await pg.sql.unsafe(
        `INSERT INTO osm_search.index_state(region,source_path,source_fingerprint,current_fingerprint,source_file_identity,epoch,status,place_count,started_at,published_at,updated_at)
   VALUES('planet','fixture','fixture','fixture','fixture-file','world-one','ready',$1,now(),now(),now());
   `,
        [count],
      );
      await pg.sql.unsafe(
        `INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance)
   SELECT 'node',i,'世界 Clinic '||i,CASE i%4 WHEN 0 THEN -33.86 WHEN 1 THEN 35.7 WHEN 2 THEN 40.71 ELSE -33.92 END,
    CASE i%4 WHEN 0 THEN 151.2 WHEN 1 THEN 139.7 WHEN 2 THEN -74 ELSE 18.42 END,'amenity/hospital',
    CASE WHEN i=4 THEN '{"disused":"yes"}'::JSONB ELSE '{}'::JSONB END,0.8 FROM generate_series(1,$1) i`,
        [count],
      );
    }
    it("publishes continents, native labels and canonical merged/Overture-only IDs", async () => {
      await seed();
      await pg.sql.unsafe(buildSchemaDDL("overture_places"));
      await pg.sql.unsafe(`INSERT INTO overture_places.places(gers_id,name,names,basic_category,geom,confidence,operating_status,release) VALUES
   ('g-tokyo','Tokyo Clinic','{"common":{"en":"Tokyo Clinic"}}','hospital',ST_SetSRID(ST_MakePoint(139.7,35.7),4326),0.9,'open','2026-09-23.1'),
   ('g-closed','Closed partner',NULL,'hospital',ST_SetSRID(ST_MakePoint(151.2,-33.86),4326),0.9,'open','2026-09-23.1'),
   ('g-brazil','Café São Paulo',NULL,'cafe',ST_SetSRID(ST_MakePoint(-46.63,-23.55),4326),0.9,'open','2026-09-23.1');
   INSERT INTO overture_places.conflation_state(release,region,place_count,places_published_at,status,phase,source_fingerprint,completed_at)
   VALUES('2026-09-23.1','planet',3,now(),'completed','complete','fixture-file',now());
   INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,match_confidence,distance_m,method,evidence,release)
   VALUES('node',1,'g-tokyo',1,0,'fixture','{}','2026-09-23.1'),('node',4,'g-closed',1,0,'fixture','{}','2026-09-23.1')`);
      const result = await publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
        availableBytes: ample,
      });
      expect(result).toMatchObject({
        placeCount: 5,
        region: { coverage: "planet" },
        sources: { osm: { count: 4 }, overture: { count: 3 } },
      });
      const rows = await pg.sql.unsafe(
        `SELECT id,name,name_en,sources FROM ambient_places.features_all ORDER BY id`,
      );
      expect(rows).toHaveLength(5);
      expect(rows.find((r) => r.id === "osm:node/1")).toMatchObject({
        name: "世界 Clinic 1",
        name_en: "Tokyo Clinic",
        sources: "osm,overture",
      });
      expect(rows.find((r) => r.id === "overture:g-brazil")).toMatchObject({
        name: "Café São Paulo",
      });
      expect(rows.some((r) => r.id === "osm:node/4" || r.id === "overture:g-closed")).toBe(false);
      expect((await readAmbientManifest(pg.sql))?.generation).toBe(result.generation);
      const [storage] = await pg.sql.unsafe(
        `SELECT count(*)::INT AS partitions FROM pg_inherits WHERE inhparent='ambient_places.planet_features'::regclass`,
      );
      expect(storage.partitions).toBe(1);
    }, 60000);
    it("commits bounded checkpoints before progress and resumes without duplicate rows", async () => {
      await seed(2001);
      await expect(
        publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes: ample,
          onProgress: async (p) => {
            if (p.processed === 2000) {
              const [row] = await pg.sql.unsafe(
                `SELECT checkpoint->>'processed' AS processed FROM ambient_places.planet_builds`,
              );
              expect(row.processed).toBe("2000");
              expect(await readAmbientManifest(pg.sql)).toBeNull();
              throw new Error("stop after committed page");
            }
          },
        }),
      ).rejects.toThrow("stop after committed page");
      const [stage] = await pg.sql.unsafe(
        `SELECT generation,status,checkpoint FROM ambient_places.planet_builds`,
      );
      expect(stage.status).toBe("failed");
      expect(stage.checkpoint.placeCount).toBe(1999);
      const result = await publisher.resumePlanetPlaces(pg.sql, stage.generation, undefined, {
        availableBytes: ample,
      });
      expect(result.placeCount).toBe(2000);
      const [counts] = await pg.sql.unsafe(
        `SELECT count(*)::INT AS n,count(DISTINCT id)::INT AS unique FROM ambient_places.features_all`,
      );
      expect(counts).toEqual({ n: 2000, unique: 2000 });
    }, 60000);
    it("refuses resume after a same-release link revision, then discards only unpublished storage", async () => {
      await seed();
      await pg.sql.unsafe(buildSchemaDDL("overture_places"));
      await pg.sql.unsafe(`INSERT INTO overture_places.places(gers_id,name,basic_category,geom,release) VALUES('g','Tokyo','hospital',ST_SetSRID(ST_MakePoint(139.7,35.7),4326),'2026-09-23.1');
   INSERT INTO overture_places.conflation_state(release,region,place_count,places_published_at,status,phase,source_fingerprint,completed_at) VALUES('2026-09-23.1','planet',1,now(),'completed','complete','fixture-file',now())`);
      await expect(
        publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes: ample,
          onProgress: () => {
            throw new Error("stop");
          },
        }),
      ).rejects.toThrow("stop");
      const [stage] = await pg.sql.unsafe(`SELECT generation FROM ambient_places.planet_builds`);
      await pg.sql.unsafe(
        `UPDATE overture_places.conflation_state SET attempt_count=attempt_count+1,completed_at=clock_timestamp()`,
      );
      await expect(
        publisher.resumePlanetPlaces(pg.sql, stage.generation, undefined, {
          availableBytes: ample,
        }),
      ).rejects.toThrow(/sources changed/i);
      await publisher.discardPlanetPlaces(pg.sql, stage.generation);
      const [empty] = await pg.sql.unsafe(
        `SELECT count(*)::INT AS n FROM ambient_places.generations`,
      );
      expect(empty.n).toBe(0);
      const complete = await publisher.buildAmbientPlaces(
        pg.sql,
        AMBIENT_PLANET_REGION,
        undefined,
        { availableBytes: ample },
      );
      await expect(publisher.discardPlanetPlaces(pg.sql, complete.generation)).rejects.toThrow(
        /published/i,
      );
    }, 60000);
    it("holds source/pointer admission between commits and preserves the checkpoint after backend loss", async () => {
      await seed(2001);
      await expect(
        publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes: ample,
          onProgress: async (p) => {
            if (p.processed !== 2000) return;
            await expect(publisher.setAmbientEnabled(pg.sql, false)).rejects.toThrow(/running/);
            for (const key of [1, 2]) {
              await pg.sql.begin(async (tx) => {
                const [lock] = await tx.unsafe(
                  "SELECT pg_try_advisory_xact_lock(1330466120,$1) AS locked",
                  [key],
                );
                expect(lock.locked).toBe(false);
              });
            }
            const [backend] = await pg.sql.unsafe(
              "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=139399 AND granted",
            );
            await pg.sql.unsafe("SELECT pg_terminate_backend($1)", [backend.pid]);
          },
        }),
      ).rejects.toThrow();
      const [stage] = await pg.sql.unsafe(
        "SELECT generation,checkpoint FROM ambient_places.planet_builds",
      );
      expect(stage.checkpoint.processed).toBe(2000);
      expect(await readAmbientManifest(pg.sql)).toBeNull();
      const result = await publisher.resumePlanetPlaces(pg.sql, stage.generation, undefined, {
        availableBytes: ample,
      });
      expect(result.placeCount).toBe(2000);
    }, 60000);
    it("fails closed on count mismatch, policy revision and output admission", async () => {
      await seed();
      const active = await publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
        availableBytes: ample,
      });
      await pg.sql.unsafe("UPDATE osm_search.index_state SET place_count=6");
      await expect(
        publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes: ample,
        }),
      ).rejects.toThrow(/count validation/);
      const [stage] = await pg.sql.unsafe(
        "SELECT generation FROM ambient_places.planet_builds WHERE status='failed'",
      );
      await pg.sql.unsafe(
        "UPDATE ambient_places.generations SET manifest=jsonb_set(manifest,'{policyVersion}','999') WHERE id=$1",
        [stage.generation],
      );
      await expect(
        publisher.resumePlanetPlaces(pg.sql, stage.generation, undefined, {
          availableBytes: ample,
        }),
      ).rejects.toThrow(/policy changed/);
      await publisher.discardPlanetPlaces(pg.sql, stage.generation);
      await pg.sql.unsafe("UPDATE osm_search.index_state SET place_count=5");
      const previous = process.env.AMBIENT_PLANET_MAX_PLACES;
      process.env.AMBIENT_PLANET_MAX_PLACES = "1";
      try {
        await expect(
          publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
            availableBytes: ample,
          }),
        ).rejects.toThrow(/exceeds 1 places/);
      } finally {
        if (previous === undefined) delete process.env.AMBIENT_PLANET_MAX_PLACES;
        else process.env.AMBIENT_PLANET_MAX_PLACES = previous;
      }
      expect((await readAmbientManifest(pg.sql))?.generation).toBe(active.generation);
      const [count] = await pg.sql.unsafe(
        "SELECT count(*)::INT AS n FROM ambient_places.features_all WHERE generation<>$1",
        [active.generation],
      );
      expect(count.n).toBe(0);
    }, 60000);
    it("retires expired planet partitions, retains leases and supports pointer rollback", async () => {
      await seed();
      const build = () =>
        publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes: ample,
        });
      const first = await build();
      const second = await build();
      const third = await build();
      await publisher.rollbackAmbientPlaces(pg.sql);
      expect((await readAmbientManifest(pg.sql))?.generation).toBe(second.generation);
      await publisher.rollbackAmbientPlaces(pg.sql);
      expect((await readAmbientManifest(pg.sql))?.generation).toBe(third.generation);
      await pg.sql.unsafe(
        "UPDATE ambient_places.generations SET cache_lease_until=now()-interval '1 second' WHERE id=$1",
        [first.generation],
      );
      const fourth = await build();
      const rows = await pg.sql.unsafe("SELECT id FROM ambient_places.generations");
      expect(rows.map((r) => r.id)).toEqual(
        expect.arrayContaining([second.generation, third.generation, fourth.generation]),
      );
      expect(rows.some((r) => r.id === first.generation)).toBe(false);
      const [partitions] = await pg.sql.unsafe(
        "SELECT count(*)::INT AS n FROM pg_inherits WHERE inhparent='ambient_places.planet_features'::regclass",
      );
      expect(partitions.n).toBe(3);
    }, 60000);
    it("requires complete matching planet sources and reports disk failure without switching active", async () => {
      await seed();
      const active = await publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
        availableBytes: ample,
      });
      await pg.sql.unsafe(`UPDATE osm_search.index_state SET ambient_source_version=1`);
      await expect(
        publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes: ample,
        }),
      ).rejects.toThrow(/format|rebuild/i);
      await pg.sql.unsafe(
        `UPDATE osm_search.index_state SET ambient_source_version=2,region='europe/germany'`,
      );
      await expect(
        publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes: ample,
        }),
      ).rejects.toThrow(/planet/i);
      await pg.sql.unsafe(`UPDATE osm_search.index_state SET region='planet'`);
      await expect(
        publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes: async () => 1,
        }),
      ).rejects.toThrow(/disk/i);
      await pg.sql.unsafe("UPDATE osm_search.index_state SET place_count=0");
      await expect(
        publisher.buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes: ample,
        }),
      ).rejects.toThrow(/empty/i);
      expect((await readAmbientManifest(pg.sql))?.generation).toBe(active.generation);
    }, 60000);
  },
);
