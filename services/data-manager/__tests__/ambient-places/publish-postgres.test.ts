import { VectorTile } from "@mapbox/vector-tile";
import { AMBIENT_LIMITS } from "@openmapx/core/ambient-places";
import {
  readAmbientManifest,
  readAmbientPlaceByGers,
  readAmbientTile,
} from "@openmapx/core/ambient-places-server";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { PbfReader } from "pbf";
import { describe, expect, it } from "vitest";
import {
  buildAmbientPlaces,
  rollbackAmbientPlaces,
  setAmbientEnabled,
} from "../../src/jobs/ambient-places/build.js";
import { ambientSchemaDDL } from "../../src/jobs/ambient-places/schema.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";

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
    it("keeps v1 lease bytes across migration while v2 carries captured field lineage", async () => {
      const pg = await startPostgis();
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,'aachen','fixture','fixture','fixture','receipt','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES('node',1,'Clinic',50.77,6.08,'amenity/hospital','{}',0.8)`);
        // Start with a genuinely pre-receipt store and active v1 publication.
        await pg.sql.unsafe(
          ambientSchemaDDL.replace(
            /^ALTER TABLE .* ADD COLUMN IF NOT EXISTS (?:contributors|field_contributors|source_lineage) JSONB;\n/gm,
            "",
          ),
        );
        const legacy = {
          generation: "11111111-1111-4111-8111-111111111111",
          version: 1,
          policyVersion: 2,
          publishedAt: new Date().toISOString(),
          region,
          placeCount: 1,
          enabled: true,
          sources: {
            osm: {
              region: "aachen",
              epoch: "receipt",
              publishedAt: new Date().toISOString(),
              count: 1,
            },
            overture: null,
          },
        };
        await pg.sql.unsafe(
          `INSERT INTO ambient_places.generations(id,manifest) VALUES($1,$2::JSONB)`,
          [legacy.generation, JSON.stringify(legacy)],
        );
        await pg.sql.unsafe(
          `INSERT INTO ambient_places.features(generation,id,name,category,rank,min_zoom,tenant,sources,geom) VALUES($1,'osm:node/1','Clinic','hospital',3079,13,false,'osm',ST_AsEWKB(ST_Transform(ST_SetSRID(ST_MakePoint(6.08,50.77),4326),3857)))`,
          [legacy.generation],
        );
        await pg.sql.unsafe(`UPDATE ambient_places.state SET active=$1 WHERE singleton=1`, [
          legacy.generation,
        ]);
        const bytes = await readAmbientTile(pg.sql, legacy.generation, tile.z, tile.x, tile.y);
        const before = new VectorTile(new PbfReader(bytes!)).layers.ambient_places.feature(
          0,
        ).properties;
        expect(before._mapAttributions).toBeUndefined();
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(
          `INSERT INTO overture_places.places(gers_id,name,names,geom,basic_category,confidence,operating_status,sources,sources_catalogue,release) VALUES('gers-receipt','Cafe','{"common":{"de":"Kaffee"}}',ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),'cafe',0.8,'open','[{"property":"/names/primary","dataset":"meta"},{"property":"/names/common/de","dataset":"Microsoft"},{"property":"/phones","dataset":"Foursquare"}]',$1::JSONB,'2026-10-01.0')`,
          [
            JSON.stringify([
              { sourceId: "overture", name: "Captured Overture" },
              { sourceId: "meta-places", name: "Captured Meta" },
              { sourceId: "microsoft-places", name: "Captured Microsoft" },
              { sourceId: "foursquare", name: "Phone only" },
            ]),
          ],
        );
        await pg.sql.unsafe(
          `INSERT INTO overture_places.conflation_state(singleton,release,region,place_count,places_published_at,status,phase) VALUES(1,'2026-10-01.0','aachen',1,now(),'completed','complete')`,
        );
        const next = await buildAmbientPlaces(pg.sql, region);
        expect(next.version).toBe(2);
        const current = await readAmbientTile(pg.sql, next.generation, tile.z, tile.x, tile.y);
        const decoded = new VectorTile(new PbfReader(current!)).layers.ambient_places;
        const feature = Array.from(
          { length: decoded.length },
          (_, i) => decoded.feature(i).properties,
        ).find((p) => p.gers_id === "gers-receipt")!;
        expect(feature.format_version).toBe(2);
        expect(
          JSON.parse(String(feature.field_contributors))["names.de"].map(
            (r: { sourceId: string }) => r.sourceId,
          ),
        ).toEqual(["overture", "microsoft-places"]);
        expect(String(feature._mapAttributions)).not.toContain("Phone only");
        expect(JSON.parse(String(feature.source_lineage)).sources[2]).toEqual({
          property: "/phones",
          dataset: "Foursquare",
        });
        expect(await readAmbientTile(pg.sql, legacy.generation, tile.z, tile.x, tile.y)).toEqual(
          bytes,
        );
        await rollbackAmbientPlaces(pg.sql);
        expect(await readAmbientTile(pg.sql, legacy.generation, tile.z, tile.x, tile.y)).toEqual(
          bytes,
        );
        expect(current!.length).toBeLessThan(AMBIENT_LIMITS.tileBytes);
        // Distinct snapshots and lineage values cannot be charged as a single
        // interned MVT string; clipping keeps complete receipts on retained rows.
        await pg.sql.unsafe(`DELETE FROM overture_places.places;
          INSERT INTO overture_places.places(gers_id,name,geom,basic_category,confidence,operating_status,sources,sources_catalogue,release)
          SELECT 'dense-'||lpad(i::TEXT,5,'0'),'Cafe '||i,ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),'cafe',0.8,'open',
            jsonb_build_array(jsonb_build_object('property','/names/primary','dataset','meta','record_id',repeat('x',10000)||i)),
            jsonb_build_array(jsonb_build_object('sourceId','overture','name','Captured Overture'),jsonb_build_object('sourceId','meta-places','name','Meta','notes',repeat('n',8000)||i)),
            '2026-10-01.0' FROM generate_series(1,300) i`);
        const distinct = await buildAmbientPlaces(pg.sql, region);
        const pathological = await readAmbientTile(
          pg.sql,
          distinct.generation,
          tile.z,
          tile.x,
          tile.y,
        );
        const bounded = new VectorTile(new PbfReader(pathological!)).layers.ambient_places;
        expect(bounded.length).toBeGreaterThan(0);
        expect(bounded.length).toBeLessThan(AMBIENT_LIMITS.tileFeatures);
        expect(pathological!.length).toBeLessThanOrEqual(AMBIENT_LIMITS.tileBytes);
        const first = Array.from(
          { length: bounded.length },
          (_, i) => bounded.feature(i).properties,
        ).find((p) => p.gers_id)!;
        expect(first.gers_id).toBe("dense-00001");
        expect(JSON.parse(String(first.source_lineage)).sources[0].record_id).toBe(
          `${"x".repeat(10000)}1`,
        );
        expect(JSON.parse(String(first.field_contributors)).name[1].notes).toBe(
          `${"n".repeat(8000)}1`,
        );
        expect(await readAmbientTile(pg.sql, distinct.generation, tile.z, tile.x, tile.y)).toEqual(
          pathological,
        );
      } finally {
        await pg.stop();
      }
    }, 120_000);
    it("keeps exact GERS identity from readable retained generations after replacement and rollback", async () => {
      const pg = await startPostgis();
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,'aachen','fixture','fixture','fixture','retained','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES('node',1,'Clinic',50.77,6.08,'amenity/hospital','{}',0.8);
          INSERT INTO overture_places.places(gers_id,name,geom,basic_category,confidence,operating_status,release) VALUES('gers-retained','Retained cafe',ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),'cafe',0.8,'open','2026-10-01.0');
          INSERT INTO overture_places.conflation_state(singleton,release,region,place_count,places_published_at,status,phase) VALUES(1,'2026-10-01.0','aachen',1,now(),'completed','complete')`);
        const a = await buildAmbientPlaces(pg.sql, region);
        const bytes = await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y);
        await pg.sql.unsafe(
          `UPDATE overture_places.places SET geom=ST_SetSRID(ST_MakePoint(13,52),4326)`,
        );
        await buildAmbientPlaces(pg.sql, region);
        await buildAmbientPlaces(pg.sql, region);
        // Still-stored, source-fresh tiles remain readable even after lease
        // expiry, until a later publication actually garbage-collects them.
        await pg.sql.unsafe(
          `UPDATE ambient_places.generations SET cache_lease_until=now()-interval '1 day' WHERE id=$1`,
          [a.generation],
        );
        await setAmbientEnabled(pg.sql, false);
        expect(await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y)).toEqual(bytes);
        expect(await readAmbientPlaceByGers(pg.sql, "gers-retained")).toMatchObject({
          generation: a.generation,
          place: { id: "overture:gers-retained", name: "Retained cafe" },
        });
        await rollbackAmbientPlaces(pg.sql);
        expect((await readAmbientPlaceByGers(pg.sql, "gers-retained"))?.generation).toBe(
          a.generation,
        );
        // Keep A retained through the following new publication; expired,
        // unreferenced snapshots are correctly removed by its garbage collection.
        await pg.sql.unsafe(
          `UPDATE ambient_places.generations SET cache_lease_until=now()+interval '7 days' WHERE id=$1`,
          [a.generation],
        );
        await pg.sql.unsafe(`UPDATE overture_places.places SET geom=ST_SetSRID(ST_MakePoint(6.081,50.7701),4326);
          INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release) VALUES('node',1,'gers-retained',0.8,1,0,'fixture','{}','2026-10-01.0')`);
        const current = await buildAmbientPlaces(pg.sql, region);
        expect(await readAmbientPlaceByGers(pg.sql, "gers-retained")).toMatchObject({
          generation: current.generation,
          place: { id: "osm:node/1" },
        });
        await pg.sql.unsafe(
          `UPDATE ambient_places.generations SET manifest=jsonb_set(manifest,'{sources,osm,publishedAt}',to_jsonb((now()-interval '91 days')::TEXT)) WHERE id=$1`,
          [current.generation],
        );
        expect((await readAmbientPlaceByGers(pg.sql, "gers-retained"))?.generation).toBe(
          a.generation,
        );
        await pg.sql.unsafe(
          `UPDATE ambient_places.generations SET manifest=jsonb_set(manifest,'{sources,osm,publishedAt}',to_jsonb((now()-interval '91 days')::TEXT)) WHERE id=$1`,
          [a.generation],
        );
        expect(await readAmbientPlaceByGers(pg.sql, "gers-retained")).toBeNull();
      } finally {
        await pg.stop();
      }
    }, 120_000);
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
        const [discovery] = await pg.sql.unsafe<{ exposed: boolean }[]>(
          `SELECT EXISTS(SELECT 1 FROM geometry_columns WHERE f_table_schema='ambient_places' AND f_table_name='features') AS exposed`,
        );
        expect(discovery.exposed).toBe(false);
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
        expect(await readAmbientPlaceByGers(pg.sql, "gers-a")).toMatchObject({
          generation: b.generation,
          place: { id: "osm:node/9007199254740993", gersId: "gers-a", name: "Klinik" },
        });
        expect(await readAmbientPlaceByGers(pg.sql, "gers-b")).toMatchObject({
          place: { id: "overture:gers-b", name: "Cafe" },
        });
        expect(await readAmbientPlaceByGers(pg.sql, "not-published")).toBeNull();

        // Execute the registered enabled-provider resolver against the real
        // accepted link, not a conversion fixture with a prefilled canonical ID.
        const { setup } = await import("../../../../integrations/poi-overture/index.js");
        const { getPlaceResolver } = await import("../../../../packages/place-ids/src/index.js");
        setup(
          createMockIntegrationContext({
            db: {
              execute: async <T>(query: string, params?: unknown[]) =>
                (await pg.sql.unsafe(query, params as never[])) as unknown as T,
            },
          }),
        );
        expect(await getPlaceResolver("overture")?.("gers-a", { lang: "en" })).toMatchObject({
          id: "osm:node/9007199254740993",
          primaryScheme: "osm",
          ids: { osm: "node/9007199254740993", overture: "gers-a" },
        });

        await rollbackAmbientPlaces(pg.sql);
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(a.generation);
        await rollbackAmbientPlaces(pg.sql);
        await setAmbientEnabled(pg.sql, false);
        expect((await readAmbientManifest(pg.sql))!.enabled).toBe(false);
        expect((await readAmbientPlaceByGers(pg.sql, "gers-b"))?.place.id).toBe("overture:gers-b");
        await setAmbientEnabled(pg.sql, true);
        await pg.sql.unsafe(
          `CREATE FUNCTION ambient_places.reject_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture insertion failure'; END $$; CREATE TRIGGER reject_fixture BEFORE INSERT ON ambient_places.features FOR EACH ROW EXECUTE FUNCTION ambient_places.reject_fixture()`,
        );
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(
          /fixture insertion failure/,
        );
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(b.generation);
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
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(b.generation);
        await pg.sql.unsafe(`UPDATE overture_places.places SET sources=NULL`);
        await pg.sql.unsafe(`UPDATE overture_places.conflation_state SET status='running'`);
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(/conflation/i);
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(b.generation);
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
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(b.generation);
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

    it("applies linked OSM policy and location across the regional boundary", async () => {
      const pg = await startPostgis();
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,'aachen','fixture','fixture','fixture','boundary','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES
          ('node',1,'Closed clinic',50.77,5.8999,'amenity:hospital','{"disused":"yes"}',0.8),
          ('node',2,'Private clinic',50.77,5.8999,'amenity:hospital','{"access":"private"}',0.8),
          ('node',3,'Upper-floor clinic',50.77,5.8999,'amenity:hospital','{"level":"1"}',0.8)`);
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(`INSERT INTO overture_places.conflation_state(singleton,release,region,place_count,places_published_at,status,phase) VALUES(1,'2026-10-01.0','aachen',4,now(),'completed','complete');
          INSERT INTO overture_places.places(gers_id,name,geom,basic_category,confidence,operating_status,release) SELECT 'boundary-'||i,'Clinic '||i,ST_SetSRID(ST_MakePoint(5.9001,50.77),4326),'hospital',0.8,'open','2026-10-01.0' FROM generate_series(1,4) i;
          INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release) SELECT 'node',i,'boundary-'||i,0.8,1,14,'fixture','{}','2026-10-01.0' FROM generate_series(1,3) i`);
        const a = await buildAmbientPlaces(pg.sql, region);
        const rows = await pg.sql.unsafe<{ id: string }[]>(
          `SELECT id FROM ambient_places.features WHERE generation=$1 ORDER BY id`,
          [a.generation],
        );
        // Authoritative OSM locations are outside; closed/private counterparts
        // cannot be resurrected and the tenant cannot become a ground-floor gap.
        expect(rows.map((r) => r.id)).toEqual(["overture:boundary-4"]);
        await pg.sql.unsafe(`UPDATE osm_search.places SET lng=5.9001 WHERE osm_id=3`);
        const b = await buildAmbientPlaces(pg.sql, region);
        const [tenant] = await pg.sql.unsafe<{ tenant: boolean; min_zoom: number; name: string }[]>(
          `SELECT tenant,min_zoom,name FROM ambient_places.features WHERE generation=$1 AND id='osm:node/3'`,
          [b.generation],
        );
        expect(tenant).toMatchObject({ tenant: true, min_zoom: 18, name: "Upper-floor clinic" });
        expect(b.sources.osm.count).toBe(1);
      } finally {
        await pg.stop();
      }
    }, 120_000);

    it.each([
      { catalogue: [] as { sourceId: string; name: string }[] },
      { catalogue: [{ sourceId: "overture", name: "Captured boundary notice" }] },
      { catalogue: null },
    ])(
      "retains only captured GERS identity evidence for an outside-boundary Overture counterpart: %j",
      async ({ catalogue: sources_catalogue }) => {
        const pg = await startPostgis();
        try {
          await pg.sql.unsafe(
            buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
          );
          await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,'aachen','fixture','fixture','fixture','boundary-inside','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES('node',1,'Inside Clinic',50.77,5.9001,'amenity/hospital','{}',0.8)`);
          await pg.sql.unsafe(buildSchemaDDL("overture_places"));
          await pg.sql.unsafe(`INSERT INTO overture_places.conflation_state(singleton,release,region,place_count,places_published_at,status,phase) VALUES(1,'2026-10-01.0','aachen',1,now(),'completed','complete');
          INSERT INTO overture_places.places(gers_id,name,names,geom,basic_category,confidence,operating_status,sources,release) VALUES('boundary-gers','Excluded outside name','{"common":{"de":"Excluded outside locale"}}',ST_SetSRID(ST_MakePoint(5.8999,50.77),4326),'cafe',0.1,'permanently_closed','[{"property":"/phones","dataset":"Foursquare"}]','2026-10-01.0');
          INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release) VALUES('node',1,'boundary-gers',0.8,1,14,'fixture','{}','2026-10-01.0')`);
          await pg.sql.unsafe(`UPDATE overture_places.places SET sources_catalogue=$1::JSONB`, [
            sources_catalogue === null ? null : JSON.stringify(sources_catalogue),
          ]);
          const manifest = await buildAmbientPlaces(pg.sql, region);
          const first = (await readAmbientPlaceByGers(pg.sql, "boundary-gers"))!.place;
          expect(manifest.attributionPrecision).toBe(
            sources_catalogue === null ? "legacy-aggregate" : "captured-fields",
          );
          expect(first.sourceLineage).toEqual({
            sources: [{ property: "/phones", dataset: "Foursquare" }],
            release: "2026-10-01.0",
          });
          expect(first.fieldContributors?.gersId).toEqual(
            sources_catalogue ?? [
              {
                sourceId: "overture",
                name: "Overture Maps",
                url: "https://overturemaps.org",
                licensing: {
                  version: 1,
                  bindings: [
                    {
                      scope: "data",
                      subject: "Data",
                      license: {
                        kind: "spdx",
                        expression: "CDLA-Permissive-2.0",
                        url: "https://cdla.dev/permissive-2-0/",
                      },
                    },
                  ],
                } as const,
              },
            ],
          );
          expect(first.name).toBe("Inside Clinic");
          expect(first.names).toEqual({});
          expect(first.category).toBe("hospital");
          expect(first.contributors?.some((r) => r.sourceId === "foursquare")).toBe(false);
          const [{ source_lineage }] = await pg.sql.unsafe<{ source_lineage: unknown }[]>(
            `SELECT source_lineage FROM ambient_places.features WHERE generation=$1 AND id='osm:node/1'`,
            [manifest.generation],
          );
          expect(source_lineage).toEqual(first.sourceLineage);
          // A later source edit cannot rewrite the retained publication snapshot.
          await pg.sql.unsafe(
            `UPDATE overture_places.places SET sources_catalogue='[{"sourceId":"overture","name":"Changed current source"}]'`,
          );
          const stable = await buildAmbientPlaces(pg.sql, region);
          const [{ field_contributors }] = await pg.sql.unsafe<
            { field_contributors: { gersId: unknown } }[]
          >(
            `SELECT field_contributors FROM ambient_places.features WHERE generation=$1 AND id='osm:node/1'`,
            [manifest.generation],
          );
          expect(field_contributors.gersId).toEqual(first.fieldContributors?.gersId);
          await pg.sql.unsafe(`UPDATE overture_places.places SET release='2026-09-01.0'`);
          await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(
            "Regional accepted GERS identity does not match published Overture places",
          );
          expect((await readAmbientManifest(pg.sql))?.generation).toBe(stable.generation);
        } finally {
          await pg.stop();
        }
      },
      120_000,
    );

    it("keeps recently retired old publications available through rapid builds and rollback", async () => {
      const pg = await startPostgis();
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,'aachen','fixture','fixture','fixture','lease','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES('node',1,'Clinic',50.77,6.08,'amenity:hospital','{}',0.8)`);
        const a = await buildAmbientPlaces(pg.sql, region);
        const bytes = await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y);
        await pg.sql.unsafe(
          `UPDATE ambient_places.generations SET published_at=now()-interval '8 days',cache_lease_until=now()-interval '1 day' WHERE id=$1`,
          [a.generation],
        );
        await buildAmbientPlaces(pg.sql, region);
        await buildAmbientPlaces(pg.sql, region);
        await buildAmbientPlaces(pg.sql, region);
        expect(await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y)).toEqual(bytes);
        const old = await buildAmbientPlaces(pg.sql, region);
        await pg.sql.unsafe(
          `UPDATE ambient_places.generations SET published_at=now()-interval '8 days',cache_lease_until=now()-interval '1 day' WHERE id=$1`,
          [old.generation],
        );
        await buildAmbientPlaces(pg.sql, region);
        await rollbackAmbientPlaces(pg.sql);
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(old.generation);
        await buildAmbientPlaces(pg.sql, region);
        await buildAmbientPlaces(pg.sql, region);
        // The eighth slot is still leased: a ninth build must preserve every URL.
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(/retention/i);
        expect(await readAmbientTile(pg.sql, old.generation, tile.z, tile.x, tile.y)).toEqual(
          bytes,
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
