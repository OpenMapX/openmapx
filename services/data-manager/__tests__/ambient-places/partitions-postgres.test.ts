import { readAmbientTile } from "@openmapx/core/ambient-places-server";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { buildAmbientPlaces } from "../../src/jobs/ambient-places/build.js";
import { PUBLICATION_LOCK_TIMEOUT_MS } from "../../src/jobs/publish-schema-swap.js";
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

function partition(generation: string): string {
  return `ambient_places.features_${generation.replaceAll("-", "")}`;
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "ambient feature partitions",
  () => {
    it("attaches and retires partitions without making readers of other generations wait", async () => {
      const pg = await startPostgis();
      const reader = postgres(pg.connectionString, { max: 1 });
      const probe = postgres(pg.connectionString, { max: 1 });
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,'aachen','fixture','fixture','fixture','partitions','ready',now(),now(),now());
          INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES('node',1,'Clinic',50.77,6.08,'amenity/hospital','{}',0.8)`);
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
        // Reads the active generation within the lock timeout, however long
        // another reader holds the feature store.
        const probeActive = async () => {
          const started = performance.now();
          const [row] = await probe.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL statement_timeout='${PUBLICATION_LOCK_TIMEOUT_MS}ms'`);
            return tx.unsafe<{ n: number }[]>(
              `SELECT count(*)::INT AS n FROM ambient_places.features WHERE generation=(SELECT active FROM ambient_places.state)`,
            );
          });
          expect(row?.n).toBe(1);
          return performance.now() - started;
        };
        const whileRunning = async (work: Promise<unknown>) => {
          let done = false;
          const finished = work.finally(() => {
            done = true;
          });
          const probes: number[] = [];
          while (!done) {
            probes.push(await probeActive());
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
          lockRetry: { attempts: 10, backoffMs: 250 },
        });
        const firstProbes = await whileRunning(d);
        // Dropping the expired partition waited for the reader to finish.
        expect(performance.now() - startedD).toBeGreaterThan(3000);
        await held;
        expect(firstProbes.length).toBeGreaterThan(10);
        expect(Math.max(...firstProbes)).toBeLessThan(PUBLICATION_LOCK_TIMEOUT_MS);
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
        const e = buildAmbientPlaces(pg.sql, region, undefined, {
          lockRetry: { attempts: 2, backoffMs: 100 },
        });
        const secondProbes = await whileRunning(e);
        expect(Math.max(...secondProbes)).toBeLessThan(PUBLICATION_LOCK_TIMEOUT_MS);
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
      } finally {
        await reader.end({ timeout: 2 });
        await probe.end({ timeout: 2 });
        await pg.stop();
      }
    }, 120_000);
  },
);
