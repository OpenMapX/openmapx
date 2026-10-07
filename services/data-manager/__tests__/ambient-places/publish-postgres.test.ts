import { VectorTile } from "@mapbox/vector-tile";
import { AMBIENT_LIMITS } from "@openmapx/core/ambient-places";
import { readAmbientManifest, readAmbientTile } from "@openmapx/core/ambient-places-server";
import { PbfReader } from "pbf";
import { describe, expect, it } from "vitest";
import {
  buildAmbientPlaces,
  rollbackAmbientPlaces,
  setAmbientEnabled,
} from "../../src/jobs/ambient-places/build.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { startPostgis } from "../poi-ingest/_testcontainer.js";

const region = {
  name: "Aachen",
  bounds: [5.9, 50.65, 6.3, 50.95] as [number, number, number, number],
};
const tile = {
  z: 16,
  x: Math.floor(((6.08 + 180) / 360) * 2 ** 16),
  y: Math.floor(((1 - Math.asinh(Math.tan((50.77 * Math.PI) / 180)) / Math.PI) / 2) * 2 ** 16),
};

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "ambient PostGIS publication",
  () => {
    it("publishes bounded canonical tiles atomically, preserves old bytes and rolls back", async () => {
      const pg = await startPostgis();
      try {
        expect(await readAmbientManifest(pg.sql)).toBeNull();
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,'europe/germany','secret/path','secret','secret','osm-one','ready',now(),now(),now());
        INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES
        ('node',9007199254740993,'Klinik',50.77,6.08,'amenity:hospital','{"name:en":"Clinic"}',0.8),
        ('node',2,'Outside',52,13,'amenity:hospital','{}',1),
        ('node',3,'Closed',50.77,6.08,'shop:bakery','{"disused":"yes"}',1)`);
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        const start = performance.now();
        const a = await buildAmbientPlaces(pg.sql, region);
        const initialBuildMs = performance.now() - start;
        expect(a).toMatchObject({
          placeCount: 1,
          sources: { osm: { epoch: "osm-one", count: 1 }, overture: null },
        });
        const bytes = await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y);
        expect(bytes!.length).toBeGreaterThan(0);
        expect(bytes!.toString("utf8")).toContain("osm:node/9007199254740993");
        expect(bytes!.length).toBeLessThan(AMBIENT_LIMITS.tileBytes);
        expect(new VectorTile(new PbfReader(bytes!)).layers.ambient_places.length).toBe(1);
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(`INSERT INTO overture_places.places(gers_id,name,geom,basic_category,confidence,operating_status,release) VALUES
        ('gers-a','Clinic',ST_SetSRID(ST_MakePoint(6.08,50.77),4326),'hospital',0.8,'open','2026-10-01.0'),
        ('gers-b','Cafe',ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),'cafe',0.8,'open','2026-10-01.0'),
        ('gers-closed','Closed',ST_SetSRID(ST_MakePoint(6.08,50.77),4326),'cafe',0.8,'permanently_closed','2026-10-01.0');
        INSERT INTO overture_places.conflation_state(singleton,release,region,place_count,places_published_at,status,phase) VALUES(1,'2026-10-01.0','europe/germany',3,now(),'completed','complete');
        INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release) VALUES('node',9007199254740993,'gers-a',0.8,1,0,'fixture','{}','2026-10-01.0')`);
        const b = await buildAmbientPlaces(pg.sql, region);
        expect(b).toMatchObject({
          placeCount: 2,
          sources: { overture: { release: "2026-10-01.0", count: 2 } },
        });
        expect(await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y)).toEqual(bytes);
        const current = await readAmbientTile(pg.sql, b.generation, tile.z, tile.x, tile.y);
        expect(current!.toString("utf8")).toContain("gers-a");
        expect(current!.toString("utf8")).not.toContain("overture:gers-a");
        await rollbackAmbientPlaces(pg.sql);
        expect((await readAmbientManifest(pg.sql))!.generation).toBe(a.generation);
        await rollbackAmbientPlaces(pg.sql);
        await setAmbientEnabled(pg.sql, false);
        expect((await readAmbientManifest(pg.sql))!.enabled).toBe(false);
        await setAmbientEnabled(pg.sql, true);
        await pg.sql.unsafe(
          `CREATE FUNCTION ambient_places.reject_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture insertion failure'; END $$; CREATE TRIGGER reject_fixture BEFORE INSERT ON ambient_places.features FOR EACH ROW EXECUTE FUNCTION ambient_places.reject_fixture()`,
        );
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(
          /fixture insertion failure/,
        );
        expect((await readAmbientManifest(pg.sql))!.generation).toBe(b.generation);
        const [survivors] = await pg.sql.unsafe<{ count: number }[]>(
          `SELECT count(*)::INT AS count FROM ambient_places.generations`,
        );
        expect(survivors.count).toBe(2);
        await pg.sql.unsafe(
          `DROP TRIGGER reject_fixture ON ambient_places.features; DROP FUNCTION ambient_places.reject_fixture()`,
        );
        await pg.sql.unsafe(
          `UPDATE overture_places.places SET sources='[{"dataset":"unknown-fixture"}]' WHERE gers_id='gers-b'`,
        );
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(/unsupported|unknown/i);
        expect((await readAmbientManifest(pg.sql))!.generation).toBe(b.generation);
        await pg.sql.unsafe(`UPDATE overture_places.places SET sources=NULL`);
        await pg.sql.unsafe(`UPDATE overture_places.conflation_state SET status='running'`);
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(/conflation/i);
        expect((await readAmbientManifest(pg.sql))!.generation).toBe(b.generation);
        await pg.sql.unsafe(
          `UPDATE overture_places.conflation_state SET status='completed'; UPDATE osm_search.index_state SET published_at=now()-interval '91 days'`,
        );
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(/old|stale/i);
        await pg.sql.unsafe(
          `UPDATE osm_search.index_state SET published_at=now(); UPDATE osm_search.places SET tags='{"disused":"yes"}'`,
        );
        await pg.sql.unsafe(
          `UPDATE overture_places.places SET operating_status='permanently_closed'`,
        );
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(/empty/i);
        expect((await readAmbientManifest(pg.sql))!.generation).toBe(b.generation);
        process.stdout.write(
          JSON.stringify({
            initialBuildMs,
            buildAndChecksMs: Math.round(performance.now() - start),
            sparseTileBytes: bytes!.length,
          }),
        );
      } finally {
        await pg.stop();
      }
    }, 120_000);

    it("bounds dense tiles, serializes writers and protects the generation cache lease", async () => {
      const pg = await startPostgis();
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,'europe/germany','fixture','fixture','fixture','dense','ready',now(),now(),now());
      INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) SELECT 'node',i,'Place '||i,50.77+i*0.0000001,6.08,'amenity:hospital','{}',0.8 FROM generate_series(1,1000) i`);
        const a = await buildAmbientPlaces(pg.sql, region);
        const times: number[] = [];
        let bytes: Buffer | null = null;
        for (let i = 0; i < 20; i++) {
          const t = performance.now();
          bytes = await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y);
          times.push(performance.now() - t);
        }
        expect(bytes!.length).toBeLessThan(AMBIENT_LIMITS.tileBytes);
        expect(new VectorTile(new PbfReader(bytes!)).layers.ambient_places.length).toBe(256);
        expect(bytes!.toString("utf8")).toContain("Place 1");
        expect(bytes!.toString("utf8")).not.toContain("Place 999");
        await pg.sql.unsafe(
          `UPDATE osm_search.places SET name=repeat('😀',115)||osm_id::TEXT,tags=jsonb_build_object('name:de',repeat('🌍',115)||osm_id::TEXT,'name:en',repeat('🏥',115)||osm_id::TEXT)`,
        );
        const longLabels = await buildAmbientPlaces(pg.sql, region);
        const longTile = await readAmbientTile(
          pg.sql,
          longLabels.generation,
          tile.z,
          tile.x,
          tile.y,
        );
        expect(longTile!.length).toBeLessThanOrEqual(AMBIENT_LIMITS.tileBytes);
        expect(new VectorTile(new PbfReader(longTile!)).layers.ambient_places.length).toBeLessThan(
          256,
        );
        const settled = await Promise.allSettled([
          buildAmbientPlaces(pg.sql, region),
          buildAmbientPlaces(pg.sql, region),
        ]);
        expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
        const liveBeforeOverflow = (await readAmbientManifest(pg.sql))?.generation;
        await pg.sql.unsafe(
          `INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) SELECT 'node',i,'Overflow '||i,50.77,6.08,'amenity:hospital','{}',0.8 FROM generate_series(1001,100001) i`,
        );
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(/input exceeds/);
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(liveBeforeOverflow);
        await pg.sql.unsafe(`DELETE FROM osm_search.places WHERE osm_id>1000`);
        for (let i = 0; i < 5; i++) await buildAmbientPlaces(pg.sql, region);
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(/retention/i);
        expect(await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y)).toEqual(bytes);
        process.stdout.write(
          JSON.stringify({
            densePlaces: 1000,
            tileFeatures: 256,
            tileBytes: bytes!.length,
            p95Ms: times.sort((a, b) => a - b)[18],
          }),
        );
      } finally {
        await pg.stop();
      }
    }, 120_000);
  },
);
