import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { VectorTile } from "@mapbox/vector-tile";
import { AMBIENT_PLANET_REGION } from "@openmapx/core/ambient-places";
import { readAmbientPlaceByGers, readAmbientTile } from "@openmapx/core/ambient-places-server";
import { PbfReader } from "pbf";
import { describe, expect, it } from "vitest";
import { buildAmbientPlaces } from "../../src/jobs/ambient-places/build.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";

const EXPECTED = new URL("./reader-fixture.expected.json", import.meta.url);

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

/**
 * The API's readers must return the same places whatever data-manager's
 * storage layout is. The expected output was recorded from the readers and
 * builders before a storage change and must still match after it.
 */
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "ambient readers on a fixed fixture",
  () => {
    it("serve the recorded tiles and GERS places for regional and planet generations", async () => {
      const pg = await startPostgis();
      const availableBytes = async () => 1024 ** 4;
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") +
            buildSearchIndexIndexesDDL("osm_search") +
            buildSchemaDDL("overture_places"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,source_file_identity,epoch,status,place_count,started_at,published_at,updated_at)
          VALUES(1,'aachen','fixture','fixture','fixture','fixture-file','regional','ready',4,now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES
          ('node',1,'Klinik',ST_Point(6.08,50.77,4326),'amenity/hospital','{"name:en":"Clinic","name:de":"Klinik"}',0.8),
          ('node',2,'Bäckerei',ST_Point(6.0805,50.7702,4326),'shop/bakery','{}',0.6),
          ('way',9007199254740993,'Dom',ST_Point(6.0839,50.7748,4326),'amenity/place_of_worship','{"level":"1"}',0.9),
          ('node',3,'Closed',ST_Point(6.08,50.77,4326),'shop/bakery','{"disused":"yes"}',1);
          INSERT INTO overture_places.places(gers_id,name,names,geom,h3_r8,basic_category,confidence,operating_status,sources,release) VALUES
          ('gers-clinic','Clinic',NULL,ST_SetSRID(ST_MakePoint(6.08,50.77),4326),x'881f1d4887fffff'::BIGINT,'hospital',0.8,'open','[{"property":"/names/primary","dataset":"meta"}]','2026-10-01.0'),
          ('gers-cafe','Cafe','{"common":{"de":"Kaffee"}}',ST_SetSRID(ST_MakePoint(6.081,50.7701),4326),x'881f1d4887fffff'::BIGINT,'cafe',0.8,'open','[{"property":"/names/common/de","dataset":"Microsoft"}]','2026-10-01.0');
          INSERT INTO overture_places.conflation_state(singleton,release,region,place_count,places_published_at,status,phase,source_fingerprint,completed_at,sources_catalogue)
          VALUES(1,'2026-10-01.0','aachen',2,now(),'completed','complete','fixture-file',now(),'[{"sourceId":"overture","name":"Overture Maps"},{"sourceId":"meta-places","name":"Meta"},{"sourceId":"microsoft-places","name":"Microsoft"}]');
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
        expect(actual).toEqual(JSON.parse(await readFile(EXPECTED, "utf8")));
      } finally {
        await pg.stop();
      }
    }, 120_000);
  },
);
