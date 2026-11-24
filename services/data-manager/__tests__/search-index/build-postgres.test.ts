import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { assert, describe, expect, it } from "vitest";
import { buildOsmSearchIndex } from "../../src/jobs/search-index/build.js";
import type { SearchIndexRuntimeState } from "../../src/jobs/search-index/state.js";
import { StateStore } from "../../src/state.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

async function waitUntil(check: () => Promise<boolean>, label: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

/** A one-place search index build on a fresh database. */
function searchIndexFixture(pg: PostgisFixture, dataDir: string) {
  const pbfPath = join(dataDir, "fixture.osm.pbf");
  writeFileSync(pbfPath, "fixture");
  const store = new StateStore(dataDir);
  store.upsert({
    type: "osm-pbf",
    id: "europe/germany",
    region: "europe/germany",
    path: pbfPath,
    sizeBytes: 7,
    downloadedAt: new Date().toISOString(),
  });
  const runtimeState: SearchIndexRuntimeState = { building: false, failure: null };
  const build = (name: string, onProgress?: (stage: string) => void) =>
    buildOsmSearchIndex({
      region: "europe/germany",
      dataDir,
      store,
      sql: pg.sql,
      runtimeState,
      onProgress: (progress) => onProgress?.(progress.stage),
      dependencies: {
        // Outlasts a 12-second reader without the production pauses.
        publicationRetry: { attempts: 10, backoffMs: 250 },
        extract: async ({ onBatch }) => {
          await onBatch([
            {
              osmType: "node",
              osmId: "1",
              name,
              lat: 52.52,
              lng: 13.4,
              category: "place:city",
              tags: { name },
              importance: 0.9,
              terms: [],
            },
          ]);
          return { emitted: 1, extracted: 1 };
        },
      },
    });
  return { runtimeState, build };
}

describe.skipIf(skipE2e)("search-index publication beside a long reader", () => {
  it("serves searches from the new snapshot while a backup-like reader holds the old one", async () => {
    const pg = await startPostgis();
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-search-reader-"));
    const reader = postgres(pg.connectionString, { max: 1 });
    // The build's lock and transaction take both of the fixture's connections.
    const probe = postgres(pg.connectionString, { max: 1 });
    // The API's integration pool ends a statement after 5 seconds.
    const search = postgres(pg.connectionString, {
      max: 1,
      connection: { statement_timeout: 5000 },
    });
    let holder: postgres.ReservedSql | undefined;
    try {
      const { build } = searchIndexFixture(pg, dataDir);
      const findName = () =>
        search<{ name: string }[]>`SELECT name FROM osm_search.places WHERE osm_id = ${1}`;

      await build("Old Name");
      // A prepared statement planned against the old tables re-resolves its names.
      expect(await findName()).toEqual([{ name: "Old Name" }]);

      // Like pg_dump, the reader holds its lock on the live tables until its
      // transaction ends.
      holder = await reader.reserve();
      await holder.unsafe(`BEGIN ISOLATION LEVEL REPEATABLE READ`);
      expect(await holder.unsafe(`SELECT count(*)::TEXT AS count FROM osm_search.places`)).toEqual([
        { count: "1" },
      ]);

      let publishing = false;
      const second = build("New Name", (stage) => {
        if (stage === "publish") publishing = true;
      });
      second.catch(() => undefined);
      await waitUntil(async () => {
        if (!publishing) return false;
        const [state] = await probe.unsafe<{ waiting: boolean; staged: boolean }[]>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted) AS waiting,
                  to_regnamespace('osm_search__staging') IS NOT NULL AS staged`,
        );
        return Boolean(state?.waiting) || !state?.staged;
      }, "the publication to swap or wait for a lock");
      const swappedAt = Date.now();

      const startedAt = Date.now();
      expect(await findName()).toEqual([{ name: "New Name" }]);
      expect(Date.now() - startedAt).toBeLessThan(5000);

      // The reader holds the old tables for 12 seconds.
      await sleep(Math.max(0, swappedAt + 12_000 - Date.now()));
      await holder.unsafe(`COMMIT`);
      await second;
      const [previous] = await pg.sql.unsafe<{ exists: boolean }[]>(
        `SELECT to_regnamespace('osm_search__previous') IS NOT NULL AS exists`,
      );
      expect(previous?.exists).toBe(false);
    } finally {
      holder?.release();
      await reader.end({ timeout: 2 });
      await probe.end({ timeout: 2 });
      await search.end({ timeout: 2 });
      await pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("reports a publication as done when only dropping the old schema fails", async () => {
    const pg = await startPostgis();
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-search-drop-"));
    try {
      const { runtimeState, build } = searchIndexFixture(pg, dataDir);
      await build("Old Name");
      // Any error other than a lock timeout, raised while the old schema is dropped.
      await pg.sql.unsafe(`
        CREATE FUNCTION public.refuse_previous_drop() RETURNS event_trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_event_trigger_dropped_objects()
                      WHERE object_type = 'schema' AND object_name = 'osm_search__previous') THEN
            RAISE EXCEPTION 'injected drop failure';
          END IF;
        END $$;
        CREATE EVENT TRIGGER refuse_previous_drop ON sql_drop
          EXECUTE FUNCTION public.refuse_previous_drop();
      `);

      await expect(build("New Name")).resolves.toMatchObject({ placeCount: 1 });
      const [state] = await pg.sql.unsafe<{ status: string; last_error: string | null }[]>(
        `SELECT status, last_error FROM osm_search.index_state`,
      );
      expect(state).toEqual({ status: "ready", last_error: null });
      expect(runtimeState.failure).toBeNull();
      const [kept] = await pg.sql.unsafe<{ name: string }[]>(
        `SELECT name FROM osm_search__previous.places`,
      );
      expect(kept?.name).toBe("Old Name");

      // The next publication drops the leftover before it swaps.
      await pg.sql.unsafe(`DROP EVENT TRIGGER refuse_previous_drop`);
      await build("Newest Name");
      const [after] = await pg.sql.unsafe<{ previous: boolean; name: string }[]>(
        `SELECT to_regnamespace('osm_search__previous') IS NOT NULL AS previous,
                (SELECT name FROM osm_search.places) AS name`,
      );
      expect(after).toEqual({ previous: false, name: "Newest Name" });
    } finally {
      await pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe.skipIf(skipE2e)("atomic search-index publication", () => {
  it("publishes a complete snapshot and preserves it after a later failure", async () => {
    const pg = await startPostgis();
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-search-index-"));
    try {
      const pbfPath = join(dataDir, "fixture.osm.pbf");
      writeFileSync(pbfPath, "fixture");
      const store = new StateStore(dataDir);
      store.upsert({
        type: "osm-pbf",
        id: "europe/germany",
        region: "europe/germany",
        path: pbfPath,
        sizeBytes: 7,
        downloadedAt: new Date().toISOString(),
        sha256: "fixture-sha",
      });
      const runtimeState = { building: false, failure: null };
      const result = await buildOsmSearchIndex({
        region: "europe/germany",
        dataDir,
        store,
        sql: pg.sql,
        runtimeState,
        dependencies: {
          extract: async ({ onBatch }) => {
            await onBatch([
              {
                osmType: "node",
                osmId: "1",
                name: "Berlin Brandenburg Airport",
                lat: 52.36,
                lng: 13.5,
                category: "aeroway:aerodrome",
                tags: { name: "Berlin Brandenburg Airport", iata: "BER" },
                importance: 0.9,
                terms: [
                  {
                    normalizedTerm: "ber",
                    displayValue: "BER",
                    kind: "authoritative_code",
                    namespace: "iata",
                  },
                ],
              },
            ]);
            return { emitted: 1, extracted: 1 };
          },
        },
      });
      expect(result).toEqual(expect.objectContaining({ placeCount: 1, termCount: 1 }));
      const [published] = await pg.sql.unsafe<{ epoch: string; status: string }[]>(
        `SELECT epoch, status FROM osm_search.index_state`,
      );
      expect(published).toEqual({ epoch: result.epoch, status: "ready" });

      const queryLive = () =>
        pg.sql.unsafe<{ name: string; display_value: string; namespace: string }[]>(`
          SELECT p.name, t.display_value, t.namespace
          FROM osm_search.terms t JOIN osm_search.places p USING (osm_type, osm_id)
          WHERE t.normalized_term = 'ber' AND t.kind = 'authoritative_code'
          ORDER BY p.osm_type, p.osm_id
        `);
      const baseline = await queryLive();
      expect(baseline).toEqual([
        { name: "Berlin Brandenburg Airport", display_value: "BER", namespace: "iata" },
      ]);

      for (const stage of ["extract", "insert", "index", "validate"] as const) {
        await expect(
          buildOsmSearchIndex({
            region: "europe/germany",
            dataDir,
            store,
            sql: pg.sql,
            runtimeState,
            dependencies: {
              extract: async ({ onBatch }) => {
                if (stage === "extract") throw new Error("injected extraction failure");
                await onBatch([
                  {
                    osmType: "node",
                    osmId: "2",
                    name: "Replacement Airport",
                    lat: stage === "insert" ? 100 : 52.36,
                    lng: 13.5,
                    category: "aeroway:aerodrome",
                    tags: { name: "Replacement Airport", iata: "NEW" },
                    importance: 0.9,
                    terms: [
                      {
                        normalizedTerm: "new",
                        displayValue: "NEW",
                        kind: "authoritative_code",
                        namespace: "iata",
                      },
                    ],
                  },
                ]);
                return { emitted: 1, extracted: 1 };
              },
            },
            onCheckpoint: async () => {
              if (stage === "index") {
                // A real duplicate-name failure in production's index DDL.
                await pg.sql.unsafe(
                  `CREATE INDEX idx_osm_search_terms_exact ON osm_search__staging.terms (normalized_term)`,
                );
              }
              if (stage === "validate") {
                // Extraction/insertion succeeds, but the staged snapshot is incomplete.
                await pg.sql.unsafe(`DELETE FROM osm_search__staging.terms`);
              }
            },
          }),
        ).rejects.toThrow(new RegExp(`\\[${stage}\\]`));
        const [stillLive] = await pg.sql.unsafe<
          { epoch: string; status: string; last_error: string }[]
        >(`SELECT epoch, status, last_error FROM osm_search.index_state`);
        assert.isDefined(stillLive);
        expect(stillLive.epoch).toBe(result.epoch);
        expect(stillLive.status).toBe("ready");
        expect(stillLive.last_error).toContain(`[${stage}]`);
        expect(runtimeState.building).toBe(false);
        expect(runtimeState.failure).toEqual(
          expect.objectContaining({
            region: "europe/germany",
            error: expect.stringContaining(`[${stage}]`),
          }),
        );
        expect(await queryLive()).toEqual(baseline);
        const [staging] = await pg.sql.unsafe<{ exists: boolean }[]>(
          `SELECT to_regnamespace('osm_search__staging') IS NOT NULL AS exists`,
        );
        expect(staging?.exists).toBe(false);
      }
    } finally {
      await pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});

it.skipIf(skipE2e)(
  "keeps zero-term native POIs and refuses a changed PBF before publication",
  async () => {
    const pg = await startPostgis();
    const dir = mkdtempSync(join(tmpdir(), "global-source-"));
    try {
      const path = join(dir, "planet.osm.pbf");
      writeFileSync(path, "original");
      const store = new StateStore(dir);
      store.upsert({
        type: "osm-pbf",
        id: "planet",
        region: "planet",
        path,
        sizeBytes: 8,
        downloadedAt: new Date().toISOString(),
      });
      const runtimeState = { building: false, failure: null };
      const opts = { region: "planet", dataDir: dir, store, sql: pg.sql, runtimeState };
      const emit = async (
        onBatch: (
          records: import("../../src/jobs/search-index/extract.js").SearchPlaceRecord[],
        ) => Promise<void>,
      ) => {
        await onBatch([
          {
            osmType: "node",
            osmId: "1",
            name: "喫茶店",
            lat: 35.7,
            lng: 139.7,
            category: "amenity/cafe",
            tags: { name: "喫茶店", amenity: "cafe" },
            importance: 0.5,
            terms: [],
          },
        ]);
        return { emitted: 1, extracted: 1 };
      };
      const first = await buildOsmSearchIndex({
        ...opts,
        dependencies: { extract: async ({ onBatch }) => emit(onBatch) },
      });
      expect(first).toMatchObject({ placeCount: 1, termCount: 0 });
      const [row] = await pg.sql.unsafe(
        `SELECT to_jsonb(s) AS state FROM osm_search.index_state s`,
      );
      expect(row?.state.source_file_identity).toEqual(expect.any(String));
      await expect(
        buildOsmSearchIndex({
          ...opts,
          dependencies: {
            extract: async ({ onBatch }) => {
              const result = await emit(onBatch);
              const replacement = join(dir, "replacement.pbf");
              writeFileSync(replacement, "replaced");
              renameSync(replacement, path);
              return result;
            },
          },
        }),
      ).rejects.toThrow(/source.*changed/i);
      const [retained] = await pg.sql.unsafe(`SELECT epoch FROM osm_search.index_state`);
      expect(retained?.epoch).toBe(first.epoch);
    } finally {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60000,
);
