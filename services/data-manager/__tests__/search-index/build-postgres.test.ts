import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOsmSearchIndex } from "../../src/jobs/search-index/build.js";
import { StateStore } from "../../src/state.js";
import { startPostgis } from "../poi-ingest/_testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

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
        expect(staging.exists).toBe(false);
      }
    } finally {
      await pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
