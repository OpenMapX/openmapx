import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { VectorTile } from "@mapbox/vector-tile";
import { AMBIENT_LIMITS, AMBIENT_PLANET_REGION } from "@openmapx/core/ambient-places";
import {
  PUBLISHED_AMBIENT_FEATURES,
  readAmbientManifest,
  readAmbientPlaceByGers,
  readAmbientTile,
} from "@openmapx/core/ambient-places-server";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import { PbfReader } from "pbf";
import postgres from "postgres";
import { afterAll, afterEach, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildAmbientPlaces,
  rollbackAmbientPlaces,
  setAmbientEnabled,
} from "../../src/jobs/ambient-places/build.js";
import { dropRetiredFeatureStorage } from "../../src/jobs/ambient-places/feature-storage.js";
import {
  AMBIENT_SCHEMA_VERSION,
  ambientSchemaDDL,
  ensureAmbientSchema,
} from "../../src/jobs/ambient-places/schema.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import {
  PUBLICATION_LOCK_TIMEOUT_MS,
  publishSchemaSwap,
} from "../../src/jobs/publish-schema-swap.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

function ambientLayer(bytes: Uint8Array) {
  const layer = new VectorTile(new PbfReader(bytes)).layers.ambient_places;
  assert.isDefined(layer, "the tile has no ambient_places layer");
  return layer;
}

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
    it("serves only current-format generations and carries captured field lineage", async () => {
      const pg = await startPostgis();
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,1,'aachen','fixture','fixture','fixture','receipt','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES('node',1,'Clinic',ST_Point(6.08,50.77,4326),'amenity/hospital','{}',0.8)`);
        await pg.sql.unsafe(ambientSchemaDDL);
        const unsupported = {
          generation: "11111111-1111-4111-8111-111111111111",
          version: 2,
          policyVersion: 1,
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
          `INSERT INTO ambient_places.generations(id,manifest,storage,publication_status) VALUES($1,$2::JSONB,'regional','published')`,
          [unsupported.generation, JSON.stringify(unsupported)],
        );
        await pg.sql.unsafe(
          `CREATE TABLE ambient_places.features_${unsupported.generation.replaceAll("-", "")} PARTITION OF ambient_places.features FOR VALUES IN ('${unsupported.generation}')`,
        );
        await pg.sql.unsafe(
          `INSERT INTO ambient_places.features(generation,id,gers_id,name,category,rank,min_zoom,tenant,sources,geom) VALUES($1,'osm:node/1','gers-unsupported','Clinic','hospital',3079,13,false,'osm',ST_Transform(ST_SetSRID(ST_MakePoint(6.08,50.77),4326),3857))`,
          [unsupported.generation],
        );
        expect(
          await readAmbientTile(pg.sql, unsupported.generation, tile.z, tile.x, tile.y),
        ).toBeNull();
        // A fresh, published generation of another format owns no GERS identity either.
        expect(await readAmbientPlaceByGers(pg.sql, "gers-unsupported")).toBeNull();
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(
          `INSERT INTO overture_places.places(gers_id,name,names,geom,h3_r8,basic_category,confidence,operating_status,sources,release) VALUES('gers-receipt','Cafe','{"common":{"de":"Kaffee"}}',ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),x'881f1d4887fffff'::BIGINT,'cafe',0.8,'open','[{"property":"/names/primary","dataset":"meta"},{"property":"/names/common/de","dataset":"Microsoft"},{"property":"/phones","dataset":"Foursquare"}]','2026-10-01.0')`,
        );
        await pg.sql.unsafe(
          `INSERT INTO overture_places.conflation_state(schema_version,singleton,release,region,place_count,places_published_at,status,phase,sources_catalogue) VALUES(1,1,'2026-10-01.0','aachen',1,now(),'completed','complete',$1::TEXT::JSONB)`,
          [
            JSON.stringify([
              { sourceId: "overture", name: "Captured Overture" },
              { sourceId: "meta-places", name: "Captured Meta" },
              { sourceId: "microsoft-places", name: "Captured Microsoft" },
              { sourceId: "foursquare", name: "Phone only" },
            ]),
          ],
        );
        const next = await buildAmbientPlaces(pg.sql, region);
        expect(next.version).toBe(1);
        const current = await readAmbientTile(pg.sql, next.generation, tile.z, tile.x, tile.y);
        assert.exists(current);
        const decoded = ambientLayer(current);
        const feature = Array.from(
          { length: decoded.length },
          (_, i) => decoded.feature(i).properties,
        ).find((p) => p.gers_id === "gers-receipt");
        assert.isDefined(feature);
        expect(feature.format_version).toBe(1);
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
        expect(current.length).toBeLessThan(AMBIENT_LIMITS.tileBytes);
        // Distinct lineage values cannot be charged as a single interned MVT
        // string; clipping keeps complete receipts on retained rows.
        await pg.sql.unsafe(`DELETE FROM overture_places.places;
          UPDATE overture_places.conflation_state SET sources_catalogue=jsonb_build_array(
            jsonb_build_object('sourceId','overture','name','Captured Overture'),
            jsonb_build_object('sourceId','meta-places','name','Meta','notes',repeat('n',8000))
          );
          INSERT INTO overture_places.places(gers_id,name,geom,h3_r8,basic_category,confidence,operating_status,sources,release)
          SELECT 'dense-'||lpad(i::TEXT,5,'0'),'Cafe '||i,ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),x'881f1d4887fffff'::BIGINT,'cafe',0.8,'open',
            jsonb_build_array(jsonb_build_object('property','/names/primary','dataset','meta','record_id',repeat('x',10000)||i)),
            '2026-10-01.0' FROM generate_series(1,300) i`);
        const distinct = await buildAmbientPlaces(pg.sql, region);
        const pathological = await readAmbientTile(
          pg.sql,
          distinct.generation,
          tile.z,
          tile.x,
          tile.y,
        );
        assert.exists(pathological);
        const bounded = ambientLayer(pathological);
        expect(bounded.length).toBeGreaterThan(0);
        expect(bounded.length).toBeLessThan(AMBIENT_LIMITS.tileFeatures);
        expect(pathological.length).toBeLessThanOrEqual(AMBIENT_LIMITS.tileBytes);
        const first = Array.from(
          { length: bounded.length },
          (_, i) => bounded.feature(i).properties,
        ).find((p) => p.gers_id);
        assert.isDefined(first);
        expect(first.gers_id).toBe("dense-00001");
        expect(JSON.parse(String(first.source_lineage)).sources[0].record_id).toBe(
          `${"x".repeat(10000)}1`,
        );
        expect(JSON.parse(String(first.field_contributors)).name[1].notes).toBe("n".repeat(8000));
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
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,1,'aachen','fixture','fixture','fixture','retained','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES('node',1,'Clinic',ST_Point(6.08,50.77,4326),'amenity/hospital','{}',0.8);
          INSERT INTO overture_places.places(gers_id,name,geom,h3_r8,basic_category,confidence,operating_status,release) VALUES('gers-retained','Retained cafe',ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),x'881f1d4887fffff'::BIGINT,'cafe',0.8,'open','2026-10-01.0');
          INSERT INTO overture_places.conflation_state(schema_version,singleton,release,region,place_count,places_published_at,status,phase,sources_catalogue) VALUES(1,1,'2026-10-01.0','aachen',1,now(),'completed','complete','[{"sourceId":"overture","name":"Overture Maps"}]')`);
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
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,1,'europe/germany','secret/path','secret','secret','osm-one','ready',now(),now(),now());
        INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES
        ('node',9007199254740993,'Klinik',ST_Point(6.08,50.77,4326),'amenity/hospital','{"name:en":"Clinic"}',0.8),
        ('node',2,'Outside',ST_Point(13,52,4326),'amenity/hospital','{}',1),
        ('node',3,'Closed',ST_Point(6.08,50.77,4326),'shop/bakery','{"disused":"yes"}',1)`);
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        const start = performance.now();
        const a = await buildAmbientPlaces(pg.sql, region);
        const initialBuildMs = performance.now() - start;
        expect(
          await pg.sql.unsafe(
            `SELECT type,srid FROM geometry_columns WHERE f_table_schema='ambient_places' AND f_table_name='features'`,
          ),
        ).toEqual([{ type: "GEOMETRY", srid: 3857 }]);
        expect(a).toMatchObject({
          placeCount: 1,
          sources: { osm: { epoch: "osm-one", count: 1 }, overture: null },
        });
        const bytes = await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y);
        assert.exists(bytes);
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.toString("utf8")).toContain("osm:node/9007199254740993");
        expect(bytes.length).toBeLessThan(AMBIENT_LIMITS.tileBytes);
        expect(ambientLayer(bytes).length).toBe(1);
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(`INSERT INTO overture_places.places(gers_id,name,geom,h3_r8,basic_category,confidence,operating_status,release) VALUES
        ('gers-a','Clinic',ST_SetSRID(ST_MakePoint(6.08,50.77),4326),x'881f1d4887fffff'::BIGINT,'hospital',0.8,'open','2026-10-01.0'),
        ('gers-b','Cafe',ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),x'881f1d4887fffff'::BIGINT,'cafe',0.8,'open','2026-10-01.0'),
        ('gers-closed','Closed',ST_SetSRID(ST_MakePoint(6.08,50.77),4326),x'881f1d4887fffff'::BIGINT,'cafe',0.8,'permanently_closed','2026-10-01.0');
        INSERT INTO overture_places.conflation_state(schema_version,singleton,release,region,place_count,places_published_at,status,phase,sources_catalogue) VALUES(1,1,'2026-10-01.0','europe/germany',3,now(),'completed','complete','[{"sourceId":"overture","name":"Overture Maps"}]');
        INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release) VALUES('node',9007199254740993,'gers-a',0.8,1,0,'fixture','{}','2026-10-01.0')`);
        const b = await buildAmbientPlaces(pg.sql, region);
        expect(b).toMatchObject({
          placeCount: 2,
          sources: { overture: { release: "2026-10-01.0", count: 2 } },
        });
        expect(await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y)).toEqual(bytes);
        const current = await readAmbientTile(pg.sql, b.generation, tile.z, tile.x, tile.y);
        assert.exists(current);
        expect(current.toString("utf8")).toContain("gers-a");
        expect(current.toString("utf8")).not.toContain("overture:gers-a");
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
        expect((await readAmbientManifest(pg.sql))?.enabled).toBe(false);
        expect((await readAmbientPlaceByGers(pg.sql, "gers-b"))?.place.id).toBe("overture:gers-b");
        await setAmbientEnabled(pg.sql, true);
        // Fails the activation after the new partition was filled and attached.
        await pg.sql.unsafe(
          `CREATE FUNCTION ambient_places.reject_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture activation failure'; END $$; CREATE TRIGGER reject_fixture BEFORE UPDATE ON ambient_places.generations FOR EACH ROW EXECUTE FUNCTION ambient_places.reject_fixture()`,
        );
        await expect(buildAmbientPlaces(pg.sql, region)).rejects.toThrow(
          /fixture activation failure/,
        );
        expect((await readAmbientManifest(pg.sql))?.generation).toBe(b.generation);
        const [survivors] = await pg.sql.unsafe<{ count: number; tables: number }[]>(
          `SELECT (SELECT count(*)::INT FROM ambient_places.generations) AS count,
            (SELECT count(*)::INT FROM pg_class WHERE relnamespace='ambient_places'::regnamespace AND relkind='r' AND relname LIKE 'features\\_%') AS tables`,
        );
        expect(survivors).toEqual({ count: 2, tables: 2 });
        await pg.sql.unsafe(
          `DROP TRIGGER reject_fixture ON ambient_places.generations; DROP FUNCTION ambient_places.reject_fixture()`,
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
            sparseTileBytes: bytes.length,
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
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,1,'aachen','fixture','fixture','fixture','boundary','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES
          ('node',1,'Closed clinic',ST_Point(5.8999,50.77,4326),'amenity/hospital','{"disused":"yes"}',0.8),
          ('node',2,'Private clinic',ST_Point(5.8999,50.77,4326),'amenity/hospital','{"access":"private"}',0.8),
          ('node',3,'Upper-floor clinic',ST_Point(5.8999,50.77,4326),'amenity/hospital','{"level":"1"}',0.8)`);
        await pg.sql.unsafe(buildSchemaDDL("overture_places"));
        await pg.sql.unsafe(`INSERT INTO overture_places.conflation_state(schema_version,singleton,release,region,place_count,places_published_at,status,phase,sources_catalogue) VALUES(1,1,'2026-10-01.0','aachen',4,now(),'completed','complete','[{"sourceId":"overture","name":"Overture Maps"}]');
          INSERT INTO overture_places.places(gers_id,name,geom,h3_r8,basic_category,confidence,operating_status,release) SELECT 'boundary-'||i,'Clinic '||i,ST_SetSRID(ST_MakePoint(5.9001,50.77),4326),x'881f1d4887fffff'::BIGINT,'hospital',0.8,'open','2026-10-01.0' FROM generate_series(1,4) i;
          INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release) SELECT 'node',i,'boundary-'||i,0.8,1,14,'fixture','{}','2026-10-01.0' FROM generate_series(1,3) i`);
        const a = await buildAmbientPlaces(pg.sql, region);
        const rows = await pg.sql.unsafe<{ id: string }[]>(
          `SELECT id FROM ambient_places.features WHERE generation=$1 ORDER BY id`,
          [a.generation],
        );
        // Authoritative OSM locations are outside; closed/private counterparts
        // cannot be resurrected and the tenant cannot become a ground-floor gap.
        expect(rows.map((r) => r.id)).toEqual(["overture:boundary-4"]);
        await pg.sql.unsafe(
          `UPDATE osm_search.places SET geom=ST_Point(5.9001,ST_Y(geom),4326) WHERE osm_id=3`,
        );
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
    ])(
      "retains only captured GERS identity evidence for an outside-boundary Overture counterpart: %j",
      async ({ catalogue: sources_catalogue }) => {
        const pg = await startPostgis();
        try {
          await pg.sql.unsafe(
            buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
          );
          await pg.sql.unsafe(`INSERT INTO osm_search.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,1,'aachen','fixture','fixture','fixture','boundary-inside','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES('node',1,'Inside Clinic',ST_Point(5.9001,50.77,4326),'amenity/hospital','{}',0.8)`);
          await pg.sql.unsafe(buildSchemaDDL("overture_places"));
          await pg.sql.unsafe(
            `INSERT INTO overture_places.places(gers_id,name,names,geom,h3_r8,basic_category,confidence,operating_status,sources,release) VALUES('boundary-gers','Excluded outside name','{"common":{"de":"Excluded outside locale"}}',ST_SetSRID(ST_MakePoint(5.8999,50.77),4326),x'881f1d4887fffff'::BIGINT,'cafe',0.1,'permanently_closed','[{"property":"/phones","dataset":"Foursquare"}]','2026-10-01.0')`,
          );
          await pg.sql.unsafe(
            `INSERT INTO overture_places.conflation_state(schema_version,singleton,release,region,place_count,places_published_at,status,phase,sources_catalogue) VALUES(1,1,'2026-10-01.0','aachen',1,now(),'completed','complete',$1::TEXT::JSONB)`,
            [JSON.stringify(sources_catalogue)],
          );
          await pg.sql.unsafe(
            `INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release) VALUES('node',1,'boundary-gers',0.8,1,14,'fixture','{}','2026-10-01.0')`,
          );
          const manifest = await buildAmbientPlaces(pg.sql, region);
          const boundary = await readAmbientPlaceByGers(pg.sql, "boundary-gers");
          assert.exists(boundary);
          const first = boundary.place;
          expect(first.sourceLineage).toEqual({
            sources: [{ property: "/phones", dataset: "Foursquare" }],
            release: "2026-10-01.0",
          });
          const capturedGersContributors = first.fieldContributors?.gersId;
          assert.isDefined(capturedGersContributors);
          expect(capturedGersContributors).toEqual(sources_catalogue);
          expect(first.name).toBe("Inside Clinic");
          expect(first.names).toEqual({});
          expect(first.category).toBe("hospital");
          expect(first.contributors?.some((r) => r.sourceId === "foursquare")).toBe(false);
          const [lineageRow] = await pg.sql.unsafe<{ source_lineage: unknown }[]>(
            `SELECT source_lineage FROM ambient_places.features WHERE generation=$1 AND id='osm:node/1'`,
            [manifest.generation],
          );
          assert.isDefined(lineageRow);
          expect(lineageRow.source_lineage).toEqual(first.sourceLineage);
          // A later source edit cannot rewrite the retained publication snapshot.
          await pg.sql.unsafe(
            `UPDATE overture_places.conflation_state SET sources_catalogue='[{"sourceId":"overture","name":"Changed current source"}]'`,
          );
          const stable = await buildAmbientPlaces(pg.sql, region);
          const [contributorRow] = await pg.sql.unsafe<
            { field_contributors: { gersId: unknown } }[]
          >(
            `SELECT field_contributors FROM ambient_places.features WHERE generation=$1 AND id='osm:node/1'`,
            [manifest.generation],
          );
          assert.isDefined(contributorRow);
          expect(contributorRow.field_contributors.gersId).toEqual(capturedGersContributors);
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
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,1,'aachen','fixture','fixture','fixture','lease','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES('node',1,'Clinic',ST_Point(6.08,50.77,4326),'amenity/hospital','{}',0.8)`);
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
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,1,'europe/germany','fixture','fixture','fixture','dense','ready',now(),now(),now());
      INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) SELECT 'node',i,'Place '||i,ST_Point(6.08,50.77+i*0.0000001,4326),'amenity/hospital','{}',0.8 FROM generate_series(1,1000) i`);
        const a = await buildAmbientPlaces(pg.sql, region);
        const times: number[] = [];
        let bytes: Buffer | null = null;
        for (let i = 0; i < 20; i++) {
          const t = performance.now();
          bytes = await readAmbientTile(pg.sql, a.generation, tile.z, tile.x, tile.y);
          times.push(performance.now() - t);
        }
        assert.exists(bytes);
        expect(bytes.length).toBeLessThan(AMBIENT_LIMITS.tileBytes);
        expect(ambientLayer(bytes).length).toBe(256);
        expect(bytes.toString("utf8")).toContain("Place 1");
        expect(bytes.toString("utf8")).not.toContain("Place 999");
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
        assert.exists(longTile);
        expect(longTile.length).toBeLessThanOrEqual(AMBIENT_LIMITS.tileBytes);
        expect(ambientLayer(longTile).length).toBeLessThan(256);
        const settled = await Promise.allSettled([
          buildAmbientPlaces(pg.sql, region),
          buildAmbientPlaces(pg.sql, region),
        ]);
        expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
        const liveBeforeOverflow = (await readAmbientManifest(pg.sql))?.generation;
        await pg.sql.unsafe(
          `INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) SELECT 'node',i,'Overflow '||i,ST_Point(6.08,50.77,4326),'amenity/hospital','{}',0.8 FROM generate_series(1001,100001) i`,
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
            tileBytes: bytes.length,
            p95Ms: times.sort((a, b) => a - b)[18],
          }),
        );
      } finally {
        await pg.stop();
      }
    }, 120_000);
  },
);

const GENERATION = "00000000-0000-4000-8000-000000000001";
const EXPECTED_READER_OUTPUT = new URL("./reader-fixture.expected.json", import.meta.url);
const availableBytes = async () => 1024 ** 4;

function partition(generation: string): string {
  return `ambient_places.features_${generation.replaceAll("-", "")}`;
}

function tileAt(z: number, lng: number, lat: number) {
  return {
    z,
    x: Math.floor(((lng + 180) / 360) * 2 ** z),
    y: Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z),
  };
}

const ATTRIBUTION_KEYS = new Set(["contributors", "fieldContributors"]);

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Long attribution and lineage values are compared by digest to keep the recording readable. */
function digestLongStrings(value: unknown): unknown {
  if (typeof value === "string" && value.length > 120) return digest(value);
  if (Array.isArray(value)) return value.map(digestLongStrings);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        ATTRIBUTION_KEYS.has(key) ? digest(JSON.stringify(entry)) : digestLongStrings(entry),
      ]),
    );
  return value;
}

/** Everything a map client reads from a tile, in the order the tile holds it. */
function decodeTile(bytes: Buffer | null) {
  if (!bytes) return null;
  const layer = new VectorTile(new PbfReader(bytes)).layers.ambient_places;
  if (!layer) return [];
  return Array.from({ length: layer.length }, (_, i) => {
    const feature = layer.feature(i);
    return {
      properties: feature.properties,
      geometry: feature.loadGeometry().map((ring) => ring.map(({ x, y }) => [x, y])),
    };
  });
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "ambient storage on one database",
  () => {
    let database: PostgisFixture;
    // Each test gets its own client: data-manager remembers per client that
    // it has created the ambient schema, which each test drops.
    const pg = { sql: undefined as unknown as postgres.Sql, connectionString: "" };
    beforeAll(async () => {
      database = await startPostgis();
      pg.connectionString = database.connectionString;
    }, 120_000);
    afterAll(async () => {
      await database?.stop();
    });
    beforeEach(async () => {
      await database.sql.unsafe(
        `DROP SCHEMA IF EXISTS ambient_places,osm_search,osm_search__staging,osm_search__previous,overture_places,overture_places__staging,overture_places__previous CASCADE`,
      );
      pg.sql = postgres(pg.connectionString, { max: 2 });
      // As in production and the fixture, drizzle replaces the client's serializers.
      drizzle(pg.sql);
    });
    afterEach(async () => {
      await pg.sql?.end({ timeout: 2 });
    });

    async function seedRegionalSearchIndex(epoch: string): Promise<void> {
      await pg.sql.unsafe(
        buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
      );
      await pg.sql.unsafe(
        `INSERT INTO osm_search.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,1,'aachen','fixture','fixture','fixture',$1,'ready',now(),now(),now())`,
        [epoch],
      );
      await pg.sql.unsafe(
        `INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES('node',1,'Clinic',ST_Point(6.08,50.77,4326),'amenity/hospital','{}',0.8)`,
      );
    }

    it("creates typed geometry, one partitioned feature store, checks and conventional names", async () => {
      await ensureAmbientSchema(pg.sql);
      expect(
        await pg.sql.unsafe(`SELECT singleton,schema_version FROM ambient_places.state`),
      ).toEqual([{ singleton: 1, schema_version: AMBIENT_SCHEMA_VERSION }]);
      expect(
        await pg.sql.unsafe(
          `SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='ambient_places.features'::regclass AND attname='geom'`,
        ),
      ).toEqual([{ type: "geometry(Geometry,3857)" }]);
      expect(
        await pg.sql.unsafe(`SELECT pg_get_partkeydef('ambient_places.features'::regclass) AS key`),
      ).toEqual([{ key: "LIST (generation)" }]);
      expect(
        await pg.sql.unsafe(
          `SELECT c.relname AS name,c.relkind AS kind FROM pg_class c WHERE c.relnamespace='ambient_places'::regnamespace AND c.relkind IN ('r','p') ORDER BY 1`,
        ),
      ).toEqual([
        { name: "features", kind: "p" },
        { name: "generations", kind: "r" },
        { name: "planet_builds", kind: "r" },
        { name: "state", kind: "r" },
      ]);
      expect(
        (
          await pg.sql.unsafe<{ name: string }[]>(
            `SELECT indexrelid::regclass::TEXT AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='ambient_places'::regnamespace ORDER BY 1`,
          )
        ).map((row) => row.name),
      ).toEqual([
        "ambient_places.features_geom_idx",
        "ambient_places.features_gers_id_idx",
        "ambient_places.features_pkey",
        "ambient_places.generations_pkey",
        "ambient_places.planet_builds_pkey",
        "ambient_places.state_pkey",
      ]);
      expect(
        (
          await pg.sql.unsafe<{ name: string }[]>(
            `SELECT conname AS name FROM pg_constraint WHERE connamespace='ambient_places'::regnamespace AND contype IN ('c','f') ORDER BY 1`,
          )
        ).map((row) => row.name),
      ).toEqual([
        "generations_publication_status_check",
        "generations_storage_check",
        "planet_builds_generation_fkey",
        "planet_builds_status_check",
        "state_active_fkey",
        "state_previous_fkey",
        "state_singleton_check",
      ]);
      const insert = (storage: string, status: string) =>
        pg.sql.unsafe(
          `INSERT INTO ambient_places.generations(id,manifest,storage,publication_status) VALUES($1,'{}',$2,$3)`,
          [GENERATION, storage, status],
        );
      await expect(insert("legacy", "published")).rejects.toThrow(/generations_storage_check/);
      await expect(insert("regional", "retired")).rejects.toThrow(
        /generations_publication_status_check/,
      );
      await insert("regional", "published");
      // A geometry in another projection does not fit the column.
      await expect(
        pg.sql.unsafe(
          `CREATE TABLE ambient_places.features_probe PARTITION OF ambient_places.features FOR VALUES IN ('${GENERATION}');
           INSERT INTO ambient_places.features(generation,id,name,category,rank,min_zoom,tenant,sources,geom)
           VALUES('${GENERATION}','osm:node/1','Clinic','hospital',1,13,false,'osm',ST_SetSRID(ST_MakePoint(6.08,50.77),4326))`,
        ),
      ).rejects.toThrow(/SRID/);
    }, 120_000);

    it("refuses a schema of another version or layout and names the remedy", async () => {
      const clients: postgres.Sql[] = [];
      const client = () => {
        const sql = postgres(pg.connectionString, { max: 1 });
        clients.push(sql);
        return sql;
      };
      try {
        await ensureAmbientSchema(pg.sql);
        // Another process finds the current version and creates nothing.
        await ensureAmbientSchema(client());
        await pg.sql.unsafe(`UPDATE ambient_places.state SET schema_version=999`);
        await expect(ensureAmbientSchema(client())).rejects.toThrow(
          `The ambient_places schema has version 999, but this data manager uses version ${AMBIENT_SCHEMA_VERSION}. Drop it with DROP SCHEMA ambient_places CASCADE and build nearby places again.`,
        );
        // A layout from before the version marker.
        await pg.sql.unsafe(`DROP SCHEMA ambient_places CASCADE;
          CREATE SCHEMA ambient_places;
          CREATE TABLE ambient_places.state(singleton SMALLINT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT true);
          INSERT INTO ambient_places.state VALUES(1,true)`);
        await expect(ensureAmbientSchema(client())).rejects.toThrow(
          /has no schema version.*DROP SCHEMA ambient_places CASCADE/,
        );
        // Tables without the state table are an unknown layout too.
        await pg.sql.unsafe(`DROP TABLE ambient_places.state;
          CREATE TABLE ambient_places.features(generation UUID NOT NULL)`);
        await expect(ensureAmbientSchema(client())).rejects.toThrow(/has no schema version/);
        // An empty schema, such as one an operator created, is filled in.
        await pg.sql.unsafe(`DROP TABLE ambient_places.features`);
        await ensureAmbientSchema(client());
        expect(await pg.sql.unsafe(`SELECT schema_version FROM ambient_places.state`)).toEqual([
          { schema_version: AMBIENT_SCHEMA_VERSION },
        ]);
      } finally {
        for (const sql of clients) await sql.end({ timeout: 2 });
      }
    }, 120_000);

    it("attaches and retires partitions without making readers of other generations wait", async () => {
      const reader = postgres(pg.connectionString, { max: 1 });
      const probe = postgres(pg.connectionString, { max: 1 });
      try {
        await seedRegionalSearchIndex("partitions");
        const a = await buildAmbientPlaces(pg.sql, region);
        const b = await buildAmbientPlaces(pg.sql, region);
        const c = await buildAmbientPlaces(pg.sql, region);
        const exists = async (generation: string) =>
          (
            await pg.sql.unsafe<{ exists: boolean }[]>(
              `SELECT to_regclass($1) IS NOT NULL AS exists`,
              [partition(generation)],
            )
          )[0]?.exists;
        const partitions = async () =>
          (
            await pg.sql.unsafe<{ name: string }[]>(
              `SELECT inhrelid::regclass::TEXT AS name FROM pg_inherits WHERE inhparent='ambient_places.features'::regclass ORDER BY 1`,
            )
          ).map((row) => row.name);
        expect(await partitions()).toEqual([a, b, c].map((m) => partition(m.generation)).sort());
        expect(
          await pg.sql.unsafe(
            `SELECT storage,publication_status FROM ambient_places.generations WHERE id=$1`,
            [a.generation],
          ),
        ).toEqual([{ storage: "regional", publication_status: "published" }]);
        // Reads the active generation without waiting longer than a
        // publication's lock timeout for a lock, however long another reader
        // holds the feature store. Only time spent waiting for a lock counts,
        // so a slow runner cannot trip it; a publication that locked the
        // feature store would queue the probe behind that reader.
        const probeActive = async () => {
          const [row] = await probe.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL lock_timeout='${PUBLICATION_LOCK_TIMEOUT_MS}ms'`);
            return tx.unsafe<{ n: number }[]>(
              `SELECT count(*)::INT AS n FROM ambient_places.features WHERE generation=(SELECT active FROM ambient_places.state)`,
            );
          });
          expect(row?.n).toBe(1);
        };
        const whileRunning = async (work: Promise<unknown>) => {
          let done = false;
          const finished = work.finally(() => {
            done = true;
          });
          let probes = 0;
          while (!done) {
            await probeActive();
            probes += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await finished;
          return probes;
        };

        // A reader of the active generation holds the parent for four seconds.
        await pg.sql.unsafe(
          `UPDATE ambient_places.generations SET cache_lease_until=now()-interval '1 second' WHERE id=$1`,
          [a.generation],
        );
        let reading!: () => void;
        const readingActive = new Promise<void>((resolve) => {
          reading = resolve;
        });
        const held = reader.begin(async (tx) => {
          await tx.unsafe(`SELECT count(*) FROM ambient_places.features WHERE generation=$1`, [
            c.generation,
          ]);
          reading();
          await tx.unsafe(`SELECT pg_sleep(4)`);
        });
        await readingActive;
        const startedD = performance.now();
        const d = buildAmbientPlaces(pg.sql, region, undefined, {
          cleanupRetry: { attempts: 10, backoffMs: 250 },
        });
        const firstProbes = await whileRunning(d);
        // Dropping the expired partition waited for the reader to finish.
        expect(performance.now() - startedD).toBeGreaterThan(3000);
        await held;
        expect(firstProbes).toBeGreaterThan(10);
        // The new generation is attached and the expired one is gone, table and all.
        const dManifest = await d;
        expect(await exists(dManifest.generation)).toBe(true);
        expect(await exists(a.generation)).toBe(false);
        expect(
          await pg.sql.unsafe(`SELECT id FROM ambient_places.generations WHERE id=$1`, [
            a.generation,
          ]),
        ).toEqual([]);

        // A backup-like reader holds every partition, the expired one included,
        // for longer than the retirement retries.
        await pg.sql.unsafe(
          `UPDATE ambient_places.generations SET cache_lease_until=now()-interval '1 second' WHERE id=$1`,
          [b.generation],
        );
        const bytes = await readAmbientTile(pg.sql, b.generation, tile.z, tile.x, tile.y);
        expect(bytes).not.toBeNull();
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let holding!: () => void;
        const holdingAll = new Promise<void>((resolve) => {
          holding = resolve;
        });
        const backup = reader.begin("isolation level repeatable read", async (tx) => {
          await tx.unsafe(`SELECT count(*) FROM ambient_places.features`);
          holding();
          await released;
        });
        await holdingAll;
        // With the default cleanup budget the job ends while the reader still
        // holds the feature store: the reader is released only after it.
        const e = buildAmbientPlaces(pg.sql, region);
        await whileRunning(e);
        // The publication succeeds; the retired generation is no longer
        // served, and its table waits for the reader to finish.
        const eManifest = await e;
        expect(await exists(eManifest.generation)).toBe(true);
        expect(await readAmbientTile(pg.sql, b.generation, tile.z, tile.x, tile.y)).toBeNull();
        expect(await exists(b.generation)).toBe(true);
        release();
        await backup;
        await buildAmbientPlaces(pg.sql, region);
        expect(await exists(b.generation)).toBe(false);
        expect(await partitions()).not.toContain(partition(b.generation));

        // Two cleanups at once: one does the work, the other leaves it to it,
        // and neither reports a failure.
        await pg.sql.unsafe(`DELETE FROM ambient_places.generations WHERE id=$1`, [c.generation]);
        const cleanups = postgres(pg.connectionString, { max: 2 });
        try {
          expect(
            await Promise.all([
              dropRetiredFeatureStorage(cleanups),
              dropRetiredFeatureStorage(cleanups),
            ]),
          ).toEqual([true, true]);
        } finally {
          await cleanups.end({ timeout: 2 });
        }
        expect(await exists(c.generation)).toBe(false);
      } finally {
        await reader.end({ timeout: 2 });
        await probe.end({ timeout: 2 });
      }
    }, 120_000);

    it("admits a planet build at once and leaves the retired partition for a later publication", async () => {
      const reader = postgres(pg.connectionString, { max: 1 });
      const probe = postgres(pg.connectionString, { max: 1 });
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(schema_version,region,source_path,source_fingerprint,current_fingerprint,source_file_identity,epoch,status,place_count,started_at,published_at,updated_at)
          VALUES(1,'planet','fixture','fixture','fixture','fixture-file','world','ready',2,now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES
          ('node',1,'Tokyo hospital',ST_Point(139.7,35.7,4326),'amenity/hospital','{}',0.8),('node',2,'Lagos hospital',ST_Point(3.39,6.45,4326),'amenity/hospital','{}',0.8)`);
        const build = (onClaim?: () => Promise<void>) =>
          buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, onClaim, {
            availableBytes,
            cleanupRetry: { attempts: 2, backoffMs: 100 },
          });
        const first = await build();
        await build();
        const active = await build();
        await pg.sql.unsafe(
          `UPDATE ambient_places.generations SET cache_lease_until=now()-interval '1 second' WHERE id=$1`,
          [first.generation],
        );
        const exists = async (generation: string) =>
          (
            await pg.sql.unsafe<{ exists: boolean }[]>(
              `SELECT to_regclass($1) IS NOT NULL AS exists`,
              [partition(generation)],
            )
          )[0]?.exists;

        // A reader of the active generation holds the feature store, as a
        // backup or a slow tile request would, until the build has ended.
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let holding!: () => void;
        const reading = new Promise<void>((resolve) => {
          holding = resolve;
        });
        const held = reader.begin("isolation level repeatable read", async (tx) => {
          await tx.unsafe(
            `SELECT count(*) FROM ${PUBLISHED_AMBIENT_FEATURES} f WHERE generation=$1`,
            [active.generation],
          );
          holding();
          await released;
        });
        await reading;
        try {
          // The admission answer comes before anything waits for a lock. A
          // build that retired the partition before answering would wait for
          // the reader and fail on its lock timeout, never answering.
          let waitingAtClaim: number | undefined;
          let done = false;
          const next = build(async () => {
            const [row] = await probe.unsafe<{ n: number }[]>(
              `SELECT count(*)::INT AS n FROM pg_locks WHERE NOT granted`,
            );
            waitingAtClaim = row?.n;
          }).finally(() => {
            done = true;
          });
          let probes = 0;
          while (!done) {
            // Only time spent waiting for a lock counts, so a slow runner
            // cannot trip this. A retirement that locks the whole feature
            // store queues the probe behind the reader past it.
            const [row] = await probe.begin(async (tx) => {
              await tx.unsafe(`SET LOCAL lock_timeout='${PUBLICATION_LOCK_TIMEOUT_MS}ms'`);
              return tx.unsafe<{ n: number }[]>(
                `SELECT count(*)::INT AS n FROM ${PUBLISHED_AMBIENT_FEATURES} f WHERE generation=$1`,
                [active.generation],
              );
            });
            expect(row?.n).toBe(2);
            probes += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const manifest = await next;
          expect(waitingAtClaim).toBe(0);
          expect(probes).toBeGreaterThan(0);
          expect(await exists(manifest.generation)).toBe(true);
          // The retired generation is gone from the catalogue of generations;
          // its table waits for the reader.
          expect(
            await pg.sql.unsafe(`SELECT id FROM ambient_places.generations WHERE id=$1`, [
              first.generation,
            ]),
          ).toEqual([]);
          expect(await exists(first.generation)).toBe(true);
        } finally {
          release();
          await held;
        }
        await build();
        expect(await exists(first.generation)).toBe(false);
      } finally {
        await reader.end({ timeout: 2 });
        await probe.end({ timeout: 2 });
      }
    }, 120_000);

    it.each([
      {
        source: "search index",
        live: "osm_search",
        // Read after the OSM places and before the links joined with them.
        gate: "overture_places.conflation_state",
        staging: buildSearchIndexSchemaDDL("osm_search__staging"),
        rows: `INSERT INTO osm_search__staging.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,1,'aachen','fixture','fixture','fixture','second','ready',now(),now(),now());
          INSERT INTO osm_search__staging.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES('node',2,'Bakery',ST_Point(6.0805,50.7702,4326),'shop/bakery','{}',0.6)`,
      },
      {
        source: "Overture release",
        live: "overture_places",
        // Read after the Overture places.
        gate: "overture_places.poi_conflation_link",
        staging: buildSchemaDDL("overture_places__staging"),
        rows: `INSERT INTO overture_places__staging.places(gers_id,name,geom,h3_r8,basic_category,confidence,operating_status,release) VALUES('gers-cafe','Cafe',ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),x'881f1d4887fffff'::BIGINT,'cafe',0.8,'open','2026-11-01.0');
          INSERT INTO overture_places__staging.conflation_state(schema_version,singleton,release,region,place_count,places_published_at,status,phase,sources_catalogue) VALUES(1,1,'2026-11-01.0','aachen',1,now(),'completed','complete','[{"sourceId":"overture","name":"Overture Maps"}]')`,
      },
    ])(
      "refuses to publish a regional build when the $source is republished while it reads",
      async ({ live, gate, staging, rows }) => {
        const gating = postgres(pg.connectionString, { max: 1 });
        const publisher = postgres(pg.connectionString, { max: 1 });
        try {
          await seedRegionalSearchIndex("first");
          await pg.sql.unsafe(buildSchemaDDL("overture_places"));
          await pg.sql.unsafe(`INSERT INTO overture_places.places(gers_id,name,geom,h3_r8,basic_category,confidence,operating_status,release) VALUES('gers-clinic','Clinic',ST_SetSRID(ST_MakePoint(6.08,50.77),4326),x'881f1d4887fffff'::BIGINT,'hospital',0.8,'open','2026-10-01.0');
            INSERT INTO overture_places.conflation_state(schema_version,singleton,release,region,place_count,places_published_at,status,phase,sources_catalogue) VALUES(1,1,'2026-10-01.0','aachen',1,now(),'completed','complete','[{"sourceId":"overture","name":"Overture Maps"}]');
            INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,match_confidence,distance_m,method,evidence,release) VALUES('node',1,'gers-clinic',1,0,'fixture','{}','2026-10-01.0')`);
          const good = await buildAmbientPlaces(pg.sql, region);
          await pg.sql.unsafe(`${staging}${rows}`);

          // The gate holds a table the build reads later, so the build stops
          // between two of its statements until the gate is released.
          let open!: () => void;
          const opened = new Promise<void>((resolve) => {
            open = resolve;
          });
          let closed!: () => void;
          const gateClosed = new Promise<void>((resolve) => {
            closed = resolve;
          });
          const gated = gating.begin(async (tx) => {
            await tx.unsafe(`LOCK TABLE ${gate} IN ACCESS EXCLUSIVE MODE`);
            closed();
            await opened;
          });
          await gateClosed;
          const build = buildAmbientPlaces(pg.sql, region);
          const outcome = build.then(
            () => "published",
            (error: Error) => error.message,
          );
          for (let waiting = false; !waiting; ) {
            const [row] = await publisher.unsafe<{ waiting: boolean }[]>(
              `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='relation' AND relation=to_regclass($1) AND NOT granted) AS waiting`,
              [gate],
            );
            waiting = row?.waiting === true;
            if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
          }
          // The swap commits while the build waits; it renames without
          // waiting for the build. Its old tables stay while the build reads.
          await publishSchemaSwap(publisher, {
            live,
            staging: `${live}__staging`,
            retry: { attempts: 1, backoffMs: 1 },
          });
          open();
          await gated;

          expect(await outcome).toMatch(
            /source data set was republished during the nearby-places build/,
          );
          expect((await readAmbientManifest(pg.sql))?.generation).toBe(good.generation);
          expect(
            await readAmbientTile(pg.sql, good.generation, tile.z, tile.x, tile.y),
          ).not.toBeNull();
          const [state] = await pg.sql.unsafe<{ error: string | null }[]>(
            `SELECT last_build_error AS error FROM ambient_places.state`,
          );
          expect(state?.error).toMatch(/republished/);
          const [generations] = await pg.sql.unsafe<{ n: number }[]>(
            `SELECT count(*)::INT AS n FROM ambient_places.generations`,
          );
          expect(generations?.n).toBe(1);
          // The next build reads one version of every source and publishes.
          const next = await buildAmbientPlaces(pg.sql, region);
          expect((await readAmbientManifest(pg.sql))?.generation).toBe(next.generation);
        } finally {
          await gating.end({ timeout: 2 });
          await publisher.end({ timeout: 2 });
        }
      },
      120_000,
    );

    /**
     * The API's readers must return the same places whatever data-manager's
     * storage layout is. The expected output was recorded from the readers
     * and builders before a storage change and must still match after it.
     */
    it("serve the recorded tiles and GERS places for regional and planet generations", async () => {
      await pg.sql.unsafe(
        buildSearchIndexSchemaDDL("osm_search") +
          buildSearchIndexIndexesDDL("osm_search") +
          buildSchemaDDL("overture_places"),
      );
      await pg.sql.unsafe(`INSERT INTO osm_search.index_state(schema_version,singleton,region,source_path,source_fingerprint,current_fingerprint,source_file_identity,epoch,status,place_count,started_at,published_at,updated_at)
        VALUES(1,1,'aachen','fixture','fixture','fixture','fixture-file','regional','ready',4,now(),now(),now());
        INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES
        ('node',1,'Klinik',ST_Point(6.08,50.77,4326),'amenity/hospital','{"name:en":"Clinic","name:de":"Klinik"}',0.8),
        ('node',2,'Bäckerei',ST_Point(6.0805,50.7702,4326),'shop/bakery','{}',0.6),
        ('way',9007199254740993,'Dom',ST_Point(6.0839,50.7748,4326),'amenity/place_of_worship','{"level":"1"}',0.9),
        ('node',3,'Closed',ST_Point(6.08,50.77,4326),'shop/bakery','{"disused":"yes"}',1);
        INSERT INTO overture_places.places(gers_id,name,names,geom,h3_r8,basic_category,confidence,operating_status,sources,release) VALUES
        ('gers-clinic','Clinic',NULL,ST_SetSRID(ST_MakePoint(6.08,50.77),4326),x'881f1d4887fffff'::BIGINT,'hospital',0.8,'open','[{"property":"/names/primary","dataset":"meta"}]','2026-10-01.0'),
        ('gers-cafe','Cafe','{"common":{"de":"Kaffee"}}',ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),x'881f1d4887fffff'::BIGINT,'cafe',0.8,'open','[{"property":"/names/common/de","dataset":"Microsoft"}]','2026-10-01.0');
        INSERT INTO overture_places.conflation_state(schema_version,singleton,release,region,place_count,places_published_at,status,phase,source_fingerprint,completed_at,sources_catalogue)
        VALUES(1,1,'2026-10-01.0','aachen',2,now(),'completed','complete','fixture-file',now(),'[{"sourceId":"overture","name":"Overture Maps"},{"sourceId":"meta-places","name":"Meta"},{"sourceId":"microsoft-places","name":"Microsoft"}]');
        INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,source_confidence,match_confidence,distance_m,method,evidence,release)
        VALUES('node',1,'gers-clinic',0.8,1,0,'fixture','{}','2026-10-01.0')`);
      await buildAmbientPlaces(pg.sql, {
        name: "Aachen",
        bounds: [5.9, 50.65, 6.3, 50.95],
      });
      // The cafe stays only in the regional generation, so its GERS lookup
      // falls back from the active planet generation to the regional one.
      await pg.sql.unsafe(`UPDATE osm_search.index_state SET region='planet',place_count=7,epoch='world';
        DELETE FROM overture_places.places WHERE gers_id='gers-cafe';
        UPDATE overture_places.conflation_state SET region='planet',place_count=2;
        INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES
        ('node',11,'病院 East',ST_Point(179.99999,0,4326),'amenity/hospital','{}',0.8),
        ('node',12,'病院 West',ST_Point(-179.99999,0,4326),'amenity/hospital','{}',0.8),
        ('way',13,'東京病院',ST_Point(139.7,35.7,4326),'amenity/hospital','{}',0.8);
        INSERT INTO overture_places.places(gers_id,name,basic_category,geom,h3_r8,confidence,operating_status,release) VALUES
        ('g-tokyo','Tokyo Clinic','hospital',ST_SetSRID(ST_MakePoint(139.7,35.7),4326),x'882f5a3247fffff'::BIGINT,0.9,'open','2026-10-01.0');
        INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,match_confidence,distance_m,method,evidence,release)
        VALUES('way',13,'g-tokyo',1,0,'fixture','{}','2026-10-01.0')`);
      const planet = await buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
        availableBytes,
      });
      const [regional] = await pg.sql.unsafe<{ id: string }[]>(
        `SELECT id FROM ambient_places.generations WHERE id<>$1`,
        [planet.generation],
      );
      if (!regional) throw new Error("The regional generation is missing");
      const tiles = {
        aachen: tileAt(16, 6.08, 50.77),
        aachenOverview: tileAt(13, 6.08, 50.77),
        dom: tileAt(18, 6.0839, 50.7748),
        tokyo: tileAt(16, 139.7, 35.7),
        dateWest: { z: 13, x: 0, y: 4096 },
        dateEast: { z: 13, x: 8191, y: 4096 },
      };
      const read = async (generation: string) =>
        Object.fromEntries(
          await Promise.all(
            Object.entries(tiles).map(async ([name, { z, x, y }]) => [
              name,
              decodeTile(await readAmbientTile(pg.sql, generation, z, x, y)),
            ]),
          ),
        );
      const gers = async (id: string) => {
        const found = await readAmbientPlaceByGers(pg.sql, id);
        if (!found) return null;
        const storage =
          found.generation === planet.generation
            ? "planet"
            : found.generation === regional.id
              ? "regional"
              : "unknown";
        return { storage, place: found.place };
      };
      const actual = digestLongStrings(
        JSON.parse(
          JSON.stringify({
            regional: await read(regional.id),
            planet: await read(planet.generation),
            gers: {
              clinic: await gers("gers-clinic"),
              cafe: await gers("gers-cafe"),
              tokyo: await gers("g-tokyo"),
              missing: await gers("gers-missing"),
            },
          }),
        ),
      );
      if (process.env.OPENMAPX_AMBIENT_READER_FIXTURE_PATH) {
        await writeFile(
          process.env.OPENMAPX_AMBIENT_READER_FIXTURE_PATH,
          `${JSON.stringify(actual, null, 2)}\n`,
        );
        return;
      }
      expect(actual).toEqual(JSON.parse(await readFile(EXPECTED_READER_OUTPUT, "utf8")));
    }, 120_000);
  },
);
