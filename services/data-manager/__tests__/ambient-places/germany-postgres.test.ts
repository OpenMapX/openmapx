import { VectorTile } from "@mapbox/vector-tile";
import { AMBIENT_GERMANY_REGION } from "@openmapx/core/ambient-places";
import {
  readAmbientManifest,
  readAmbientPlaceByGers,
  readAmbientTile,
} from "@openmapx/core/ambient-places-server";
import { PbfReader } from "pbf";
import { describe, expect, it } from "vitest";
import { buildAmbientPlaces, rollbackAmbientPlaces } from "../../src/jobs/ambient-places/build.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

const regional = {
  name: "Aachen",
  bounds: [5.9, 50.65, 6.3, 50.95] as [number, number, number, number],
};
const ampleSpace = async () => 100 * 1024 ** 3;
async function seed(pg: PostgisFixture) {
  await pg.sql.unsafe(
    buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
  );
  await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,place_count,started_at,published_at,updated_at)
    VALUES(1,'europe/germany','fixture','fixture','fixture','country-one','ready',1,now(),now(),now());
    INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance)
    VALUES('node',1,'Aachen clinic',50.77,6.08,'amenity/hospital','{}',0.8)`);
}
async function tile(pg: PostgisFixture, generation: string, lng: number, lat: number) {
  const z = 16;
  const x = Math.floor(((lng + 180) / 360) * 2 ** z);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
  const bytes = await readAmbientTile(pg.sql, generation, z, x, y);
  return {
    bytes,
    layer: bytes?.length ? new VectorTile(new PbfReader(bytes)).layers.ambient_places : undefined,
  };
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "Germany ambient publication",
  () => {
    it("streams more than 100000 places once, serves distant tiles and keeps old regional bytes", async () => {
      const pg = await startPostgis();
      try {
        await seed(pg);
        const before = await buildAmbientPlaces(pg.sql, regional);
        const beforeTile = await tile(pg, before.generation, 6.08, 50.77);
        await pg.sql.unsafe(`INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance)
        SELECT 'node',id,'Clinic '||id,CASE WHEN id%2=0 THEN 52.52 ELSE 50.77 END,
        CASE WHEN id%2=0 THEN 13.405 ELSE 6.08 END,'amenity/hospital','{}',0.8 FROM generate_series(2,100000) AS id;
        INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance)
        VALUES('way',9007199254740993,'Munich clinic',48.137,11.575,'amenity/hospital','{}',0.8);
        UPDATE osm_search.index_state SET place_count=100001`);
        const progress: { processed: number; batches: number; placeCount: number }[] = [];
        const country = await buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
          availableBytes: ampleSpace,
          onProgress: (p) => {
            progress.push(p);
          },
        });
        expect(country).toMatchObject({
          placeCount: 100001,
          region: { coverage: "germany" },
          sources: { osm: { count: 100001 } },
        });
        expect(progress.at(-1)).toMatchObject({
          processed: 100001,
          batches: 51,
          placeCount: 100001,
        });
        const [counts] = await pg.sql.unsafe(
          `SELECT count(*)::INT AS count,count(DISTINCT id)::INT AS unique FROM ambient_places.features WHERE generation=$1`,
          [country.generation],
        );
        expect(counts).toEqual({ count: 100001, unique: 100001 });
        expect((await tile(pg, country.generation, 13.405, 52.52)).layer?.length).toBeGreaterThan(
          0,
        );
        expect(
          (await tile(pg, country.generation, 11.575, 48.137)).layer?.feature(0).properties.id,
        ).toBe("osm:way/9007199254740993");
        expect((await tile(pg, before.generation, 6.08, 50.77)).bytes).toEqual(beforeTile.bytes);
        const [indexes] =
          await pg.sql.unsafe(`SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='ambient_places' AND indexdef LIKE '%USING gist (generation,%') AS qualified,
        EXISTS(SELECT 1 FROM geometry_columns WHERE f_table_schema='ambient_places') AS exposed`);
        expect(indexes).toEqual({ qualified: true, exposed: false });
        await rollbackAmbientPlaces(pg.sql);
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(before.generation);
        expect(
          (await tile(pg, country.generation, 11.575, 48.137)).layer?.feature(0).properties.id,
        ).toBe("osm:way/9007199254740993");
      } finally {
        await pg.stop();
      }
    }, 120_000);

    it("keeps linked policy, names and canonical IDs across envelope boundaries and missing index rows", async () => {
      const pg = await startPostgis();
      try {
        await seed(pg);
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(`INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES
        ('way',2,'Outside authoritative',50,5.79,'amenity/hospital','{}',1),
        ('relation',3,'Closed authoritative',52.52,13.4,'shop/bakery','{"disused":"yes"}',1);
        UPDATE osm_search.index_state SET place_count=3;
        INSERT INTO overture_places.places(gers_id,name,names,geom,basic_category,confidence,operating_status,release) VALUES
        ('gers-a','Translated clinic','{"common":{"en":"Translated clinic"}}',ST_SetSRID(ST_MakePoint(5.79,50),4326),'hospital',0.9,'open','2026-09-23.1'),
        ('gers-b','Outside counterpart',NULL,ST_SetSRID(ST_MakePoint(6.08,50.77),4326),'hospital',0.9,'open','2026-09-23.1'),
        ('gers-c','Closed counterpart',NULL,ST_SetSRID(ST_MakePoint(13.4,52.52),4326),'bakery',0.9,'open','2026-09-23.1'),
        ('gers-d','Missing-index clinic',NULL,ST_SetSRID(ST_MakePoint(11.575,48.137),4326),'hospital',0.9,'open','2026-09-23.1');
        INSERT INTO overture_places.conflation_state(singleton,release,region,place_count,places_published_at,status,phase)
        VALUES(1,'2026-09-23.1','europe/germany',4,now(),'completed','complete');
        INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release)
        VALUES('node',1,'gers-a',0.9,1,0,'fixture','{}','2026-09-23.1'),('way',2,'gers-b',0.9,1,0,'fixture','{}','2026-09-23.1'),
        ('relation',3,'gers-c',0.9,1,0,'fixture','{}','2026-09-23.1'),('way',99,'gers-d',0.9,1,0,'fixture','{}','2026-09-23.1')`);
        const country = await buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
          availableBytes: ampleSpace,
        });
        expect(country.placeCount).toBe(2);
        const linked = (await readAmbientPlaceByGers(pg.sql, "gers-a"))?.place;
        expect(linked).toMatchObject({
          id: "osm:node/1",
          names: { en: "Translated clinic" },
          sources: "osm,overture",
        });
        expect(linked?.coordinates[0]).toBeCloseTo(6.08, 8);
        expect(linked?.coordinates[1]).toBeCloseTo(50.77, 8);
        expect(await readAmbientPlaceByGers(pg.sql, "gers-b")).toBeNull();
        expect(await readAmbientPlaceByGers(pg.sql, "gers-c")).toBeNull();
        expect((await readAmbientPlaceByGers(pg.sql, "gers-d"))?.place.id).toBe("osm:way/99");
      } finally {
        await pg.stop();
      }
    }, 120_000);

    it("rejects regional sources and mismatched releases instead of advertising Germany coverage", async () => {
      const pg = await startPostgis();
      try {
        await seed(pg);
        await pg.sql.unsafe(
          `UPDATE osm_search.index_state SET region='europe/germany/nordrhein-westfalen'`,
        );
        await expect(
          buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
            availableBytes: ampleSpace,
          }),
        ).rejects.toThrow(/Germany.*OSM|OSM.*Germany/);
        await pg.sql.unsafe(`UPDATE osm_search.index_state SET region='europe/germany'`);
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(`INSERT INTO overture_places.conflation_state(singleton,release,region,place_count,places_published_at,status,phase)
        VALUES(1,'2026-09-23.1','europe/germany/nordrhein-westfalen',1,now(),'completed','complete');
        INSERT INTO overture_places.places(gers_id,name,geom,basic_category,confidence,operating_status,release)
        VALUES('gers','Cafe',ST_SetSRID(ST_MakePoint(13,52),4326),'cafe',0.9,'open','wrong-release')`);
        await expect(
          buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
            availableBytes: ampleSpace,
          }),
        ).rejects.toThrow(/Germany.*Overture|Overture.*Germany/);
        await pg.sql.unsafe(`UPDATE overture_places.conflation_state SET region='europe/germany'`);
        await expect(
          buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
            availableBytes: ampleSpace,
          }),
        ).rejects.toThrow(/release/i);
        expect(await readAmbientManifest(pg.sql)).toBeNull();
      } finally {
        await pg.stop();
      }
    }, 120_000);

    it("rolls back staged output on disk admission or checkpoint failure", async () => {
      const pg = await startPostgis();
      try {
        await seed(pg);
        const before = await buildAmbientPlaces(pg.sql, regional);
        const bytes = (await tile(pg, before.generation, 6.08, 50.77)).bytes;
        await expect(
          buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
            availableBytes: async () => 0,
          }),
        ).rejects.toThrow(/disk/i);
        let checks = 0;
        await expect(
          buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
            availableBytes: async () => (++checks === 1 ? ampleSpace() : 0),
          }),
        ).rejects.toThrow(/disk/i);
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(before.generation);
        expect((await tile(pg, before.generation, 6.08, 50.77)).bytes).toEqual(bytes);
        const [count] = await pg.sql.unsafe(
          `SELECT count(*)::INT AS count FROM ambient_places.generations`,
        );
        expect(count.count).toBe(1);
      } finally {
        await pg.stop();
      }
    }, 120_000);

    it("reads one source snapshot even if metadata and rows are refreshed during a batch", async () => {
      const pg = await startPostgis();
      try {
        await seed(pg);
        let changed = false;
        const country = await buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
          availableBytes: ampleSpace,
          onProgress: async () => {
            if (changed) return;
            changed = true;
            await pg.sql.unsafe(
              `UPDATE osm_search.index_state SET epoch='country-two'; UPDATE osm_search.places SET name='Refreshed clinic'`,
            );
          },
        });
        expect(country.sources.osm.epoch).toBe("country-one");
        expect(
          (await tile(pg, country.generation, 6.08, 50.77)).layer?.feature(0).properties.name,
        ).toBe("Aachen clinic");
      } finally {
        await pg.stop();
      }
    }, 120_000);
    it("finishes multi-batch Overture gaps and rolls back a late unsupported contributor", async () => {
      const pg = await startPostgis();
      try {
        await seed(pg);
        const before = await buildAmbientPlaces(pg.sql, regional);
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(`INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance)
          VALUES('node',2,'Closed cafe',52.52,13.405,'amenity/cafe','{"disused":"yes"}',1);
          UPDATE osm_search.index_state SET place_count=2;
          INSERT INTO overture_places.places(gers_id,name,geom,basic_category,confidence,operating_status,release)
          SELECT 'gers-'||lpad(id::TEXT,5,'0'),'Cafe '||id,ST_SetSRID(ST_MakePoint(13.405,52.52),4326),'cafe',0.9,'open','2026-09-23.1' FROM generate_series(1,2101) AS id;
          UPDATE overture_places.places SET sources='[{"dataset":"unsupported-country-source"}]' WHERE gers_id='gers-02101';
          INSERT INTO overture_places.conflation_state(singleton,release,region,place_count,places_published_at,status,phase)
          VALUES(1,'2026-09-23.1','europe/germany',2101,now(),'completed','complete');
          INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release)
          VALUES('node',1,'gers-00001',0.9,1,0,'fixture','{}','2026-09-23.1'),('node',2,'gers-00002',0.9,1,0,'fixture','{}','2026-09-23.1')`);
        await expect(
          buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
            availableBytes: ampleSpace,
          }),
        ).rejects.toThrow(/unsupported/i);
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(before.generation);
        await pg.sql.unsafe(`UPDATE overture_places.places SET sources=NULL`);
        const country = await buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
          availableBytes: ampleSpace,
        });
        expect(country).toMatchObject({
          placeCount: 2100,
          sources: { osm: { count: 1 }, overture: { count: 2101 } },
        });
        expect((await readAmbientPlaceByGers(pg.sql, "gers-02101"))?.place.id).toBe(
          "overture:gers-02101",
        );
        expect(await readAmbientPlaceByGers(pg.sql, "gers-00002")).toBeNull();
      } finally {
        await pg.stop();
      }
    }, 120_000);
    it("holds both source-operation locks during country publication and releases them afterwards", async () => {
      const pg = await startPostgis();
      try {
        await seed(pg);
        const inspect = async (expected: boolean) => {
          const connection = await pg.sql.reserve();
          try {
            const [locks] = await connection.unsafe(
              `SELECT pg_try_advisory_lock(1330466120,1) AS overture,pg_try_advisory_lock(1330466120,2) AS osm`,
            );
            expect(locks).toEqual({ overture: expected, osm: expected });
          } finally {
            await connection.unsafe(`SELECT pg_advisory_unlock_all()`);
            connection.release();
          }
        };
        await buildAmbientPlaces(pg.sql, AMBIENT_GERMANY_REGION, undefined, {
          availableBytes: ampleSpace,
          onProgress: () => inspect(false),
        });
        await inspect(true);
      } finally {
        await pg.stop();
      }
    }, 120_000);
  },
);
