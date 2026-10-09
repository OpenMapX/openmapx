import { VectorTile } from "@mapbox/vector-tile";
import { AMBIENT_PLANET_REGION } from "@openmapx/core/ambient-places";
import { readAmbientPlaceByGers, readAmbientTile } from "@openmapx/core/ambient-places-server";
import Fastify from "fastify";
import { PbfReader } from "pbf";
import { describe, expect, it } from "vitest";
import { registerAmbientPlacesApi } from "../../src/jobs/ambient-places/api.js";
import { buildAmbientPlaces, resumePlanetPlaces } from "../../src/jobs/ambient-places/build.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")("global ambient serving", () => {
  it("hides interrupted candidates and serves native IDs on both sides of the dateline", async () => {
    const pg = await startPostgis();
    const availableBytes = async () => 1024 ** 4;
    try {
      await pg.sql.unsafe(
        buildSearchIndexSchemaDDL("osm_search") +
          buildSearchIndexIndexesDDL("osm_search") +
          buildSchemaDDL("overture_places"),
      );
      await pg.sql.unsafe(`INSERT INTO osm_search.index_state(region,source_path,source_fingerprint,current_fingerprint,source_file_identity,epoch,status,place_count,started_at,published_at,updated_at)
        VALUES('planet','fixture','fixture','fixture','fixture-file','world','ready',4,now(),now(),now());
        INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES
        ('node',1,'病院 East',0,179.99999,'amenity/hospital','{}',0.8),('node',2,'病院 West',0,-179.99999,'amenity/hospital','{}',0.8),
        ('node',3,'Polar hospital',86,0,'amenity/hospital','{}',0.8),('way',9007199254740993,'東京病院',35.7,139.7,'amenity/hospital','{}',0.8);
        INSERT INTO overture_places.places(gers_id,name,basic_category,geom,confidence,operating_status,release) VALUES
        ('g-tokyo','Tokyo Clinic','hospital',ST_SetSRID(ST_MakePoint(139.7,35.7),4326),0.9,'open','2026-09-23.1');
        INSERT INTO overture_places.conflation_state(release,region,place_count,places_published_at,status,phase,source_fingerprint,completed_at)
        VALUES('2026-09-23.1','planet',1,now(),'completed','complete','fixture-file',now());
        INSERT INTO overture_places.poi_conflation_link(osm_type,osm_id,gers_id,match_confidence,distance_m,method,evidence,release)
        VALUES('way',9007199254740993,'g-tokyo',1,0,'fixture','{}','2026-09-23.1')`);
      await expect(
        buildAmbientPlaces(pg.sql, AMBIENT_PLANET_REGION, undefined, {
          availableBytes,
          onProgress: () => {
            throw new Error("stop");
          },
        }),
      ).rejects.toThrow("stop");
      const [stage] = await pg.sql.unsafe("SELECT generation FROM ambient_places.planet_builds");
      const restarted = Fastify();
      registerAmbientPlacesApi(restarted, pg.sql);
      try {
        const response = await restarted.inject("/ambient-places/status");
        expect(response.json()).toMatchObject({
          active: null,
          building: false,
          progress: { processed: 4, placeCount: 3 },
          candidate: { generation: stage.generation, status: "failed" },
        });
      } finally {
        await restarted.close();
      }
      expect(await readAmbientTile(pg.sql, stage.generation, 13, 0, 4096)).toBeNull();
      expect(await readAmbientPlaceByGers(pg.sql, "g-tokyo")).toBeNull();
      const manifest = await resumePlanetPlaces(pg.sql, stage.generation, undefined, {
        availableBytes,
      });
      expect(manifest.placeCount).toBe(3);
      const resolved = await readAmbientPlaceByGers(pg.sql, "g-tokyo");
      expect(resolved).toMatchObject({
        generation: manifest.generation,
        place: { id: "osm:way/9007199254740993", name: "東京病院" },
      });
      expect(resolved?.place.coordinates[0]).toBeCloseTo(139.7, 7);
      expect(resolved?.place.coordinates[1]).toBeCloseTo(35.7, 7);
      for (const x of [0, 8191]) {
        const bytes = await readAmbientTile(pg.sql, manifest.generation, 13, x, 4096);
        const layer = new VectorTile(new PbfReader(bytes!)).layers.ambient_places;
        expect(layer.length).toBe(2);
        const features = Array.from({ length: layer.length }, (_, i) => layer.feature(i));
        expect(features.map((f) => f.properties.id).sort()).toEqual(["osm:node/1", "osm:node/2"]);
        expect(features.map((f) => f.properties.name)).toEqual(
          expect.arrayContaining(["病院 East", "病院 West"]),
        );
        for (const f of features) expect(f.loadGeometry()[0][0].x).toBeGreaterThanOrEqual(-64);
        expect(bytes!.length).toBeLessThanOrEqual(128 * 1024);
      }
    } finally {
      await pg.stop();
    }
  }, 120000);
});
