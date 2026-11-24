import { AMBIENT_PLANET_REGION } from "@openmapx/core/ambient-places";
import { PUBLISHED_AMBIENT_FEATURES } from "@openmapx/core/ambient-places-server";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { buildAmbientPlaces } from "../../src/jobs/ambient-places/build.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";

// Long enough not to trip on a loaded runner. A retirement that locks the
// whole feature store still fails this test: it holds the probes queued
// behind it past this, or it gives up on its one-second lock wait and fails
// the build.
const PROBE_TIMEOUT_MS = 1000;

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "planet retirement beside a long reader",
  () => {
    it("admits the build at once and leaves the retired partition for a later publication", async () => {
      const pg = await startPostgis();
      const reader = postgres(pg.connectionString, { max: 1 });
      const probe = postgres(pg.connectionString, { max: 1 });
      const availableBytes = async () => 1024 ** 4;
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(region,source_path,source_fingerprint,current_fingerprint,source_file_identity,epoch,status,place_count,started_at,published_at,updated_at)
          VALUES('planet','fixture','fixture','fixture','fixture-file','world','ready',2,now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,geom,category,tags,importance) VALUES
          ('node',1,'Tokyo hospital',ST_Point(139.7,35.7,4326),'amenity/hospital','{}',0.8),('node',2,'Lagos hospital',ST_Point(3.39,6.45,4326),'amenity/hospital','{}',0.8)`);
        const build = (onClaim?: () => void) =>
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
              [`ambient_places.features_${generation.replaceAll("-", "")}`],
            )
          )[0]?.exists;

        // A reader of the active generation holds the feature store, as a
        // backup or a slow tile request would.
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
          const started = performance.now();
          let claimedAfter: number | undefined;
          let done = false;
          const next = build(() => {
            claimedAfter = performance.now() - started;
          }).finally(() => {
            done = true;
          });
          const probes: number[] = [];
          while (!done) {
            const probeStarted = performance.now();
            const [row] = await probe.begin(async (tx) => {
              await tx.unsafe(`SET LOCAL statement_timeout='${PROBE_TIMEOUT_MS}ms'`);
              return tx.unsafe<{ n: number }[]>(
                `SELECT count(*)::INT AS n FROM ${PUBLISHED_AMBIENT_FEATURES} f WHERE generation=$1`,
                [active.generation],
              );
            });
            expect(row?.n).toBe(2);
            probes.push(performance.now() - probeStarted);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const manifest = await next;
          // The admission answer does not wait for the reader.
          expect(claimedAfter).toBeLessThan(2000);
          expect(probes.length).toBeGreaterThan(0);
          expect(Math.max(...probes)).toBeLessThan(PROBE_TIMEOUT_MS);
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
        await pg.stop();
      }
    }, 120_000);
  },
);
